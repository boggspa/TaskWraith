import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAgyHookBridgeNamedHook,
  createAgyHookBridgeToken,
  startAgyHookBridgeServer,
  type AgyHookBridgeServer
} from './AntigravityHookBridge'

const servers: AgyHookBridgeServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function startServer(): Promise<AgyHookBridgeServer> {
  const server = await startAgyHookBridgeServer()
  servers.push(server)
  return server
}

function post(port: number, body: unknown, token?: string): Promise<Record<string, unknown>> {
  return fetch(`http://127.0.0.1:${port}/agy/pretooluse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-TaskWraith-Hook-Token': token } : {})
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  }).then(async (response) => {
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  })
}

describe('buildAgyHookBridgeNamedHook', () => {
  it('emits the documented named-hook shape with an injection-proof command', () => {
    const token = createAgyHookBridgeToken()
    const { hookName, namedHook } = buildAgyHookBridgeNamedHook({ port: 43210, token })
    expect(hookName).toBe('taskwraith-approval-bridge')
    const groups = namedHook.PreToolUse as Array<Record<string, unknown>>
    expect(groups).toHaveLength(1)
    expect(groups[0].matcher).toBe('run_command')
    const hooks = groups[0].hooks as Array<Record<string, unknown>>
    expect(hooks).toHaveLength(1)
    expect(hooks[0].type).toBe('command')
    expect(hooks[0].timeout).toBe(600)
    const command = hooks[0].command as string
    expect(command).toContain(`http://127.0.0.1:43210/agy/pretooluse`)
    expect(command).toContain(token)
    // Every curl failure must resolve to the no-decision object.
    expect(command).toContain('|| printf {}')
  })

  it('rejects invalid ports and non-hex tokens so no untrusted text reaches the shell line', () => {
    const token = createAgyHookBridgeToken()
    expect(() => buildAgyHookBridgeNamedHook({ port: 0, token })).toThrow()
    expect(() => buildAgyHookBridgeNamedHook({ port: 1.5, token })).toThrow()
    expect(() => buildAgyHookBridgeNamedHook({ port: 4321, token: "abc'; rm -rf /" })).toThrow()
  })
})

describe('startAgyHookBridgeServer', () => {
  const toolCallBody = (command: string) => ({
    toolCall: { name: 'run_command', args: { CommandLine: command } },
    stepIdx: 3
  })

  it('maps gate decisions for a registered token and stays no-decision for everything else', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    const seen: string[] = []
    const unregister = server.registerRun(token, async (toolCall) => {
      // Mirrors the production handler: only run_command with a command
      // string is arbitrated; everything else defers to agy-native flow.
      if (toolCall.name !== 'run_command' || !toolCall.command) return { decision: 'none' }
      seen.push(toolCall.command)
      return toolCall.command === 'git log --oneline'
        ? { decision: 'allow' }
        : { decision: 'deny', reason: 'tier declined' }
    })

    await expect(post(server.port, toolCallBody('git log --oneline'), token)).resolves.toEqual({
      decision: 'allow'
    })
    await expect(post(server.port, toolCallBody('rm -rf build'), token)).resolves.toEqual({
      decision: 'deny',
      reason: 'tier declined'
    })
    // Missing/unknown token → {} (fail-safe: agy-native flow).
    await expect(post(server.port, toolCallBody('git log'), undefined)).resolves.toEqual({})
    await expect(
      post(server.port, toolCallBody('git log'), createAgyHookBridgeToken())
    ).resolves.toEqual({})
    // Malformed body / non-command tool → {}.
    await expect(post(server.port, 'not json', token)).resolves.toEqual({})
    await expect(
      post(server.port, { toolCall: { name: 'write_file', args: {} } }, token)
    ).resolves.toEqual({})
    expect(seen).toEqual(['git log --oneline', 'rm -rf build'])

    unregister()
    await expect(post(server.port, toolCallBody('git log'), token)).resolves.toEqual({})
  })

  it('resolves to no-decision when the gate handler itself throws', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    server.registerRun(token, async () => {
      throw new Error('gate exploded')
    })
    await expect(post(server.port, toolCallBody('git status'), token)).resolves.toEqual({})
  })

  it('lets the handler return none to defer to the agy-native flow', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    server.registerRun(token, async () => ({ decision: 'none' }))
    await expect(post(server.port, toolCallBody('git status'), token)).resolves.toEqual({})
  })

  it('refuses duplicate or malformed token registration', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    const release = server.registerRun(token, async () => ({ decision: 'none' }))
    expect(() => server.registerRun(token, async () => ({ decision: 'none' }))).toThrow()
    expect(() => server.registerRun('short', async () => ({ decision: 'none' }))).toThrow()
    release()
    const rearm = server.registerRun(token, async () => ({ decision: 'none' }))
    rearm()
  })
})
