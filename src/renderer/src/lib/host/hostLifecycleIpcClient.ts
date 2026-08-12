import {
  cloneHostLifecycleSnapshot,
  isHostLifecycleActionResult,
  isHostLifecycleSnapshot,
  isHostLifecycleStatusResult,
  type HostLifecycleAction,
  type HostLifecycleActionRequest,
  type HostLifecycleActionResult,
  type HostLifecycleSnapshot,
  type HostLifecycleStatusResult
} from '../../../../shared/hostLifecycle'

export interface HostLifecycleBridge {
  hostLifecycleStatus(): Promise<HostLifecycleStatusResult>
  hostLifecycleSet(request: HostLifecycleActionRequest): Promise<HostLifecycleActionResult>
  onHostLifecycleChanged(listener: (snapshot: HostLifecycleSnapshot) => void): () => void
}

function resolveBridge(): HostLifecycleBridge {
  if (typeof window === 'undefined') {
    throw new Error('Host lifecycle bridge is unavailable outside TaskWraith Desktop.')
  }
  const candidate = (window as unknown as { api?: Partial<HostLifecycleBridge> }).api
  if (
    !candidate ||
    typeof candidate.hostLifecycleStatus !== 'function' ||
    typeof candidate.hostLifecycleSet !== 'function' ||
    typeof candidate.onHostLifecycleChanged !== 'function'
  ) {
    throw new Error('Host lifecycle bridge is unavailable.')
  }
  return candidate as HostLifecycleBridge
}

/** Thin, validating renderer client over the preload lifecycle conduit. */
export class HostLifecycleIpcClient {
  constructor(private readonly injectedBridge?: HostLifecycleBridge) {}

  async status(): Promise<HostLifecycleSnapshot> {
    const result = await this.bridge().hostLifecycleStatus()
    if (!isHostLifecycleStatusResult(result)) {
      throw new Error('Host lifecycle status response was malformed.')
    }
    if (!result.ok) throw new Error(result.error)
    return cloneHostLifecycleSnapshot(result.snapshot)
  }

  async set(action: HostLifecycleAction): Promise<HostLifecycleActionResult> {
    const result = await this.bridge().hostLifecycleSet({ action })
    if (!isHostLifecycleActionResult(result)) {
      throw new Error('Host lifecycle action response was malformed.')
    }
    if (result.ok) {
      return { ok: true, snapshot: cloneHostLifecycleSnapshot(result.snapshot) }
    }
    return {
      ok: false,
      error: result.error,
      ...(result.snapshot ? { snapshot: cloneHostLifecycleSnapshot(result.snapshot) } : {})
    }
  }

  subscribe(listener: (snapshot: HostLifecycleSnapshot) => void): () => void {
    let bridge: HostLifecycleBridge
    try {
      bridge = this.bridge()
    } catch {
      return () => undefined
    }
    return bridge.onHostLifecycleChanged((snapshot) => {
      if (isHostLifecycleSnapshot(snapshot)) {
        listener(cloneHostLifecycleSnapshot(snapshot))
      }
    })
  }

  private bridge(): HostLifecycleBridge {
    return this.injectedBridge ?? resolveBridge()
  }
}
