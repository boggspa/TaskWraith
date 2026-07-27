import { describe, expect, it } from 'vitest'
import {
  PI_READ_ONLY_TOOLS,
  PI_WRITE_TOOLS,
  buildPiProcessEnv,
  buildPiRpcArgs
} from './PiCliArgs'
import { PI_ENSEMBLE_COORDINATION_TOOL_NAMES } from './PiEnsembleCoordination'

describe('buildPiRpcArgs', () => {
  const base = {
    upstream: 'deepseek',
    modelId: 'deepseek-v4-flash',
    sessionDir: '/tmp/pi-sessions/chat-1'
  }

  it('pins the containment flags on every spawn', () => {
    const args = buildPiRpcArgs({ ...base, writeCapable: false })
    for (const flag of [
      '--mode',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-approve',
      '--offline'
    ]) {
      expect(args, flag).toContain(flag)
    }
    expect(args[args.indexOf('--mode') + 1]).toBe('rpc')
    expect(args[args.indexOf('--provider') + 1]).toBe('deepseek')
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek-v4-flash')
  })

  it('maps posture to the tool allowlist', () => {
    const readOnly = buildPiRpcArgs({ ...base, writeCapable: false })
    expect(readOnly[readOnly.indexOf('--tools') + 1]).toBe(PI_READ_ONLY_TOOLS.join(','))
    expect(readOnly[readOnly.indexOf('--tools') + 1]).not.toContain('bash')
    expect(readOnly[readOnly.indexOf('--tools') + 1]).not.toContain('write')

    const write = buildPiRpcArgs({ ...base, writeCapable: true })
    expect(write[write.indexOf('--tools') + 1]).toBe(PI_WRITE_TOOLS.join(','))
  })

  it('uses session-dir + session-id for durable chats and --no-session for ephemeral lanes', () => {
    const durable = buildPiRpcArgs({ ...base, writeCapable: false, sessionId: 'chat-abc' })
    expect(durable[durable.indexOf('--session-dir') + 1]).toBe(base.sessionDir)
    expect(durable[durable.indexOf('--session-id') + 1]).toBe('chat-abc')
    expect(durable).not.toContain('--no-session')

    const ephemeral = buildPiRpcArgs({ ...base, writeCapable: false, ephemeralSession: true })
    expect(ephemeral).toContain('--no-session')
    expect(ephemeral).not.toContain('--session-dir')
    expect(ephemeral).not.toContain('--session-id')
  })

  it('threads thinking level and system-prompt suffix when provided', () => {
    const args = buildPiRpcArgs({
      ...base,
      writeCapable: true,
      thinkingLevel: 'high',
      appendSystemPrompt: 'TaskWraith preamble'
    })
    expect(args[args.indexOf('--thinking') + 1]).toBe('high')
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('TaskWraith preamble')

    const bare = buildPiRpcArgs({ ...base, writeCapable: true })
    expect(bare).not.toContain('--thinking')
    expect(bare).not.toContain('--append-system-prompt')
  })

  it('keeps discovery disabled while allowing only an explicit TaskWraith coordination extension', () => {
    const extensionPath = '/tmp/taskwraith-pi-home/coordination.mjs'
    const args = buildPiRpcArgs({
      ...base,
      writeCapable: false,
      coordinationExtensionPath: extensionPath,
      coordinationToolNames: PI_ENSEMBLE_COORDINATION_TOOL_NAMES
    })
    expect(args).toContain('--no-extensions')
    expect(args[args.indexOf('--extension') + 1]).toBe(extensionPath)
    const tools = args[args.indexOf('--tools') + 1].split(',')
    expect(tools).toEqual([...PI_READ_ONLY_TOOLS, ...PI_ENSEMBLE_COORDINATION_TOOL_NAMES])
  })

  it('refuses a custom coordination allowlist without its explicit extension', () => {
    expect(() =>
      buildPiRpcArgs({
        ...base,
        writeCapable: false,
        coordinationToolNames: PI_ENSEMBLE_COORDINATION_TOOL_NAMES
      })
    ).toThrow(/extension path/i)
    expect(() =>
      buildPiRpcArgs({ ...base, writeCapable: false, coordinationExtensionPath: '/tmp/extension.mjs' })
    ).toThrow(/allowlist/i)
  })
})

describe('buildPiProcessEnv', () => {
  it('pins isolated home, telemetry-off, and offline switches', () => {
    const env = buildPiProcessEnv({
      credentialEnv: { PATH: '/usr/bin', DEEPSEEK_API_KEY: 'k' },
      isolatedHomeDir: '/tmp/pi-home-run1'
    })
    expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/pi-home-run1')
    expect(env.PI_TELEMETRY).toBe('0')
    expect(env.PI_SKIP_VERSION_CHECK).toBe('1')
    expect(env.PI_OFFLINE).toBe('1')
    expect(env.DEEPSEEK_API_KEY).toBe('k')
    expect(env.PATH).toBe('/usr/bin')
  })
})
