/**
 * Single source of truth for runtime-derived WIP marker filenames.
 *
 * NodeWorkspaceLockPersistence and WorkspaceLockWal MUST share this pattern.
 * A half-applied change to only one call site silently breaks marker recognition.
 */
export const RUNTIME_MARKER_NAME_RE =
  /^\.WORK-IN-PROGRESS-taskwraith-runtime-[A-Za-z0-9_-]+-[a-f0-9]{64}\.md$/

export function isRuntimeMarkerName(value: string): boolean {
  return RUNTIME_MARKER_NAME_RE.test(value)
}
