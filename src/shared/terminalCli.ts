/**
 * The CLI ids used by Thread Home's native-terminal picker.
 *
 * Only ids cross the renderer/main boundary. The main process resolves the
 * corresponding executable before anything is written to a terminal.
 */
export const TERMINAL_CLI_IDS = [
  'default',
  'codex',
  'claude',
  'kimi',
  'cursor',
  'grok',
  'ollama',
  'mistral',
  'agy',
  'pi',
  'muse',
  'github'
] as const

export type TerminalCliId = (typeof TERMINAL_CLI_IDS)[number]

const TERMINAL_CLI_COMMANDS: Partial<Record<TerminalCliId, string>> = {
  codex: 'codex',
  claude: 'claude',
  kimi: 'kimi',
  cursor: 'cursor-agent',
  grok: 'grok',
  ollama: 'ollama',
  // Mistral Vibe's interactive terminal binary is `vibe`; `vibe-acp` is the
  // non-interactive ACP transport and `mistral` is not an installed binary.
  mistral: 'vibe',
  agy: 'agy',
  pi: 'pi',
  muse: 'muse',
  github: 'gh'
}

export function isTerminalCliId(value: string): value is TerminalCliId {
  return (TERMINAL_CLI_IDS as readonly string[]).includes(value)
}

/** Return the interactive executable name, or null for Default/unknown ids. */
export function getTerminalCliCommand(cliId: string): string | null {
  if (!isTerminalCliId(cliId)) return null
  return TERMINAL_CLI_COMMANDS[cliId] ?? null
}
