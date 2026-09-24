/**
 * Narrow result contract for a Host command execution port. Runtime mutation
 * observation accepts this injected shape without importing the main-only
 * BridgeAction executor adapter that produces it in desktop composition.
 */
import type { HostResultRef } from '../shared/hostProtocol'

export type HostCommandExecutionResult = {
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly resultSummary?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  /** Strict opaque locator returned only by a successful setup execution. */
  readonly resultRef?: HostResultRef
}
