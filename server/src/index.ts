import { Elysia, t } from "elysia";
import { spawn, type Subprocess } from "bun";
import { readdir, readFile, realpath } from "node:fs/promises";
import { platform } from "node:os";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RTCRtpCodecParameters,
} from "werift";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FPS = Number(process.env.FPS ?? 30);
const WIDTH = Number(process.env.WIDTH ?? 1280);
const HEIGHT = Number(process.env.HEIGHT ?? 720);
const PORT = Number(process.env.PORT ?? 3000);
// Target H.264 bitrate. 2 Mbps is enough for 720p webcam content; bump for
// higher resolutions or drop on bandwidth-constrained links.
const BITRATE = process.env.BITRATE ?? "2M";
const MAXRATE = process.env.MAXRATE ?? BITRATE;
// Keep the encoder's VBV small. Big buffers smooth bitrate spikes but add
// delay; for a robot camera, fresh frames matter more than perfect rate shape.
const BUFSIZE = process.env.BUFSIZE ?? "300k";
const RTP_PORT = Number(process.env.RTP_PORT ?? 5004);
// Pin the RTP SSRC so a camera switch (which restarts ffmpeg) doesn't surprise
// werift's sender with a brand-new source identifier.
const RTP_SSRC = 0xc0c0a;
const PAYLOAD_TYPE = 96;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// H.264 Constrained Baseline 3.1 + packetization-mode=1 — the universally
// supported WebRTC profile. Every browser will accept this answer.
const H264_CODEC = new RTCRtpCodecParameters({
  mimeType: "video/H264",
  clockRate: 90000,
  payloadType: PAYLOAD_TYPE,
  rtcpFeedback: [
    { type: "nack" },
    { type: "nack", parameter: "pli" },
    { type: "goog-remb" },
  ],
  parameters:
    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
});

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

// ---------------------------------------------------------------------------
// Camera platform abstraction
// ---------------------------------------------------------------------------

type CameraDevice = {
  id: string;
  label: string;
};

type CameraPlatform = {
  name: string;
  listDevices(): Promise<CameraDevice[]>;
  ffmpegInputArgs(deviceId: string): string[];
  ffmpegEncoderArgs(): string[];
};

const macosPlatform: CameraPlatform = {
  name: "macOS (AVFoundation)",
  async listDevices() {
    const proc = spawn({
      cmd: ["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    const devices: CameraDevice[] = [];
    let inVideoSection = false;
    for (const line of stderr.split("\n")) {
      if (line.includes("AVFoundation video devices:")) {
        inVideoSection = true;
        continue;
      }
      if (line.includes("AVFoundation audio devices:")) {
        inVideoSection = false;
        continue;
      }
      if (!inVideoSection) continue;
      const match = line.match(/\[(\d+)\]\s+(.+)$/);
      if (match) devices.push({ id: match[1]!, label: match[2]!.trim() });
    }
    return devices;
  },
  ffmpegInputArgs(deviceId) {
    return [
      "-f", "avfoundation",
      "-framerate", String(FPS),
      "-video_size", `${WIDTH}x${HEIGHT}`,
      "-pixel_format", process.env.PIXEL_FORMAT ?? "nv12",
      "-thread_queue_size", "8",
      "-i", deviceId,
    ];
  },
  ffmpegEncoderArgs() {
    // VideoToolbox encodes on the Apple Silicon GPU/ANE — zero CPU cost.
    return [
      "-c:v", "h264_videotoolbox",
      "-realtime", "1",
      "-profile:v", "baseline",
      "-pix_fmt", "yuv420p",
      "-b:v", BITRATE,
      "-g", String(FPS), // keyframe every ~1s
      "-bf", "0",         // B-frames add latency; disable for live
    ];
  },
};

const linuxPlatform: CameraPlatform = {
  name: "Linux (V4L2)",
  async listDevices() {
    let names: string[] = [];
    try {
      names = (await readdir("/dev"))
        .filter((name) => /^video\d+$/.test(name))
        .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    } catch {
      return [];
    }
    const devices: CameraDevice[] = [];
    for (const name of names) {
      try {
        const devicePath = await realpath(`/sys/class/video4linux/${name}/device`);
        if (!devicePath.includes("/usb")) continue;
        let label = `/dev/${name}`;
        try {
          label = (await readFile(`/sys/class/video4linux/${name}/name`, "utf8")).trim();
        } catch {}
        devices.push({ id: `/dev/${name}`, label });
      } catch {}
    }
    return devices;
  },
  ffmpegInputArgs(deviceId) {
    return [
      "-f", "v4l2",
      // USB webcams expose MJPEG natively. ffmpeg decodes MJPEG → YUV420 on the
      // Pi's CPU (cheap), then hands frames to the hardware H.264 encoder.
      "-input_format", process.env.LINUX_INPUT_FORMAT ?? "mjpeg",
      "-framerate", String(FPS),
      "-video_size", `${WIDTH}x${HEIGHT}`,
      // Drop old frames instead of letting ffmpeg build a capture backlog.
      "-rtbufsize", process.env.RTBUF_SIZE ?? "512k",
      "-use_wallclock_as_timestamps", "1",
      "-thread_queue_size", process.env.THREAD_QUEUE_SIZE ?? "1",
      "-i", deviceId,
    ];
  },
  ffmpegEncoderArgs() {
    // h264_v4l2m2m runs on the Pi's GPU encoder — zero CPU. Constrained
    // Baseline keeps it browser-compatible over WebRTC.
    return [
      "-c:v", "h264_v4l2m2m",
      "-pix_fmt", "yuv420p",
      "-b:v", BITRATE,
      "-maxrate", MAXRATE,
      "-bufsize", BUFSIZE,
      // Frequent keyframes reduce recovery time after packet loss/camera
      // switches without materially increasing latency at robot bitrates.
      "-g", String(Math.max(1, Math.round(FPS / 2))),
      "-bf", "0",
    ];
  },
};

function pickPlatform(): CameraPlatform {
  const p = platform();
  if (p === "darwin") return macosPlatform;
  if (p === "linux") return linuxPlatform;
  throw new Error(`Unsupported platform: ${p}. Only macOS and Linux are supported right now.`);
}

const camPlatform = pickPlatform();
console.log(`Detected ${camPlatform.name}`);

const devices = await camPlatform.listDevices();
if (devices.length === 0) {
  console.warn("No webcam devices found. Ensure a USB webcam is connected.");
}

let selectedDeviceId: string | undefined = undefined;

const getSelectState = () => ({
  devices: devices.map((d) => ({ id: d.id, label: d.label })),
  selected: selectedDeviceId ?? null,
  running: hub.isRunning(),
  viewers: hub.viewerCount(),
});

// ---------------------------------------------------------------------------
// WebRTC hub
//
// One ffmpeg process feeds H.264/RTP into a UDP socket on localhost. A single
// shared MediaStreamTrack is fed every RTP packet that arrives on that socket.
// Every viewer gets their own RTCPeerConnection, but they all share the same
// source track — werift's senders rewrite SSRC/seq/timestamp per-peer, so we
// pay the encode cost exactly once regardless of viewer count.
// ---------------------------------------------------------------------------

class WebRTCHub {
  private ffmpeg: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private socket: DgramSocket | null = null;
  private track: MediaStreamTrack | null = null;
  private peers = new Set<RTCPeerConnection>();

  isRunning(): boolean {
    return this.ffmpeg !== null;
  }

  viewerCount(): number {
    return this.peers.size;
  }

  private async ensureSource(): Promise<void> {
    if (!selectedDeviceId) throw new Error("No camera selected");

    if (!this.track) {
      this.track = new MediaStreamTrack({ kind: "video", codec: H264_CODEC });
    }

    if (!this.socket) {
      const sock = createSocket("udp4");
      sock.on("message", (msg) => {
        try {
          this.track?.writeRtp(msg);
        } catch {
          // Stray non-RTP packet on the port; ignore.
        }
      });
      sock.on("error", (err) => console.error("RTP socket error:", err));
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error) => reject(err);
        sock.once("error", onErr);
        sock.once("listening", () => {
          sock.removeListener("error", onErr);
          resolve();
        });
        sock.bind(RTP_PORT, "127.0.0.1");
      });
      this.socket = sock;
    }

    if (!this.ffmpeg) {
      this.spawnFfmpeg();
    }
  }

  private spawnFfmpeg(): void {
    if (!selectedDeviceId) return;
    const inputArgs = camPlatform.ffmpegInputArgs(selectedDeviceId);
    const encoderArgs = camPlatform.ffmpegEncoderArgs();
    console.log(
      `▶️  ffmpeg → H.264/RTP (device ${selectedDeviceId}, ${WIDTH}x${HEIGHT}@${FPS}fps, ${BITRATE})`,
    );

    this.ffmpeg = spawn({
      cmd: [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        // Skip probe/analysis so capture starts instantly.
        "-probesize", "32",
        "-analyzeduration", "0",
        "-fflags", "nobuffer",
        "-avioflags", "direct",
        "-flags", "low_delay",
        ...inputArgs,
        "-an",
        ...encoderArgs,
        "-fps_mode", "passthrough",
        "-payload_type", String(PAYLOAD_TYPE),
        "-ssrc", String(RTP_SSRC),
        "-flush_packets", "1",
        "-muxdelay", "0",
        "-muxpreload", "0",
        "-f", "rtp",
        // pkt_size=1200 keeps every packet under the typical 1500-byte MTU,
        // avoiding IP fragmentation that hurts jitter and packet loss recovery.
        `rtp://127.0.0.1:${RTP_PORT}?pkt_size=1200`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const activeProc = this.ffmpeg;

    activeProc.stderr
      .pipeTo(
        new WritableStream({
          write: (chunk) => {
            process.stderr.write(chunk);
          },
        }),
      )
      .catch(() => {});

    void activeProc.exited.then((code) => {
      if (this.ffmpeg !== activeProc) return; // superseded by a restart
      this.ffmpeg = null;
      if (this.peers.size > 0) {
        console.error(`ffmpeg exited (${code ?? "?"}); tearing down ${this.peers.size} peer(s)`);
        this.stop("ffmpeg exited");
      }
    });
  }

  private teardownSource(): void {
    if (this.ffmpeg) {
      try { this.ffmpeg.kill(); } catch {}
      this.ffmpeg = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
    if (this.track) {
      try { this.track.stop(); } catch {}
      this.track = null;
    }
  }

  async addPeer(
    offer: { type: "offer"; sdp: string },
  ): Promise<{ type: "answer"; sdp: string }> {
    await this.ensureSource();

    const pc = new RTCPeerConnection({
      codecs: { video: [H264_CODEC] },
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pc.addTrack(this.track!);

    const cleanup = (reason: string): void => {
      if (!this.peers.has(pc)) return;
      this.peers.delete(pc);
      try { pc.close(); } catch {}
      console.log(`👋 peer ${reason} (${this.peers.size} remaining)`);
      if (this.peers.size === 0) {
        this.teardownSource();
      }
    };

    pc.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed" || state === "disconnected") {
        cleanup(state);
      }
    });

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Non-trickle ICE: bake every candidate into the answer SDP so the client
    // negotiates in a single HTTP round-trip.
    if (pc.iceGatheringState !== "complete") {
      await pc.iceGatheringStateChange.watch((state) => state === "complete");
    }

    this.peers.add(pc);
    console.log(`🤝 peer connected (${this.peers.size} total)`);

    const local = pc.localDescription!;
    return { type: "answer", sdp: local.sdp };
  }

  // Camera switch: kill ffmpeg, keep peers + socket + track. The new ffmpeg
  // pumps fresh RTP into the same pipeline; werift rebases timestamps via
  // onSourceChanged so viewers see a brief stall, not a disconnect.
  restartIfRunning(): void {
    if (!this.ffmpeg) return;
    console.log("🔄 restarting ffmpeg for camera switch");
    try { this.ffmpeg.kill(); } catch {}
    this.ffmpeg = null;
    if (selectedDeviceId) this.spawnFfmpeg();
  }

  stop(reason: string): void {
    if (this.peers.size === 0 && !this.ffmpeg && !this.socket) return;
    console.log(`⏹  hub stop (${reason})`);
    for (const pc of this.peers) {
      try { pc.close(); } catch {}
    }
    this.peers.clear();
    this.teardownSource();
  }
}

const hub = new WebRTCHub();

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = new Elysia()
  .get("/", () => "Hello Webcam Robot")
  .options("/select", () => new Response(null, { headers: CORS_HEADERS }))
  .options("/webrtc", () => new Response(null, { headers: CORS_HEADERS }))
  .get("/select", () => jsonResponse(getSelectState()))
  .post(
    "/select",
    ({ body }) => {
      const { deviceId } = body;
      const nextDeviceId = deviceId === null || deviceId === "none" ? undefined : deviceId;
      if (nextDeviceId !== undefined && !devices.some((d) => d.id === nextDeviceId)) {
        return jsonResponse(
          { success: false, error: "Device not found" },
          { status: 404 },
        );
      }
      if (selectedDeviceId === nextDeviceId) {
        return jsonResponse({ success: true, ...getSelectState() });
      }
      selectedDeviceId = nextDeviceId;
      if (selectedDeviceId) {
        console.log(`Selected device: ${selectedDeviceId}`);
        hub.restartIfRunning();
      } else {
        console.log("Cleared selected device");
        hub.stop("selection cleared");
      }
      return jsonResponse({ success: true, ...getSelectState() });
    },
    {
      body: t.Object({
        deviceId: t.Nullable(t.String()),
      }),
    },
  )
  .post(
    "/webrtc",
    async ({ body }) => {
      if (!selectedDeviceId) {
        return jsonResponse(
          { success: false, error: "No camera selected", ...getSelectState() },
          { status: 409 },
        );
      }
      try {
        const answer = await hub.addPeer(body.offer);
        return jsonResponse({ success: true, answer });
      } catch (err) {
        console.error("WebRTC negotiation failed:", err);
        return jsonResponse(
          { success: false, error: (err as Error).message },
          { status: 500 },
        );
      }
    },
    {
      body: t.Object({
        offer: t.Object({
          type: t.Literal("offer"),
          sdp: t.String(),
        }),
      }),
    },
  )
  .listen(PORT);

console.log(`🦊 WebRTC signaling → http://localhost:${app.server?.port}/webrtc`);

const shutdown = (): void => {
  console.log("\nShutting down…");
  hub.stop("server shutdown");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
