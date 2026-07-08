// Pure, dependency-injected probe for the Cursor Agent CLI (`cursor-agent`).
//
// Kept free of Electron / fs / child_process imports so the parsers are
// directly unit-testable and the orchestrator can run against injected fakes
// (no real process spawned in tests). The real app wires `resolveBinary` to
// resolveCliProviderBinary('cursor') and `capture` to captureProcessOutput.
//
// READ-ONLY by construction: only `--version` / `--help` / `status` / `models`
// probes. It NEVER runs a prompt (`-p`), never passes `--force`/`--yolo`, never
// mutates global `~/.cursor`, and never reads credential files. This is the CR0
// foundation for the gated Cursor provider arc.
//
// CR3 live spike confirmed the load-bearing safety facts encoded here: a bare
// `cursor-agent -p` writes files/runs shell UNMEDIATED, so production must
// always pass `--mode plan` (read-only) or a workspace-local deny-list (write).
// The probe touches none of that — it is inert.

export interface CursorModel {
  id: string
  label: string
}

export interface CursorProbeFindings {
  probedAt: string
  binaryPath: string | null
  binarySource: string | null
  version: string | null
  versionRaw: string
  /** Parsed from `cursor-agent status` — false when "Not logged in". */
  loggedIn: boolean
  topLevelFlags: string[]
  subcommands: string[]
  /** Full `cursor-agent models` list (empty when logged out). */
  models: CursorModel[]
  /** TaskWraith-exposed Cursor ids: Composer 2.5 plus Cursor Grok 4.5 variants. */
  composerModelIds: string[]
  errors: string[]
}

/** Minimal shape of resolveCliProviderBinary('cursor') — avoids importing the
 *  Electron-heavy index.ts into a pure module / unit test. */
export interface CursorProbeBinary {
  binaryPath: string | null
  source?: string
  error?: string
}

/** Minimal shape of captureProcessOutput's resolved value. */
export interface CursorProbeCaptureResult {
  stdout: string
  stderr: string
  code: number | null
  error?: string
  timedOut?: boolean
}

export interface CursorProbeDeps {
  resolveBinary: () => Promise<CursorProbeBinary>
  capture: (command: string, args: string[]) => Promise<CursorProbeCaptureResult>
}

/**
 * The canonical Cursor model ids TaskWraith ships (confirmed live via
 * `cursor-agent models`). Most Cursor-proxied models belong to their native
 * providers; Cursor Grok 4.5 is included because Cursor exposes it in the
 * first-party included model pool with its own reasoning/fast variants.
 */
export const CURSOR_COMPOSER_MODELS: readonly CursorModel[] = [
  { id: 'composer-2.5', label: 'Composer 2.5' },
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { id: 'grok-4.5-medium', label: 'Grok 4.5 Low' },
  { id: 'grok-4.5-fast-medium', label: 'Grok 4.5 Low Fast' },
  { id: 'grok-4.5-high', label: 'Grok 4.5 Medium' },
  { id: 'grok-4.5-fast-high', label: 'Grok 4.5 Medium Fast' },
  { id: 'grok-4.5-xhigh', label: 'Grok 4.5 High' },
  { id: 'grok-4.5-fast-xhigh', label: 'Grok 4.5 High Fast' }
]

export const CURSOR_COMPOSER_MODEL_IDS: readonly string[] = CURSOR_COMPOSER_MODELS.map((m) => m.id)

/**
 * Extract Cursor's date-based version, e.g. "2026.05.28-a70ca7c" →
 * "2026.05.28-a70ca7c". Falls back to a bare YYYY.MM.DD if no build hash is
 * present; null when absent.
 */
export function parseCursorVersion(raw: string): string | null {
  if (!raw) return null
  const withHash = raw.match(/\b(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\b/)
  if (withHash) return withHash[1]
  const dateOnly = raw.match(/\b(\d{4}\.\d{2}\.\d{2})\b/)
  return dateOnly ? dateOnly[1] : null
}

/** True when `cursor-agent status` does NOT report a logged-out state. */
export function parseCursorLoginState(raw: string): boolean {
  const text = (raw || '').trim()
  if (!text) return false
  return !/not logged in|logged out|not authenticated|please log ?in/i.test(text)
}

function extractFlags(text: string): string[] {
  const flags = new Set<string>()
  for (const line of (text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    // Only option lines start with a dash; description / value lines do not, so
    // we never pick flag-like tokens out of prose.
    if (!trimmed.startsWith('-')) continue
    for (const m of trimmed.matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0])
  }
  return [...flags].sort()
}

function extractSubcommands(text: string): string[] {
  const lines = (text || '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line.trim()))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) break // a blank line terminates the Commands block
    // Command rows sit at a shallow (2–4 space) indent and have a 2+ space gap
    // before the description: "  login            Authenticate …",
    // "  status|whoami [options]   View …", "  agent [prompt...]   Start …".
    // Deep-indented (~31 space) continuation lines are excluded by the indent
    // bound; rows without a double-space gap (none in practice) are excluded by
    // the remainder check. The captured name stops at | or whitespace.
    const m = line.match(/^\s{2,4}([a-z][a-z0-9-]*)\b/)
    if (m && /\s{2,}\S/.test(line.slice(m[0].length))) out.push(m[1])
  }
  return out
}

export function parseCursorHelp(raw: string): { flags: string[]; subcommands: string[] } {
  return { flags: extractFlags(raw), subcommands: extractSubcommands(raw) }
}

/**
 * Parse `cursor-agent models` output. Each model is a line `"<id> - <label>"`,
 * e.g. "composer-2.5 - Composer 2.5 (current)". Header / blank lines are
 * skipped. When logged out the command prints "No models available for this
 * account." → [].
 */
export function parseCursorModels(raw: string): CursorModel[] {
  const out: CursorModel[] = []
  for (const line of (raw || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+)$/)
    if (m) out.push({ id: m[1], label: m[2].trim() })
  }
  return out
}

export async function probeCursorCli(deps: CursorProbeDeps): Promise<CursorProbeFindings> {
  const errors: string[] = []
  const findings: CursorProbeFindings = {
    probedAt: new Date().toISOString(),
    binaryPath: null,
    binarySource: null,
    version: null,
    versionRaw: '',
    loggedIn: false,
    topLevelFlags: [],
    subcommands: [],
    models: [],
    composerModelIds: [],
    errors
  }

  const resolved = await deps.resolveBinary()
  findings.binaryPath = resolved.binaryPath
  findings.binarySource = resolved.source ?? null
  if (!resolved.binaryPath) {
    errors.push(resolved.error || 'Cursor CLI (cursor-agent) was not found.')
    return findings
  }
  const bin = resolved.binaryPath

  const versionRes = await deps.capture(bin, ['--version'])
  findings.versionRaw = (versionRes.stdout || versionRes.stderr || '').trim()
  findings.version = parseCursorVersion(findings.versionRaw)
  if (versionRes.error) errors.push(`version probe failed: ${versionRes.error}`)

  const helpRes = await deps.capture(bin, ['--help'])
  const help = parseCursorHelp(helpRes.stdout || helpRes.stderr || '')
  findings.topLevelFlags = help.flags
  findings.subcommands = help.subcommands
  if (helpRes.error) errors.push(`help probe failed: ${helpRes.error}`)

  const statusRes = await deps.capture(bin, ['status'])
  findings.loggedIn = parseCursorLoginState(statusRes.stdout || statusRes.stderr || '')
  if (statusRes.error) errors.push(`status probe failed: ${statusRes.error}`)

  const modelsRes = await deps.capture(bin, ['models'])
  findings.models = parseCursorModels(modelsRes.stdout || modelsRes.stderr || '')
  findings.composerModelIds = findings.models
    .map((m) => m.id)
    .filter((id) => id.startsWith('composer-'))
  if (modelsRes.error) errors.push(`models probe failed: ${modelsRes.error}`)

  return findings
}
