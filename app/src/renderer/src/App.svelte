<script lang="ts">
  import { onMount } from 'svelte'

  type Device = { id: string; label: string }
  type StreamStatus = 'disconnected' | 'connecting' | 'live' | 'offline'

  const baseCameraUrl = 'http://localhost:3000'
  let userStreamUrl = $state(baseCameraUrl)
  let status: StreamStatus = $state('disconnected')
  let devices = $state<Device[]>([])
  let selectedDeviceId = $state<string | null>(null)
  let reconnectToken = $state(0)
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null

  const streamUrl = $derived(
    selectedDeviceId ? `${userStreamUrl}/camera?device=${selectedDeviceId}&t=${reconnectToken}` : ''
  )

  const selectedValue = $derived(selectedDeviceId ?? 'none')

  function reconnect(): void {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    if (!selectedDeviceId) {
      status = 'disconnected'
      return
    }
    reconnectToken += 1
    status = 'connecting'
  }

  async function refreshServerState(): Promise<void> {
    const res = await fetch(`${baseCameraUrl}/select`)
    const data = await res.json()
    devices = data.devices as Device[]
    selectedDeviceId = data.selected as string | null
    if (!selectedDeviceId) {
      status = 'disconnected'
      return
    }
    status = data.running ? 'connecting' : 'offline'
    reconnectToken += 1
  }

  async function selectDevice(event: Event): Promise<void> {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    const select = event.target as HTMLSelectElement
    const nextDeviceId = select.value === 'none' ? null : select.value
    if (nextDeviceId === selectedDeviceId) {
      return
    }
    status = nextDeviceId ? 'connecting' : 'disconnected'
    try {
      const res = await fetch(`${baseCameraUrl}/select`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ deviceId: nextDeviceId })
      })
      const data = await res.json()
      if (!res.ok || data.success === false) {
        throw new Error(data.error ?? 'Failed to select device')
      }
      selectedDeviceId = data.selected as string | null
      if (!selectedDeviceId) {
        status = 'disconnected'
        return
      }
      reconnectToken += 1
    } catch (err) {
      console.error('error selecting device', err)
      status = 'offline'
    }
  }

  onMount(() => {
    void refreshServerState()
    return () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
      }
    }
  })

  function onStreamLoaded(): void {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    status = 'live'
  }

  function onStreamError(): void {
    if (!selectedDeviceId) {
      status = 'disconnected'
      return
    }
    status = 'offline'
    if (reconnectTimeout) return
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null
      reconnect()
    }, 350)
  }
</script>

<main class="camera-page">
  <div class="frame">
    {#if selectedDeviceId}
      <img
        src={streamUrl}
        alt="Camera stream"
        class="camera-feed"
        onload={onStreamLoaded}
        onerror={onStreamError}
      />
    {:else}
      <div class="empty-state">Select a camera to start streaming</div>
    {/if}
  </div>

  <div class="toolbar">
    <span class={`status ${status}`}>{status}</span>
    <input type="text" style="width: 30%;" bind:value={userStreamUrl} />
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

  .title {
    font-size: 28px;
    line-height: 1.2;
    font-weight: 700;
  }

  .subtitle {
    margin-top: 8px;
    color: var(--ev-c-text-2);
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
    img {
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
