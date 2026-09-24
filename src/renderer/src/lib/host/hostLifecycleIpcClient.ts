import {
  cloneHostLifecycleSnapshot,
  isHostLifecycleActionResult,
  isHostLifecycleInspectResult,
  isHostLifecycleSnapshot,
  isHostLifecycleStatusResult,
  type HostLifecycleAction,
  type HostLifecycleActionRequest,
  type HostLifecycleActionResult,
  type HostLifecycleInspectResult,
  type HostLifecycleLeaseProjection,
  type HostLifecycleSnapshot,
  type HostLifecycleStatusResult
} from '../../../../shared/hostLifecycle'
import {
  decodeHostStatusProjection,
  type HostStatusProjection
} from '../../../../shared/hostProtocol'

export interface HostLifecycleBridge {
  hostLifecycleStatus(): Promise<HostLifecycleStatusResult>
  hostLifecycleSet(request: HostLifecycleActionRequest): Promise<HostLifecycleActionResult>
  onHostLifecycleChanged(listener: (snapshot: HostLifecycleSnapshot) => void): () => void
  /**
   * Optional on purpose: a preload that predates the inspect channel still
   * serves status, set and subscribe, and only `inspect()` reports it missing.
   */
  hostLifecycleInspect?(): Promise<HostLifecycleInspectResult>
}

/**
 * A successful inspect, detached from the bridge's objects: the lifecycle
 * snapshot, the Host's own live `host.status` (null when it could not be read)
 * and this app's lease (null when the app holds none).
 */
export interface HostLifecycleInspection {
  readonly snapshot: HostLifecycleSnapshot
  readonly host: HostStatusProjection | null
  readonly lease: HostLifecycleLeaseProjection | null
}

function detachInspection(
  result: Extract<HostLifecycleInspectResult, { ok: true }>
): HostLifecycleInspection {
  // The guard already proved the status decodes; decoding again returns a
  // fresh object graph with any unknown key dropped.
  const host = result.host === null ? null : decodeHostStatusProjection(result.host)
  return {
    snapshot: cloneHostLifecycleSnapshot(result.snapshot),
    host: host?.ok ? host.value : null,
    lease:
      result.lease === null
        ? null
        : { mode: result.lease.mode, held: result.lease.held, reasons: [...result.lease.reasons] }
  }
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

  /**
   * Ask main for the lifecycle snapshot, the Host's live `host.status` and
   * this app's lease in one answer. Rejects when the preload has no inspect
   * channel, and on a denied or malformed answer, exactly like `status()`.
   */
  async inspect(): Promise<HostLifecycleInspection> {
    const bridge = this.bridge()
    if (typeof bridge.hostLifecycleInspect !== 'function') {
      throw new Error('Host inspect is unavailable in this build.')
    }
    const result = await bridge.hostLifecycleInspect()
    if (!isHostLifecycleInspectResult(result)) {
      throw new Error('Host lifecycle inspect response was malformed.')
    }
    if (!result.ok) throw new Error(result.error)
    return detachInspection(result)
  }

  /** Sends exactly `{ action }`: `start`, `stop` or `restart`. */
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
