/**
 * A provider talking is not proof that its workspace changed. Filesystem
 * watching owns live Git refreshes; a terminal event is the bounded fallback
 * that settles final diff detail after a run.
 */
export function shouldInvalidateLiveGitSnapshot(channel: string): boolean {
  return channel === 'agent-exit' || channel === 'gemini-exit'
}
