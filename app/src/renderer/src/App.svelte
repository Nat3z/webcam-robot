<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  type Device = { id: string; label: string }
  type StreamStatus = 'disconnected' | 'connecting' | 'live' | 'offline'
  type SelectState = {
    devices: Device[]
    selected: string | null
    running?: boolean
    viewers?: number
  }

  let userStreamUrl = $state('http://192.168.0.140:3000')
  let status = $state<StreamStatus>('disconnected')
  let devices = $state<Device[]>([])
  let selectedDeviceId = $state<string | null>(null)

  let videoEl = $state<HTMLVideoElement | null>(null)
  let mediaStream = $state<MediaStream | null>(null)
  let pc: RTCPeerConnection | null = null
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  let refreshInterval: ReturnType<typeof setInterval> | null = null
  let refreshInFlight = false
  // Bumped on every connect attempt; an in-flight negotiation that finishes
  // after a newer one starts is ignored via this counter.
  let connectGeneration = 0

  const selectedValue = $derived(selectedDeviceId ?? 'none')

  async function playVideo(): Promise<void> {
    if (!videoEl || !mediaStream) return
    try {
      await videoEl.play()
    } catch (err) {
      console.error('video playback failed', err)
    }
  }

  // Whenever the video element or stream change, re-attach the WebRTC stream.
  // This handles both orderings: ontrack before <video> mounts and vice versa.
  $effect(() => {
    if (videoEl && mediaStream) {
      videoEl.srcObject = mediaStream
      void playVideo()
    } else if (videoEl) {
      videoEl.srcObject = null
    }
  })

  function tearDown(invalidatePending = true): void {
    if (invalidatePending) {
      connectGeneration += 1
    }
    if (pc) {
      try {
        pc.close()
      } catch {
        // already closed
      }
      pc = null
    }
    mediaStream = null
  }

  function scheduleReconnect(): void {
    if (reconnectTimeout) return
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null
      void connect()
    }, 750)
  }

  function normalizeBaseUrl(url: string): string {
    return url.trim().replace(/\/+$/, '')
  }

  async function waitForIceComplete(p: RTCPeerConnection): Promise<void> {
    if (p.iceGatheringState === 'complete') return
    await new Promise<void>((resolve) => {
      const onChange = (): void => {
        if (p.iceGatheringState === 'complete') {
          p.removeEventListener('icegatheringstatechange', onChange)
          resolve()
        }
      }
      p.addEventListener('icegatheringstatechange', onChange)
    })
  }

  async function connect(): Promise<void> {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    if (!selectedDeviceId) {
      tearDown()
      status = 'disconnected'
      return
    }

    const myGen = ++connectGeneration
    tearDown(false)
    status = 'connecting'

    const local = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    })
    pc = local

    local.addTransceiver('video', { direction: 'recvonly' })

    local.ontrack = (event) => {
      if (myGen !== connectGeneration) return
      if (event.track.kind !== 'video') return

      mediaStream = event.streams[0] ?? new MediaStream([event.track])
      event.track.onended = () => {
        if (myGen !== connectGeneration) return
        status = 'offline'
        scheduleReconnect()
      }
      void playVideo()
    }

    local.onconnectionstatechange = () => {
      if (myGen !== connectGeneration) return
      const state = local.connectionState
      if (state === 'connected') {
        status = 'live'
      } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        status = 'offline'
        scheduleReconnect()
      }
    }

    try {
      const offer = await local.createOffer()
      await local.setLocalDescription(offer)
      await waitForIceComplete(local)

      const res = await fetch(`${normalizeBaseUrl(userStreamUrl)}/webrtc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer: local.localDescription })
      })
      if (myGen !== connectGeneration) return

      const data = await res.json()
      if (!res.ok || data.success === false || !data.answer) {
        throw new Error(data.error ?? `negotiation failed (${res.status})`)
      }
      await local.setRemoteDescription(data.answer)
    } catch (err) {
      if (myGen !== connectGeneration) return
      console.error('webrtc negotiation failed', err)
      status = 'offline'
      scheduleReconnect()
    }
  }

  async function fetchServerState(): Promise<SelectState> {
    const res = await fetch(`${normalizeBaseUrl(userStreamUrl)}/select`)
    const data = (await res.json()) as Partial<SelectState>
    if (!res.ok) {
      throw new Error(`state refresh failed (${res.status})`)
    }
    return {
      devices: data.devices ?? [],
      selected: data.selected ?? null,
      running: data.running,
      viewers: data.viewers
    }
  }

  async function refreshServerState(forceReconnect = false): Promise<void> {
    if (refreshInFlight) return
    refreshInFlight = true
    try {
      const data = await fetchServerState()
      const previousSelectedDeviceId = selectedDeviceId
      devices = data.devices
      selectedDeviceId = data.selected

      if (!selectedDeviceId) {
        tearDown()
        status = 'disconnected'
        return
      }

      const selectionChanged = previousSelectedDeviceId !== selectedDeviceId
      const connectionIsGone =
        !pc ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'closed'

      if (forceReconnect || selectionChanged || connectionIsGone) {
        await connect()
      }
    } catch (err) {
      console.error('failed to refresh server state', err)
      status = 'offline'
    } finally {
      refreshInFlight = false
    }
  }

  async function selectDevice(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement
    const nextDeviceId = select.value === 'none' ? null : select.value
    if (nextDeviceId === selectedDeviceId) return

    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    status = nextDeviceId ? 'connecting' : 'disconnected'

    try {
      const res = await fetch(`${normalizeBaseUrl(userStreamUrl)}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: nextDeviceId })
      })
      const data = await res.json()
      if (!res.ok || data.success === false) {
        throw new Error(data.error ?? 'Failed to select device')
      }
      selectedDeviceId = data.selected as string | null
      if (selectedDeviceId) {
        await connect()
      } else {
        tearDown()
        status = 'disconnected'
      }
    } catch (err) {
      console.error('error selecting device', err)
      status = 'offline'
    }
  }

  async function onUrlCommit(): Promise<void> {
    userStreamUrl = normalizeBaseUrl(userStreamUrl)
    devices = []
    selectedDeviceId = null
    tearDown()
    status = 'disconnected'
    await refreshServerState(true)
  }

  function reconnect(): void {
    void connect()
  }

  function onVideoPlaying(): void {
    if (selectedDeviceId && pc?.connectionState === 'connected') {
      status = 'live'
    }
  }

  function onVideoInterrupted(): void {
    if (!selectedDeviceId || status === 'connecting') return
    status = 'offline'
    scheduleReconnect()
  }

  onMount(() => {
    void refreshServerState(true)
    refreshInterval = setInterval(() => {
      void refreshServerState()
    }, 1500)
  })

  onDestroy(() => {
    if (reconnectTimeout) clearTimeout(reconnectTimeout)
    if (refreshInterval) clearInterval(refreshInterval)
    tearDown()
  })
</script>

<main class="camera-page">
  <div class="frame">
    {#if selectedDeviceId}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        autoplay
        muted
        playsinline
        class="camera-feed"
        onplaying={onVideoPlaying}
        onstalled={onVideoInterrupted}
        onsuspend={onVideoInterrupted}
        onerror={onVideoInterrupted}
      ></video>
    {:else}
      <div class="empty-state">Select a camera to start streaming</div>
    {/if}
  </div>

  <div class="toolbar">
    <span class={`status ${status}`}>{status}</span>
    <input
      type="text"
      style="width: 30%;"
      bind:value={userStreamUrl}
      onblur={onUrlCommit}
      onkeydown={(e) => e.key === 'Enter' && onUrlCommit()}
    />
    <select onchange={selectDevice} value={selectedValue}>
      {#each [{ label: '-- none selected --', id: 'none' }, ...devices] as device (device.id)}
        <option value={device.id}>{device.label}</option>
      {/each}
    </select>
    <button type="button" onclick={reconnect}>
      {status === 'connecting' ? 'Connecting...' : 'Reconnect'}
    </button>
  </div>
</main>

<style>
  .camera-page {
    width: 100vw;
    height: 100vh;
  }

  .frame {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 90%;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    background: #000;
    border: 1px solid var(--ev-c-gray-2);
    video {
      width: 100%;
      height: auto;
      object-fit: contain;
      display: block;
    }
  }

  .camera-feed {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .empty-state {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--ev-c-text-2);
    font-size: 14px;
  }

  .toolbar {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 80%;
    margin: 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .status {
    text-transform: capitalize;
    font-size: 14px;
    color: var(--ev-c-text-2);
  }

  .status.live {
    color: #3ddc97;
  }

  .status.connecting {
    color: #f0dc4e;
  }

  .status.disconnected {
    color: #8a8f98;
  }

  .status.offline {
    color: #ff7a7a;
  }

  button {
    border: 1px solid var(--ev-c-gray-2);
    color: var(--ev-c-text-1);
    background: var(--ev-c-gray-3);
    border-radius: 999px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    padding: 10px 14px;
    cursor: pointer;
  }

  button:hover {
    background: var(--ev-c-gray-2);
  }
</style>
