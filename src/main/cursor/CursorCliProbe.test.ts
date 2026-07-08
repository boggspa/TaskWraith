import { describe, it, expect, vi } from 'vitest'
import {
  CURSOR_COMPOSER_MODEL_IDS,
  parseCursorHelp,
  parseCursorLoginState,
  parseCursorModels,
  parseCursorVersion,
  probeCursorCli,
  type CursorProbeCaptureResult
} from './CursorCliProbe'

// Captured verbatim from `cursor-agent --version` on 2026.05.28-a70ca7c.
const VERSION_FIXTURE = '2026.05.28-a70ca7c'

// Representative subset of `cursor-agent --help` — keeps the real Options +
// Commands layout (multi-line descriptions, [arg] / |alias command forms,
// deep-indented continuation lines) so the parser is exercised on the real shape.
const HELP_FIXTURE = `Usage: agent [options] [command] [prompt...]

Start the Cursor Agent

Options:
  -p, --print                  Print responses to console (for scripts or
                               non-interactive use). Has access to all tools,
                               including write and shell. (default: false)
  --output-format <format>     Output format (only works with --print): text |
                               json | stream-json (default: "text")
  --mode <mode>                Start in the given execution mode. plan:
                               read-only/planning. ask: Q&A. (choices: "plan", "ask")
  --plan                       Start in plan mode (shorthand for --mode=plan).
  --resume [chatId]            Select a session to resume (default: false)
  --model <model>              Model to use (e.g., gpt-5, sonnet-4)
  -f, --force                  Force allow commands unless explicitly denied
  --trust                      Trust the current workspace without prompting
  -h, --help                   Display help for command

Commands:
  install-shell-integration    Install shell integration to ~/.zshrc
  login                        Authenticate with Cursor. Set NO_OPEN_BROWSER to
                               disable browser opening.
  logout                       Sign out and clear stored authentication
  mcp                          Manage MCP servers
  status|whoami [options]      View authentication status
  models                       List available models for this account
  create-chat                  Create a new empty chat and return its ID
  agent [prompt...]            Start the Cursor Agent
  ls                           Resume a chat session
  resume                       Resume the latest chat session
  help [command]               Display help for command`

// Representative subset of `cursor-agent models` (logged in).
const MODELS_FIXTURE = `Available models

auto - Auto
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5 (current)
claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking
composer-2.5-fast - Composer 2.5 Fast (default)
claude-4.6-sonnet-medium - Sonnet 4.6 1M`

const STATUS_LOGGED_OUT = 'Not logged in'
const STATUS_LOGGED_IN = 'Logged in as dev@example.com'
const MODELS_LOGGED_OUT = 'No models available for this account.'

describe('CursorCliProbe', () => {
  describe('parseCursorVersion', () => {
    it('extracts the date+hash version', () => {
      expect(parseCursorVersion(VERSION_FIXTURE)).toBe('2026.05.28-a70ca7c')
    })
    it('falls back to a bare date when no build hash', () => {
      expect(parseCursorVersion('cursor-agent 2026.05.28')).toBe('2026.05.28')
    })
    it('returns null for junk', () => {
      expect(parseCursorVersion('unknown')).toBeNull()
      expect(parseCursorVersion('')).toBeNull()
    })
  })

  describe('parseCursorLoginState', () => {
    it('is false when logged out', () => {
      expect(parseCursorLoginState(STATUS_LOGGED_OUT)).toBe(false)
      expect(parseCursorLoginState('You are not logged in.')).toBe(false)
      expect(parseCursorLoginState('')).toBe(false)
    })
    it('is true when logged in', () => {
      expect(parseCursorLoginState(STATUS_LOGGED_IN)).toBe(true)
    })
  })

  describe('parseCursorHelp', () => {
    it('extracts the read-only-relevant flags', () => {
      const { flags } = parseCursorHelp(HELP_FIXTURE)
      for (const f of [
        '--print',
        '--output-format',
        '--mode',
        '--plan',
        '--resume',
        '--model',
        '--force',
        '--trust'
      ]) {
        expect(flags).toContain(f)
      }
    })
    it('extracts subcommands incl. [arg] and |alias forms, excluding continuations', () => {
      const { subcommands } = parseCursorHelp(HELP_FIXTURE)
      for (const c of [
        'login',
        'logout',
        'mcp',
        'status',
        'models',
        'create-chat',
        'agent',
        'ls',
        'resume',
        'help',
        'install-shell-integration'
      ]) {
        expect(subcommands).toContain(c)
      }
      // "disable browser opening." is a deep-indented continuation line, NOT a command.
      expect(subcommands).not.toContain('disable')
    })
  })

  describe('parseCursorModels', () => {
    it('parses id + label rows and skips headers', () => {
      const models = parseCursorModels(MODELS_FIXTURE)
      expect(models).toContainEqual({ id: 'composer-2.5', label: 'Composer 2.5 (current)' })
      expect(models).toContainEqual({
        id: 'composer-2.5-fast',
        label: 'Composer 2.5 Fast (default)'
      })
      expect(models.find((m) => m.id === 'Available')).toBeUndefined()
    })
    it('returns [] when logged out', () => {
      expect(parseCursorModels(MODELS_LOGGED_OUT)).toEqual([])
    })
  })

  describe('probeCursorCli', () => {
    const ok = (stdout: string): CursorProbeCaptureResult => ({
      stdout,
      stderr: '',
      code: 0
    })

    it('returns full findings when the binary is present + logged in', async () => {
      const capture = vi.fn(async (_bin: string, args: string[]) => {
        if (args.includes('--version')) return ok(VERSION_FIXTURE)
        if (args.includes('--help')) return ok(HELP_FIXTURE)
        if (args[0] === 'status') return ok(STATUS_LOGGED_IN)
        if (args[0] === 'models') return ok(MODELS_FIXTURE)
        return ok('')
      })
      const findings = await probeCursorCli({
        resolveBinary: async () => ({
          binaryPath: '/home/u/.local/bin/cursor-agent',
          source: 'common'
        }),
        capture
      })
      expect(findings.binaryPath).toBe('/home/u/.local/bin/cursor-agent')
      expect(findings.version).toBe('2026.05.28-a70ca7c')
      expect(findings.loggedIn).toBe(true)
      expect(findings.subcommands).toContain('models')
      expect(findings.composerModelIds).toEqual(['composer-2.5', 'composer-2.5-fast'])
      expect(findings.errors).toEqual([])
    })

    it('reports logged-out state with no models', async () => {
      const capture = vi.fn(async (_bin: string, args: string[]) => {
        if (args.includes('--version')) return ok(VERSION_FIXTURE)
        if (args.includes('--help')) return ok(HELP_FIXTURE)
        if (args[0] === 'status') return ok(STATUS_LOGGED_OUT)
        if (args[0] === 'models') return ok(MODELS_LOGGED_OUT)
        return ok('')
      })
      const findings = await probeCursorCli({
        resolveBinary: async () => ({
          binaryPath: '/home/u/.local/bin/cursor-agent',
          source: 'common'
        }),
        capture
      })
      expect(findings.loggedIn).toBe(false)
      expect(findings.models).toEqual([])
      expect(findings.composerModelIds).toEqual([])
    })

    it('short-circuits with an error when the binary is missing', async () => {
      const capture = vi.fn()
      const findings = await probeCursorCli({
        resolveBinary: async () => ({ binaryPath: null, source: 'missing', error: 'not found' }),
        capture
      })
      expect(findings.binaryPath).toBeNull()
      expect(findings.errors).toContain('not found')
      expect(capture).not.toHaveBeenCalled()
    })
  })

  it('exposes Composer 2.5 and Cursor Grok 4.5 concrete ids', () => {
    expect(CURSOR_COMPOSER_MODEL_IDS).toEqual([
      'composer-2.5',
      'composer-2.5-fast',
      'grok-4.5-medium',
      'grok-4.5-fast-medium',
      'grok-4.5-high',
      'grok-4.5-fast-high',
      'grok-4.5-xhigh',
      'grok-4.5-fast-xhigh'
    ])
  })
})
