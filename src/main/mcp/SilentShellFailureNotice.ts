/**
 * A silent non-zero shell exit formats to the bare string `Exit code: N`.
 *
 * `formatHostCommandResult` appends stdout, stderr and error only when they are
 * non-empty, so a command that fails without printing anything produces that
 * string and nothing else — no mention of what was run. Every silent failure in
 * the workspace is then byte-identical, which is indistinguishable to a model
 * deciding whether it is repeating itself, and is why three unrelated no-match
 * greps could read as one looping call. `grep`, `test -f` and `git diff
 * --quiet` all report "no match" as a silent exit 1, so this is the common
 * case, not an exotic one.
 *
 * Only the silent case is annotated: a command that printed something already
 * carries its own discriminator, and appending to every result would bloat
 * transcripts for no gain.
 */
export interface SilentShellFailureInput {
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
  readonly timedOut: boolean
  readonly exitCode: number | null
}

/**
 * The executed command is a string or an argv array by the time it reaches the
 * host, so normalise both into one readable line rather than leaking `[object
 * Object]` into a transcript.
 */
function describeShellCommand(command: unknown): string {
  if (typeof command === 'string') return command.trim()
  if (Array.isArray(command)) {
    return command
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .join(' ')
      .trim()
  }
  return ''
}

export function appendSilentShellCommandNotice(
  text: string,
  command: unknown,
  result: SilentShellFailureInput
): string {
  const failed = Boolean(
    result.error || result.timedOut || (result.exitCode !== null && result.exitCode !== 0)
  )
  if (!failed) return text
  if (result.stdout || result.stderr || result.error) return text
  const described = describeShellCommand(command)
  if (!described) return text
  return `${text}\n\ncommand: ${described}`
}
