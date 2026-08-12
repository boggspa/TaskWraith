import { describe, expect, it } from 'vitest'
import {
  MUSE_BINARY_NAME,
  MUSE_BUILD_SHA_PIN,
  MUSE_DEFAULT_MODEL,
  MUSE_DEFAULT_PROVIDER,
  MUSE_DEFAULT_REASONING_EFFORT,
  MUSE_DEFAULT_SANDBOX_NETWORK,
  MUSE_META_API_KEY_ENV,
  MUSE_NATIVE_TOOL_POLICY,
  MUSE_REASONING_EFFORTS,
  MUSE_TOOL_SURFACE_VERSION_PIN,
  buildMuseExecArgv,
  buildMuseSeatEnv,
  isMuseSessionUuid,
  museMetaApiKeyScrubbed,
  museWriteCapable,
  normalizeMuseReasoningEffort
} from './MuseCliArgs'

const homes = {
  xdgConfigHome: '/tmp/muse-seat/config',
  xdgDataHome: '/tmp/muse-seat/data',
  xdgStateHome: '/tmp/muse-seat/state',
  xdgCacheHome: '/tmp/muse-seat/cache',
  home: '/tmp/muse-seat/home',
  museAuthPath: '/tmp/muse-seat/config/muse/auth.json'
}

const base = {
  prompt: 'summarize the repo',
  workspace: '/ws',
  sessionId: '11111111-2222-3333-4444-555555555555',
  readOnlySeat: true
}

describe('muse constants + policy', () => {
  it('targets the muse launcher and pins meta / spark / tool surface', () => {
    expect(MUSE_BINARY_NAME).toBe('muse')
    expect(MUSE_DEFAULT_PROVIDER).toBe('meta')
    expect(MUSE_DEFAULT_MODEL).toBe('muse-spark-1.2')
    expect(MUSE_TOOL_SURFACE_VERSION_PIN).toBe('2')
    expect(MUSE_BUILD_SHA_PIN).toBe('427a430436')
    expect(MUSE_DEFAULT_SANDBOX_NETWORK).toBe('proxy-only')
  })

  it('excludes none from the meta-compatible effort ladder', () => {
    expect(MUSE_REASONING_EFFORTS).not.toContain('none')
    expect([...MUSE_REASONING_EFFORTS]).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra'
    ])
  })

  it('documents forbidden / read-only / headless flags for the launch seal', () => {
    expect(MUSE_NATIVE_TOOL_POLICY.forbiddenFlags).toEqual([
      '--yolo',
      '--disable-sandbox',
      '--no-session-log'
    ])
    expect(MUSE_NATIVE_TOOL_POLICY.readOnlyFlags).toEqual(['--disable-write', '--disable-shell'])
    expect(MUSE_NATIVE_TOOL_POLICY.headlessFlags).toEqual([
      '--disable-approval',
      '--user-input-auto-resolve'
    ])
    expect(MUSE_NATIVE_TOOL_POLICY.meteringRequiresSessionLog).toBe(true)
  })
})

describe('museWriteCapable', () => {
  it('treats plan / empty / unset as read-only, including stray whitespace', () => {
    expect(museWriteCapable('plan')).toBe(false)
    expect(museWriteCapable('plan ')).toBe(false)
    expect(museWriteCapable(' plan')).toBe(false)
    expect(museWriteCapable('')).toBe(false)
    expect(museWriteCapable('   ')).toBe(false)
    expect(museWriteCapable(null)).toBe(false)
    expect(museWriteCapable(undefined)).toBe(false)
  })

  it('treats other modes as write-capable', () => {
    expect(museWriteCapable('default')).toBe(true)
    expect(museWriteCapable('acceptEdits')).toBe(true)
  })
})

describe('normalizeMuseReasoningEffort', () => {
  it('maps none/off to minimal (meta rejects none)', () => {
    expect(normalizeMuseReasoningEffort('none')).toBe('minimal')
    expect(normalizeMuseReasoningEffort('NONE')).toBe('minimal')
    expect(normalizeMuseReasoningEffort('off')).toBe('minimal')
  })

  it('passes the meta ladder through', () => {
    for (const effort of MUSE_REASONING_EFFORTS) {
      expect(normalizeMuseReasoningEffort(effort)).toBe(effort)
      expect(normalizeMuseReasoningEffort(` ${effort.toUpperCase()} `)).toBe(effort)
    }
  })

  it('defaults unknown / empty to high rather than forwarding', () => {
    expect(normalizeMuseReasoningEffort('')).toBe(MUSE_DEFAULT_REASONING_EFFORT)
    expect(normalizeMuseReasoningEffort(null)).toBe(MUSE_DEFAULT_REASONING_EFFORT)
    expect(normalizeMuseReasoningEffort(undefined)).toBe(MUSE_DEFAULT_REASONING_EFFORT)
    expect(normalizeMuseReasoningEffort('turbo')).toBe(MUSE_DEFAULT_REASONING_EFFORT)
  })
})

describe('buildMuseExecArgv', () => {
  it('always starts with exec --json --provider meta --workspace', () => {
    const args = buildMuseExecArgv(base)
    expect(args.slice(0, 6)).toEqual(['exec', '--json', '--provider', 'meta', '--workspace', '/ws'])
  })

  it('includes headless flags, session id, effort, and sandbox network pin', () => {
    const args = buildMuseExecArgv(base)
    expect(args).toContain('--no-foreign-personal-context')
    expect(args).toContain('--disable-approval')
    expect(args).toContain('--user-input-auto-resolve')
    expect(args.join(' ')).toContain('--session-id 11111111-2222-3333-4444-555555555555')
    expect(args.join(' ')).toContain('--reasoning-effort high')
    expect(args.join(' ')).toContain('--sandbox-network proxy-only')
    expect(args).toContain('--disable-web-tools')
    expect(args[args.length - 1]).toBe('summarize the repo')
  })

  it('NEVER emits --yolo, --disable-sandbox, or --no-session-log', () => {
    for (const readOnlySeat of [true, false]) {
      const args = buildMuseExecArgv({
        ...base,
        readOnlySeat,
        trustWorkspace: true,
        apiKeyStdin: true,
        model: MUSE_DEFAULT_MODEL,
        reasoningEffort: 'none',
        maxModelSteps: 32,
        maxToolOutputBytes: 4096
      })
      for (const forbidden of MUSE_NATIVE_TOOL_POLICY.forbiddenFlags) {
        expect(args).not.toContain(forbidden)
      }
      expect(args.join(' ')).not.toMatch(/(^|\s)--yolo(\s|$)/)
      expect(args.join(' ')).not.toMatch(/--disable-sandbox/)
      expect(args.join(' ')).not.toMatch(/--no-session-log/)
    }
  })

  it('read-only seat adds both --disable-write and --disable-shell', () => {
    const args = buildMuseExecArgv({ ...base, readOnlySeat: true })
    expect(args).toContain('--disable-write')
    expect(args).toContain('--disable-shell')
  })

  it('write-capable seat omits --disable-write / --disable-shell', () => {
    const args = buildMuseExecArgv({ ...base, readOnlySeat: false })
    expect(args).not.toContain('--disable-write')
    expect(args).not.toContain('--disable-shell')
  })

  it('never forwards reasoning-effort none for meta', () => {
    const args = buildMuseExecArgv({ ...base, reasoningEffort: 'none' })
    expect(args.join(' ')).toContain('--reasoning-effort minimal')
    expect(args.join(' ')).not.toContain('--reasoning-effort none')
  })

  it('forwards a concrete model and optional caps', () => {
    const args = buildMuseExecArgv({
      ...base,
      model: MUSE_DEFAULT_MODEL,
      maxModelSteps: 12.9,
      maxToolOutputBytes: 2048.7,
      reasoningEffort: 'xhigh',
      sandboxNetwork: 'restricted'
    })
    expect(args.join(' ')).toContain(`--model ${MUSE_DEFAULT_MODEL}`)
    expect(args.join(' ')).toContain('--max-model-steps 12')
    expect(args.join(' ')).toContain('--max-tool-output-bytes 2048')
    expect(args.join(' ')).toContain('--reasoning-effort xhigh')
    expect(args.join(' ')).toContain('--sandbox-network restricted')
  })

  it('drops cli-default / empty model rather than forwarding', () => {
    expect(buildMuseExecArgv({ ...base, model: 'cli-default' })).not.toContain('--model')
    expect(buildMuseExecArgv({ ...base, model: '   ' })).not.toContain('--model')
    expect(buildMuseExecArgv({ ...base, model: null })).not.toContain('--model')
  })

  it('supports --api-key-stdin without placing a secret on argv', () => {
    const args = buildMuseExecArgv({ ...base, apiKeyStdin: true })
    expect(args).toContain('--api-key-stdin')
    expect(args.join(' ')).not.toMatch(/sk-|META_API_KEY|api-key\s+\S+/)
  })

  it('uses --prompt-file when set and omits the positional prompt', () => {
    const args = buildMuseExecArgv({
      ...base,
      prompt: 'should not appear',
      promptFile: '/tmp/prompt.txt'
    })
    expect(args.join(' ')).toContain('--prompt-file /tmp/prompt.txt')
    expect(args).not.toContain('should not appear')
  })

  it('omits --trust-workspace by default and emits it only when requested', () => {
    expect(buildMuseExecArgv(base)).not.toContain('--trust-workspace')
    expect(buildMuseExecArgv({ ...base, trustWorkspace: true })).toContain('--trust-workspace')
  })

  it('can leave web tools enabled when disableWebTools is false', () => {
    const args = buildMuseExecArgv({ ...base, disableWebTools: false })
    expect(args).not.toContain('--disable-web-tools')
  })

  it('rejects empty workspace or sessionId', () => {
    expect(() => buildMuseExecArgv({ ...base, workspace: '  ' })).toThrow(/workspace/)
    expect(() => buildMuseExecArgv({ ...base, sessionId: '' })).toThrow(/sessionId/)
  })

  it('rejects TaskWraith appRunId-shaped session ids (Muse requires a UUID)', () => {
    expect(isMuseSessionUuid('1786386574521-0o0k5nn6qpef')).toBe(false)
    expect(isMuseSessionUuid(base.sessionId)).toBe(true)
    expect(() => buildMuseExecArgv({ ...base, sessionId: '1786386574521-0o0k5nn6qpef' })).toThrow(
      /UUID|session-id|sessionId/i
    )
  })
})

describe('buildMuseSeatEnv', () => {
  it('relocates all four XDG_* homes and stamps MUSE_NO_AUTO_UPDATE=1', () => {
    const env = buildMuseSeatEnv({ PATH: '/usr/bin', META_API_KEY: 'secret' }, homes)
    expect(env.XDG_CONFIG_HOME).toBe(homes.xdgConfigHome)
    expect(env.XDG_DATA_HOME).toBe(homes.xdgDataHome)
    expect(env.XDG_STATE_HOME).toBe(homes.xdgStateHome)
    expect(env.XDG_CACHE_HOME).toBe(homes.xdgCacheHome)
    expect(env.HOME).toBe(homes.home)
    expect(env.MUSE_AUTH_PATH).toBe(homes.museAuthPath)
    expect(env.MUSE_NO_AUTO_UPDATE).toBe('1')
    // @portability-ok: verifies an opaque caller-supplied PATH is preserved byte-for-byte.
    expect(env.PATH).toBe('/usr/bin')
  })

  it('scrubs META_API_KEY by default without mutating the caller env', () => {
    const original = { PATH: '/usr/bin', [MUSE_META_API_KEY_ENV]: 'sk-live-secret' }
    const env = buildMuseSeatEnv(original, homes)
    expect(env[MUSE_META_API_KEY_ENV]).toBeUndefined()
    expect(museMetaApiKeyScrubbed(env)).toBe(true)
    expect(original[MUSE_META_API_KEY_ENV]).toBe('sk-live-secret')
  })

  it('can retain META_API_KEY when scrubMetaApiKey is false', () => {
    const env = buildMuseSeatEnv({ [MUSE_META_API_KEY_ENV]: 'sk-keep' }, homes, {
      scrubMetaApiKey: false
    })
    expect(env[MUSE_META_API_KEY_ENV]).toBe('sk-keep')
  })

  it('can omit MUSE_NO_AUTO_UPDATE when explicitly disabled', () => {
    const env = buildMuseSeatEnv({ MUSE_NO_AUTO_UPDATE: '0' }, homes, {
      museNoAutoUpdate: false
    })
    expect(env.MUSE_NO_AUTO_UPDATE).toBe('0')
  })
})
