import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildKimiFlavourGateMessage,
  classifyKimiHelp,
  clearKimiFlavourCacheForTests,
  probeKimiFlavour,
  type KimiFlavourCaptureResult
} from './KimiFlavour'

/** Verbatim `kimi --help` transcript from kimi-code 0.24.1 (2026-07-15). */
const KIMI_CODE_HELP = `Usage: kimi [options] [command]

The Starting Point for Next-Gen Agents

Options:
  -V, --version                 output the version number
  -S, --session [id]            Resume a session. With ID: resume that session. Without ID:
                                interactively pick.
  -c, --continue                Continue the previous session for the working directory. (default:
                                false)
  -y, --yolo                    Automatically approve all actions. (default: false)
  --auto                        Start in auto permission mode. (default: false)
  -m, --model <model>           LLM model alias to use for this invocation. Defaults to
                                default_model in config.toml.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. Defaults to text. (choices: "text",
                                "stream-json")
  --skills-dir <dir>            Load skills from this directory instead of auto-discovered user and
                                project directories. Can be repeated. (default: [])
  --add-dir <dir>               Add an additional workspace directory for this session. Can be
                                repeated. (default: [])
  --plan                        Start in plan mode. (default: false)
  -h, --help                    Show help.

Commands:
  export [options] [sessionId]  Export a session as a ZIP archive.
  provider                      Manage LLM providers non-interactively.
  acp [options]                 Run kimi-code as an Agent Client Protocol (ACP) server over stdio.
  server                        Run the local Kimi server (REST + WebSocket + web UI).
  web [options]                 Open the Kimi web UI (starts a background daemon if needed).
  login                         Authenticate with Kimi Code CLI via the device-code flow.
  doctor                        Validate Kimi Code configuration files.
  vis [options] [sessionId]     Launch the session visualizer in your browser.
  migrate                       Migrate data from a legacy kimi-cli installation into kimi-code.
  upgrade|update                Upgrade Kimi Code to the latest version.

Documentation:        https://moonshotai.github.io/kimi-code/
`

/** Representative legacy kimi-cli help (the frozen ~1.4x Python line). */
const LEGACY_WIRE_HELP = `Usage: kimi [OPTIONS]

Options:
  --wire               Run as a Wire JSON-RPC server over stdio.
  --work-dir TEXT      Working directory for the session.
  --print              Print a single response and exit.
  --agent-file TEXT    Agent definition YAML for this run.
  --resume TEXT        Resume the given session id.
  --thinking           Enable thinking output.
  --help               Show this message and exit.
`

beforeEach(() => {
  clearKimiFlavourCacheForTests()
})

describe('classifyKimiHelp', () => {
  it('identifies the legacy Wire CLI by its advertised --wire option', () => {
    expect(classifyKimiHelp(LEGACY_WIRE_HELP)).toEqual({
      flavour: 'legacy-wire',
      evidence: '--wire advertised in --help'
    })
  })

  it('identifies Kimi Code by its subcommand surface when --wire is absent', () => {
    const findings = classifyKimiHelp(KIMI_CODE_HELP)
    expect(findings.flavour).toBe('kimi-code')
    expect(findings.evidence).toContain("'acp' subcommand")
  })

  it('prefers legacy-wire when both signals somehow appear', () => {
    const hybrid = `${LEGACY_WIRE_HELP}\nCommands:\n  acp [options]  Run as an ACP server.\n`
    expect(classifyKimiHelp(hybrid).flavour).toBe('legacy-wire')
  })

  it('ignores --wire mentioned in prose rather than advertised as an option', () => {
    const prose = KIMI_CODE_HELP.replace(
      'The Starting Point for Next-Gen Agents',
      'The successor to the removed --wire transport.'
    )
    expect(classifyKimiHelp(prose).flavour).toBe('kimi-code')
  })

  it('classifies doctor/migrate rows as Kimi Code even without acp', () => {
    const doctorOnly = 'Usage: kimi [options]\n\nCommands:\n  doctor     Validate configuration.\n'
    const findings = classifyKimiHelp(doctorOnly)
    expect(findings.flavour).toBe('kimi-code')
    expect(findings.evidence).toContain("'doctor' subcommand")
  })

  it('returns unsupported for empty or unrecognisable output', () => {
    expect(classifyKimiHelp('').flavour).toBe('unsupported')
    expect(classifyKimiHelp('   \n \n').evidence).toBe('--help produced no output')
    expect(classifyKimiHelp('error: something exploded').flavour).toBe('unsupported')
  })
})

describe('probeKimiFlavour', () => {
  function capture(result: Partial<KimiFlavourCaptureResult>): KimiFlavourCaptureResult {
    return { stdout: '', stderr: '', code: 0, timedOut: false, ...result }
  }

  it('classifies from combined stdout+stderr of `--help`', async () => {
    const capturer = vi.fn(async () => capture({ stderr: KIMI_CODE_HELP }))
    const findings = await probeKimiFlavour('/opt/kimi', { capture: capturer })
    expect(findings.flavour).toBe('kimi-code')
    expect(capturer).toHaveBeenCalledWith('/opt/kimi', ['--help'])
  })

  it('returns unsupported when the probe errors, times out, or throws', async () => {
    expect(
      (
        await probeKimiFlavour('/opt/kimi', {
          capture: async () => capture({ error: 'spawn ENOENT' })
        })
      ).evidence
    ).toBe('--help probe failed: spawn ENOENT')
    expect(
      (
        await probeKimiFlavour('/opt/kimi', {
          capture: async () => capture({ timedOut: true })
        })
      ).evidence
    ).toBe('--help probe timed out')
    expect(
      (
        await probeKimiFlavour('/opt/kimi', {
          capture: async () => {
            throw new Error('boom')
          }
        })
      ).evidence
    ).toBe('--help probe threw: boom')
  })

  it('caches decisive findings per binary path+mtime+size', async () => {
    const capturer = vi.fn(async () => capture({ stdout: KIMI_CODE_HELP }))
    const statBinary = vi.fn(async () => ({ mtimeMs: 100, size: 42 }))
    const deps = { capture: capturer, statBinary }

    await probeKimiFlavour('/opt/kimi', deps)
    const second = await probeKimiFlavour('/opt/kimi', deps)
    expect(second.flavour).toBe('kimi-code')
    expect(capturer).toHaveBeenCalledTimes(1)

    // A replaced binary (new mtime) is re-probed.
    statBinary.mockResolvedValue({ mtimeMs: 200, size: 42 })
    capturer.mockResolvedValue(capture({ stdout: LEGACY_WIRE_HELP }))
    const third = await probeKimiFlavour('/opt/kimi', deps)
    expect(third.flavour).toBe('legacy-wire')
    expect(capturer).toHaveBeenCalledTimes(2)
  })

  it('never caches unsupported findings or unstat-able binaries', async () => {
    const failing = vi.fn(async () => capture({ error: 'spawn EPERM' }))
    const statBinary = vi.fn(async () => ({ mtimeMs: 100, size: 42 }))
    await probeKimiFlavour('/opt/kimi', { capture: failing, statBinary })
    await probeKimiFlavour('/opt/kimi', { capture: failing, statBinary })
    expect(failing).toHaveBeenCalledTimes(2)

    const healthy = vi.fn(async () => capture({ stdout: KIMI_CODE_HELP }))
    const noStat = vi.fn(async () => null)
    await probeKimiFlavour('/opt/kimi2', { capture: healthy, statBinary: noStat })
    await probeKimiFlavour('/opt/kimi2', { capture: healthy, statBinary: noStat })
    expect(healthy).toHaveBeenCalledTimes(2)
  })
})

describe('buildKimiFlavourGateMessage', () => {
  it('explains that generation detection is not ACP runtime admission', () => {
    const message = buildKimiFlavourGateMessage(
      { flavour: 'kimi-code', evidence: "no --wire option; 'acp' subcommand advertised in --help" },
      '/Users/x/.kimi-code/bin/kimi'
    )
    expect(message).toContain('Kimi Code was detected at /Users/x/.kimi-code/bin/kimi')
    expect(message).toContain('generation detection is not runtime admission')
    expect(message).toContain('embedded reviewed roster')
    expect(message).toContain('No legacy Wire or print-mode fallback')
  })

  it('surfaces the probe evidence for unsupported binaries', () => {
    const message = buildKimiFlavourGateMessage(
      { flavour: 'unsupported', evidence: '--help probe timed out' },
      '/opt/kimi'
    )
    expect(message).toContain('could not be identified')
    expect(message).toContain('--help probe timed out')
  })
})
