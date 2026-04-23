import { Elysia, t } from "elysia";
import { spawn, type Subprocess } from "bun";
import { readdir } from "node:fs/promises";
import { platform } from "node:os";

const FPS = Number(process.env.FPS ?? 30);
const WIDTH = Number(process.env.WIDTH ?? 1280);
const HEIGHT = Number(process.env.HEIGHT ?? 720);
const PORT = Number(process.env.PORT ?? 3000);
// MJPEG quality: 2 (best) – 31 (worst). Lower numbers = bigger frames and more
// encode time; higher = smaller frames and lower bandwidth. 5 is visually
// indistinguishable from source for most webcams.
const QUALITY = Number(process.env.QUALITY ?? 5);
const BOUNDARY = "ffserver";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type CameraDevice = {
  id: string;
  label: string;
};

type CameraPlatform = {
  name: string;
  listDevices(): Promise<CameraDevice[]>;
  ffmpegInputArgs(deviceId: string): string[];
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
    // AVFoundation cameras commonly don't support ffmpeg's default yuv420p.
    // nv12 is supported by the FaceTime HD Camera and most USB webcams; ffmpeg
    // will transcode to MJPEG for us.
    return [
      "-f", "avfoundation",
      "-framerate", String(FPS),
      "-video_size", `${WIDTH}x${HEIGHT}`,
      "-pixel_format", process.env.PIXEL_FORMAT ?? "nv12",
      "-i", deviceId,
    ];
  },
};

const linuxPlatform: CameraPlatform = {
  name: "Linux (V4L2)",
  async listDevices() {
    // Enumerate /dev/video* entries. On a Raspberry Pi there are often several
    // virtual nodes (metadata, ISP, etc.); we still list them all and let the
    // user pick the one that actually produces video.
    let entries: string[] = [];
    try {
      entries = (await readdir("/dev"))
        .filter((name) => /^video\d+$/.test(name))
        .sort((a, b) => {
          const an = Number(a.replace("video", ""));
          const bn = Number(b.replace("video", ""));
          return an - bn;
        });
    } catch {
      return [];
    }
    return entries.map((name) => ({ id: `/dev/${name}`, label: `/dev/${name}` }));
  },
  ffmpegInputArgs(deviceId) {
    return [
      "-f", "v4l2",
      "-framerate", String(FPS),
      "-video_size", `${WIDTH}x${HEIGHT}`,
      "-i", deviceId,
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
  console.error(
    "No video devices found. Ensure a webcam is connected, ffmpeg is installed, and the process has camera permissions.",
  );
  process.exit(1);
}

let selectedDeviceId: string | undefined = undefined;

const getSelectState = () => ({
  devices: devices.map((d) => ({ id: d.id, label: d.label })),
  selected: selectedDeviceId ?? null,
  running: hub.isRunning(),
  viewers: hub.viewerCount(),
});

// Fanout hub: ffmpeg runs only while there is at least one subscriber, so the
// camera LED turns off when nobody is watching. Each subscriber receives the
// raw mpjpeg stream directly from ffmpeg's stdout.
class CameraHub {
  private listeners = new Set<(chunk: Uint8Array | null) => void>();
  private ffmpeg: Subprocess<"ignore", "pipe", "pipe"> | null = null;

  private closeAllListeners(): void {
    for (const fn of this.listeners) {
      try {
        fn(null);
      } catch {
        // stream already gone
      }
    }
    this.listeners.clear();
  }

  subscribe(onChunk: (chunk: Uint8Array | null) => void): () => void {
    this.listeners.add(onChunk);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(onChunk);
      if (this.listeners.size === 0) this.stop("no more subscribers");
    };
  }

  public start(): void {
    if (this.ffmpeg) return;
    if (!selectedDeviceId) {
      console.error("No device selected");
      return;
    }
    const inputArgs = camPlatform.ffmpegInputArgs(selectedDeviceId);
    console.log(`▶️  Starting ffmpeg (device ${selectedDeviceId}, ${WIDTH}x${HEIGHT} @ ${FPS}fps, q=${QUALITY})`);
    this.ffmpeg = spawn({
      cmd: [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        // Skip format probing/analysis so the stream starts almost instantly.
        "-probesize", "32",
        "-analyzeduration", "0",
        // Don't buffer frames waiting for (non-existent) audio sync.
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        ...inputArgs,
        "-an",
        // Cap output to the requested FPS so AVFoundation/V4L2 can't firehose
        // a backlog of frames at startup (which freezes the client decoder).
        "-fps_mode", "cfr",
        "-r", String(FPS),
        "-f", "mpjpeg",
        "-boundary_tag", BOUNDARY,
        "-q:v", String(QUALITY),
        // Flush each encoded packet to stdout immediately instead of batching.
        "-flush_packets", "1",
        "pipe:1",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const activeProc = this.ffmpeg;

    activeProc.stderr.pipeTo(
      new WritableStream({
        write: (chunk) => {
          process.stderr.write(chunk);
        },
      }),
    ).catch(() => {});

    void activeProc.exited.then((code) => {
      // Ignore stale completion from an older process after a restart.
      if (this.ffmpeg !== activeProc) return;
      this.ffmpeg = null;
      if (this.listeners.size > 0) {
        console.error(`ffmpeg exited unexpectedly (code ${code ?? "unknown"}), closing active streams`);
        this.closeAllListeners();
      }
    });

    void (async () => {
      const reader = activeProc.stdout.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          for (const fn of this.listeners) {
            try {
              fn(value);
            } catch {
              // subscriber disappeared mid-iteration; its unsubscribe will clean up
            }
          }
        }
      } catch (err) {
        console.error("ffmpeg read loop failed:", err);
      }
    })();
  }

  public stop(reason = "manual stop"): void {
    if (!this.ffmpeg) return;
    console.log(`⏹  Stopping ffmpeg (${reason})`);
    // Gracefully end all current HTTP chunked streams before killing ffmpeg to
    // avoid clients seeing abrupt truncated multipart responses.
    this.closeAllListeners();
    try {
      this.ffmpeg.kill();
    } catch {}
    this.ffmpeg = null;
  }

  public restartIfRunning(): void {
    if (!this.ffmpeg) return;
    this.stop("switching device");
    this.start();
  }

  public isRunning(): boolean {
    return this.ffmpeg !== null;
  }

  public viewerCount(): number {
    return this.listeners.size;
  }
}

const hub = new CameraHub();

const app = new Elysia()
  .get("/", () => "Hello Webcam Robot")
  .options("/select", () => new Response(null, { headers: CORS_HEADERS }))
  .options("/camera", () => new Response(null, { headers: CORS_HEADERS }))
  .get('/select', () => {
    return new Response(JSON.stringify(getSelectState()), {
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    })
  })
  .post('/select', ({ body }) => {
    const { deviceId } = body;
    const nextDeviceId = deviceId === null || deviceId === "none" ? undefined : deviceId;
    if (nextDeviceId !== undefined && !devices.some((d) => d.id === nextDeviceId)) {
      return new Response(JSON.stringify({
        success: false,
        error: "Device not found",
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }
    if (selectedDeviceId === nextDeviceId) {
      return new Response(JSON.stringify({
        success: true,
        ...getSelectState(),
      }), {
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }
    selectedDeviceId = nextDeviceId;
    if (selectedDeviceId) {
      console.log(`Selected device: ${selectedDeviceId}`);
      hub.restartIfRunning();
    } else {
      console.log("Cleared selected device");
      hub.stop("selection cleared");
    }
    return new Response(JSON.stringify({
      success: true,
      ...getSelectState(),
    }), {
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }, {
    body: t.Object({
      deviceId: t.Nullable(t.String()),
    })
  })
  .get("/camera", () => {
    if (!selectedDeviceId) {
      return new Response(JSON.stringify({
        success: false,
        error: "No camera selected",
        ...getSelectState(),
      }), {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    }

    let unsubscribe: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        unsubscribe = hub.subscribe((chunk) => {
          if (chunk === null) {
            try {
              controller.close();
            } catch {
              // already closed
            }
            unsubscribe?.();
            unsubscribe = null;
            return;
          }
          try {
            controller.enqueue(chunk);
          } catch {
            unsubscribe?.();
            unsubscribe = null;
          }
        });
      },
      cancel() {
        unsubscribe?.();
        unsubscribe = null;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS,
      },
    });
  })
  .listen(PORT);

console.log(`🦊 Camera stream → http://localhost:${app.server?.port}/camera`);

const shutdown = (): void => {
  console.log("\nShutting down…");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
