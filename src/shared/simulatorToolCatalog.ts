/**
 * Catalog of OPTIONAL, USER-INSTALLED Simulator Canvas tooling — today Facebook's
 * `idb` / `idb_companion`. Kept separate from `hostCliToolCatalog.ts` (gh-only)
 * because install is multi-step (Homebrew companion + pip client) and Xcode itself
 * is never a brew formula.
 *
 * Node-builtin-free so renderer, main, and tests can all import it.
 */

export type SimulatorToolId = 'idb'

export interface SimulatorToolInstallCommand {
  id: string
  command: string
  platform: string
  platforms: readonly string[]
  /** Short qualifier shown next to the command (Companion vs client). */
  label: string
}

export interface SimulatorToolEntry {
  id: SimulatorToolId
  /** Primary client binary probed on PATH for actuation. */
  binaryName: string
  /** Companion binary (Homebrew). */
  companionBinaryName: string
  label: string
  purpose: string
  missingConsequence: string
  source: string
  docsUrl: string
  installCommands: readonly SimulatorToolInstallCommand[]
  /** Extra pip note — the Python client is not a brew formula. */
  clientInstallNote: string
}

export const SIMULATOR_TOOL_DOCS_URL = 'https://fbidb.io'

export const SIMULATOR_TOOLS: readonly SimulatorToolEntry[] = [
  {
    id: 'idb',
    binaryName: 'idb',
    companionBinaryName: 'idb_companion',
    label: 'idb (iOS Development Bridge)',
    purpose:
      'Drives tap, type, swipe, hardware buttons, rotate, and AX inspect on a booted iOS Simulator for Simulator Canvas View & Control.',
    missingConsequence:
      'Without idb, Simulator Canvas stays preview-only: simctl screenshots still work, but human bezel gestures and hardware controls are recorded and not actuated.',
    source: 'Meta / Facebook',
    docsUrl: SIMULATOR_TOOL_DOCS_URL,
    installCommands: [
      {
        id: 'idb-companion-macos',
        label: 'Companion (Homebrew)',
        command: 'brew tap facebook/fb && brew install idb-companion',
        platform: 'macOS',
        platforms: ['darwin']
      }
    ],
    clientInstallNote:
      'After the companion is installed, install the Python client with `pip3 install fb-idb` (requires Python 3.6+). Confirm with `idb list-targets`.'
  }
]

const SIMULATOR_TOOLS_BY_ID = new Map<string, SimulatorToolEntry>(
  SIMULATOR_TOOLS.map((entry) => [entry.id, entry])
)

export const SIMULATOR_TOOL_IDS: readonly SimulatorToolId[] = SIMULATOR_TOOLS.map(
  (entry) => entry.id
)

export function isSimulatorToolId(value: unknown): value is SimulatorToolId {
  return typeof value === 'string' && SIMULATOR_TOOLS_BY_ID.has(value)
}

export function simulatorTool(id: unknown): SimulatorToolEntry | null {
  return typeof id === 'string' ? (SIMULATOR_TOOLS_BY_ID.get(id) ?? null) : null
}

export function simulatorToolInstallCommands(
  id: SimulatorToolId,
  platform: string
): readonly SimulatorToolInstallCommand[] {
  const entry = simulatorTool(id)
  if (!entry) return []
  return entry.installCommands.filter((command) => command.platforms.includes(platform))
}

/** Short empty-state / banner copy when Xcode is present but idb is missing. */
export function simulatorIdbMissingHint(): string {
  const entry = simulatorTool('idb')
  if (!entry) return 'Install idb to drive Simulator Canvas gestures.'
  return (
    `${entry.missingConsequence} On macOS: \`${entry.installCommands[0]?.command ?? 'brew install idb-companion'}\`, ` +
    `then \`${entry.clientInstallNote.match(/`([^`]+)`/)?.[1] ?? 'pip3 install fb-idb'}\`. See ${entry.docsUrl}.`
  )
}
