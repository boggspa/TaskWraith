/**
 * Shared fan-out isolation contract used by the renderer and main process.
 * Keeping the normalizer here prevents either process from importing the
 * other process's store types at runtime.
 */

export type EnsembleFanoutIsolation = 'off' | 'worktree'
export type EnsembleFanoutIsolationPolicy = EnsembleFanoutIsolation | 'any'

/** Normalize a persisted/IPC value to the effective chat-level policy. */
export function resolveEnsembleFanoutIsolationPolicy(
  value: unknown
): EnsembleFanoutIsolationPolicy {
  return value === 'worktree' || value === 'any' ? value : 'off'
}
