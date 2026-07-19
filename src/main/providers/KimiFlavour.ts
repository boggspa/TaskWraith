// Historical, dependency-injected generation classifier for old Kimi records
// and regression fixtures. Production managed runs do not call this module:
// descriptor-bound KimiRuntimeAdmission is authoritative and admits only the
// exact ACP runtime tuples embedded in the build.
//
// The kimi-cli → Kimi Code migration (2026-07) replaced the legacy Python CLI
// (Wire transport, `--wire`) with a TypeScript rewrite whose stdio server is
// `kimi acp` — the binary keeps the NAME `kimi` but shares no argv grammar
// with its predecessor. Spawning the wrong grammar dies at argv parse, and
// Kimi Code's `-p/--prompt` one-shot mode runs under auto-approve semantics
// with no `--agent-file` containment sink (migration dossier B1/B6), so the
// runtime must POSITIVELY identify the generation before any spawn and fail
// closed on ambiguity (dossier §4: probe, don't guess). NEVER compare semver
// — the two lines are separate products with unrelated version sequences
// (legacy froze ~1.47 while Kimi Code ships 0.x).
//
// Kept free of Electron / fs / child_process imports so the classifier is
// directly unit-testable against real help transcripts (GrokCliProbe
// pattern). The real app wires `capture` to captureProcessOutput and
// `statBinary` to fs.stat; decisive results are cached per binary
// path+mtime+size so each installed binary is probed once, not once per run.

export type KimiCliFlavour = 'legacy-wire' | 'kimi-code' | 'unsupported'

export interface KimiFlavourFindings {
  flavour: KimiCliFlavour
  /** Human-readable one-liner recording WHY the classification was made. */
  evidence: string
}

/** Minimal shape of captureProcessOutput's resolved value. */
export interface KimiFlavourCaptureResult {
  stdout: string
  stderr: string
  code: number | null
  error?: string
  timedOut?: boolean
}

export interface KimiFlavourProbeDeps {
  capture: (command: string, args: string[]) => Promise<KimiFlavourCaptureResult>
  /** Returns null when the binary cannot be stat'ed; the probe then runs uncached. */
  statBinary?: (binaryPath: string) => Promise<{ mtimeMs: number; size: number } | null>
}

/** `--help` on the legacy CLI answers well under a second; 5s absorbs a cold
 *  first spawn of the 150MB+ Kimi Code binary without stalling run startup. */
export const KIMI_FLAVOUR_PROBE_TIMEOUT_MS = 5_000

/**
 * Collect `--flag` tokens from OPTION lines only (lines whose trimmed text
 * starts with a dash), never from prose — mirrors GrokCliProbe's extractFlags
 * so a help sentence like "replaces the removed --wire transport" can never
 * classify a binary as legacy.
 */
function extractOptionFlags(helpText: string): Set<string> {
  const flags = new Set<string>()
  for (const line of helpText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue
    for (const match of trimmed.matchAll(/--[a-z][a-z0-9-]*/g)) {
      flags.add(match[0])
    }
  }
  return flags
}

/** Subcommands that exist only on the Kimi Code generation (verified against
 *  kimi-code 0.24.1 `--help`; the legacy CLI has none of them). */
const KIMI_CODE_SUBCOMMAND_SIGNALS = ['acp', 'doctor', 'migrate'] as const

function detectKimiCodeSubcommand(helpText: string): string | null {
  for (const name of KIMI_CODE_SUBCOMMAND_SIGNALS) {
    // Commander lists subcommands as indented rows, e.g.
    // "  acp [options]   Run kimi-code as an Agent Client Protocol…" —
    // require an indented row STARTING with the name so prose cannot match.
    if (new RegExp(`^\\s{2,}${name}\\b`, 'm').test(helpText)) return name
  }
  return null
}

export function classifyKimiHelp(helpText: string): KimiFlavourFindings {
  const text = (helpText || '').trim()
  if (!text) {
    return { flavour: 'unsupported', evidence: '--help produced no output' }
  }
  // An ADVERTISED --wire option wins outright: whatever else the help says,
  // a binary that documents --wire speaks the legacy Wire transport.
  if (extractOptionFlags(text).has('--wire')) {
    return { flavour: 'legacy-wire', evidence: '--wire advertised in --help' }
  }
  const subcommand = detectKimiCodeSubcommand(text)
  if (subcommand) {
    return {
      flavour: 'kimi-code',
      evidence: `no --wire option; '${subcommand}' subcommand advertised in --help`
    }
  }
  return {
    flavour: 'unsupported',
    evidence: 'help output has neither a --wire option nor a Kimi Code subcommand'
  }
}

interface CachedKimiFlavour {
  mtimeMs: number
  size: number
  findings: KimiFlavourFindings
}

const flavourCache = new Map<string, CachedKimiFlavour>()

export function clearKimiFlavourCacheForTests(): void {
  flavourCache.clear()
}

export async function probeKimiFlavour(
  binaryPath: string,
  deps: KimiFlavourProbeDeps
): Promise<KimiFlavourFindings> {
  const stat = deps.statBinary ? await deps.statBinary(binaryPath) : null
  if (stat) {
    const cached = flavourCache.get(binaryPath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.findings
    }
  }
  let findings: KimiFlavourFindings
  try {
    const capture = await deps.capture(binaryPath, ['--help'])
    if (capture.error) {
      findings = { flavour: 'unsupported', evidence: `--help probe failed: ${capture.error}` }
    } else if (capture.timedOut) {
      findings = { flavour: 'unsupported', evidence: '--help probe timed out' }
    } else {
      findings = classifyKimiHelp(`${capture.stdout}\n${capture.stderr}`)
    }
  } catch (error) {
    findings = {
      flavour: 'unsupported',
      evidence: `--help probe threw: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  // Cache only decisive results keyed to the exact binary bytes; a failed
  // stat or a failed/ambiguous probe stays uncached so a transient spawn
  // failure can never pin 'unsupported' onto a healthy install.
  if (stat && findings.flavour !== 'unsupported') {
    flavourCache.set(binaryPath, { mtimeMs: stat.mtimeMs, size: stat.size, findings })
  }
  return findings
}

/**
 * Compatibility copy for historical callers. No result from this classifier
 * authorises a managed spawn.
 */
export function buildKimiFlavourGateMessage(
  findings: KimiFlavourFindings,
  binaryPath: string
): string {
  if (findings.flavour === 'kimi-code') {
    return (
      `Kimi Code was detected at ${binaryPath}, but generation detection is not runtime admission. ` +
      `TaskWraith starts Kimi only through its contained ACP transport when the exact binary tuple is present in the embedded reviewed roster. ` +
      `No legacy Wire or print-mode fallback is available.`
    )
  }
  return `The Kimi CLI at ${binaryPath} could not be identified as a supported generation (${findings.evidence}), so the run was not started.`
}
