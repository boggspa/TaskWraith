import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAgyHookBridgeNamedHook,
  classifyAgyHookTool,
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
    // Matches EVERY tool. agy's matcher is a regex and its tool namespace
    // belongs to an auto-updating external binary — a finite allowlist that
    // misses one name (this shipped matching only `run_command`, while the
    // tool that got denied was `Edit`) turns into a fatal, silent auto-deny.
    // The handler decides per tool; unknown tools defer to the native flow.
    expect(groups[0].matcher).toBe('.*')
    const hooks = groups[0].hooks as Array<Record<string, unknown>>
    expect(hooks).toHaveLength(1)
    expect(hooks[0].type).toBe('command')
    expect(hooks[0].timeout).toBe(3_630)
    const command = hooks[0].command as string
    expect(command).toContain('--max-time 3620')
    expect(command).toContain(`http://127.0.0.1:43210/agy/pretooluse`)
    expect(command).toContain(token)
    // A bridge that cannot answer must DENY, never defer. agy's settings layer
    // is deliberately opened for the services this hook arbitrates (its
    // `allow` decision alone grants nothing — measured), so falling back to
    // `{}` would hand the call straight to that opened layer, unreviewed.
    expect(command).not.toContain('|| printf {}')
    const fallback = command.slice(command.indexOf('|| printf ') + '|| printf '.length)
    expect(JSON.parse(fallback.replace(/^'|'$/g, ''))).toMatchObject({ decision: 'deny' })
  })

  it('rejects invalid ports and non-hex tokens so no untrusted text reaches the shell line', () => {
    const token = createAgyHookBridgeToken()
    expect(() => buildAgyHookBridgeNamedHook({ port: 0, token })).toThrow()
    expect(() => buildAgyHookBridgeNamedHook({ port: 1.5, token })).toThrow()
    expect(() => buildAgyHookBridgeNamedHook({ port: 4321, token: "abc'; rm -rf /" })).toThrow()
  })
})

/* MEASURED 2026-08-06 by driving the real agy binary with a `.*` PreToolUse
 * hook that logged every payload. The names below are what agy actually sends
 * — NOT the names in its help text or its confirmation UI. That distinction is
 * the whole bug: agy's confirmation manager logs the denied tool as "Edit" and
 * its permission layer calls it "write_file", but the hook payload says
 * `write_to_file`. An allowlist built from either of the other two namespaces
 * silently misses every real mutation, which is why classification is a shape
 * test over the name and the matcher subscribes to everything. */
describe('classifyAgyHookTool', () => {
  it('routes the observed shell tool to the shell gate', () => {
    expect(classifyAgyHookTool('run_command')).toBe('shell')
    expect(classifyAgyHookTool('run_terminal_command')).toBe('shell')
  })

  it('routes the observed mutation tool, and unseen spellings, to the file-changes gate', () => {
    // `write_to_file` is the one agy really sends; the rest guard the arc
    // against a rename in a future auto-update.
    for (const name of [
      'write_to_file',
      'Edit',
      'MultiEdit',
      'create_file',
      'replace_file_content',
      'delete_file',
      'rename_file',
      'apply_patch'
    ]) {
      expect(classifyAgyHookTool(name), name).toBe('write')
    }
  })

  it('routes the MCP transport to the mcp gate, never the write heuristic', () => {
    // agy carries every MCP call through one transport tool; the inner tool
    // name rides the args. Classifying it 'other' was measured to strand the
    // whole registered TaskWraith surface behind agy's headless auto-deny.
    expect(classifyAgyHookTool('call_mcp_tool')).toBe('mcp')
    expect(classifyAgyHookTool('use_mcp_tool')).toBe('mcp')
    expect(classifyAgyHookTool('CALL_MCP_TOOL')).toBe('mcp')
    // Non-transport MCP-ish names keep their ordinary classification.
    expect(classifyAgyHookTool('list_resources')).toBe('other')
  })

  it('leaves the observed read tools to the agy-native flow', () => {
    for (const name of ['view_file', 'list_dir', 'grep_search', 'codebase_search', 'Read']) {
      expect(classifyAgyHookTool(name), name).toBe('other')
    }
  })
})

describe('startAgyHookBridgeServer', () => {
  const toolCallBody = (command: string) => ({
    toolCall: { name: 'run_command', args: { CommandLine: command } },
    stepIdx: 3
  })

  it('surfaces the target path of a mutation so the approval card can name it', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    const seen: Array<{ name: string; path: string | null }> = []
    server.registerRun(token, async (toolCall) => {
      seen.push({ name: toolCall.name, path: toolCall.targetPath })
      return { decision: 'allow' }
    })

    // `TargetFile` is what real `write_to_file` calls carry (measured);
    // `AbsolutePath` is what `view_file` carries. The rest are accepted so an
    // arg rename does not silently produce unnamed approval cards.
    await post(
      server.port,
      { toolCall: { name: 'write_to_file', args: { TargetFile: '/repo/src/a.ts' } } },
      token
    )
    await post(
      server.port,
      { toolCall: { name: 'view_file', args: { AbsolutePath: '/repo/src/b.ts' } } },
      token
    )
    await post(
      server.port,
      { toolCall: { name: 'write_to_file', args: { file_path: '/repo/c.ts' } } },
      token
    )
    expect(seen).toEqual([
      { name: 'write_to_file', path: '/repo/src/a.ts' },
      { name: 'view_file', path: '/repo/src/b.ts' },
      { name: 'write_to_file', path: '/repo/c.ts' }
    ])
  })

  it('surfaces the MCP server and inner tool so the decision layer can route', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    const seen: Array<{ server: string | null; tool: string | null }> = []
    server.registerRun(token, async (toolCall) => {
      seen.push({ server: toolCall.mcpServerName ?? null, tool: toolCall.mcpToolName ?? null })
      return { decision: 'allow' }
    })

    await post(
      server.port,
      {
        toolCall: {
          name: 'call_mcp_tool',
          args: { ServerName: 'TaskWraith', ToolName: 'goal_read' }
        }
      },
      token
    )
    // agy 1.1.12-style JSON-quoted scalars decode exactly one layer.
    await post(
      server.port,
      {
        toolCall: {
          name: 'call_mcp_tool',
          args: { server_name: '"sqlite-helper"', tool_name: '"query"' }
        }
      },
      token
    )
    // A serverless call still reaches the handler; attribution is its job.
    await post(server.port, { toolCall: { name: 'call_mcp_tool', args: {} } }, token)
    expect(seen).toEqual([
      { server: 'TaskWraith', tool: 'goal_read' },
      { server: 'sqlite-helper', tool: 'query' },
      { server: null, tool: null }
    ])
  })

  it('extracts mutation arguments (TargetContent, ReplacementContent, CodeContent) for diff derivation', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    const seen: Array<{
      name: string
      targetPath: string | null
      oldString?: string
      newString?: string
      content?: string
    }> = []
    server.registerRun(token, async (toolCall) => {
      seen.push({
        name: toolCall.name,
        targetPath: toolCall.targetPath,
        oldString: toolCall.oldString,
        newString: toolCall.newString,
        content: toolCall.content
      })
      return { decision: 'allow' }
    })

    await post(
      server.port,
      {
        toolCall: {
          name: 'replace_file_content',
          args: {
            TargetFile: '"/repo/src/App.tsx"',
            TargetContent: '"const oldCode = 1;"',
            ReplacementContent: '"const newCode = 2;"'
          }
        }
      },
      token
    )

    await post(
      server.port,
      {
        toolCall: {
          name: 'write_to_file',
          args: {
            TargetFile: '/repo/src/newFile.ts',
            CodeContent: 'console.log("hello world")'
          }
        }
      },
      token
    )

    expect(seen).toEqual([
      {
        name: 'replace_file_content',
        targetPath: '/repo/src/App.tsx',
        oldString: 'const oldCode = 1;',
        newString: 'const newCode = 2;',
        content: undefined
      },
      {
        name: 'write_to_file',
        targetPath: '/repo/src/newFile.ts',
        oldString: undefined,
        newString: undefined,
        content: 'console.log("hello world")'
      }
    ])
  })

  it('decodes the JSON-quoted scalar args emitted by agy 1.1.12 before policy checks', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    const seen: Array<{ command: string | null; path: string | null }> = []
    server.registerRun(token, async (toolCall) => {
      seen.push({ command: toolCall.command, path: toolCall.targetPath })
      return toolCall.command === 'git status --porcelain'
        ? { decision: 'allow' }
        : { decision: 'none' }
    })

    await expect(
      post(
        server.port,
        {
          toolCall: {
            name: 'run_command',
            args: {
              CommandLine: '"git status --porcelain"',
              Cwd: '"/repo"'
            }
          }
        },
        token
      )
    ).resolves.toEqual({ decision: 'allow' })
    await post(
      server.port,
      {
        toolCall: {
          name: 'write_to_file',
          args: { TargetFile: '"/repo/src/a.ts"' }
        }
      },
      token
    )

    expect(seen).toEqual([
      { command: 'git status --porcelain', path: null },
      { command: null, path: '/repo/src/a.ts' }
    ])
  })

  it('arbitrates a mutation tool that carries no recognisable path', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    server.registerRun(token, async (toolCall) =>
      toolCall.name === 'write_to_file'
        ? { decision: 'deny', reason: 'plan mode' }
        : { decision: 'none' }
    )
    await expect(
      post(server.port, { toolCall: { name: 'write_to_file', args: {} } }, token)
    ).resolves.toEqual({ decision: 'deny', reason: 'plan mode' })
  })

  it('maps gate decisions, fails closed on invalid requests, and preserves deliberate none', async () => {
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
    // The settings lease may have opened command(*), so requests that cannot
    // reach their registered TaskWraith gate must deny rather than fall through.
    await expect(post(server.port, toolCallBody('git log'), undefined)).resolves.toMatchObject({
      decision: 'deny'
    })
    await expect(
      post(server.port, toolCallBody('git log'), createAgyHookBridgeToken())
    ).resolves.toMatchObject({ decision: 'deny' })
    // Malformed body denies. A valid tool the registered handler deliberately
    // declines to arbitrate still returns {} and follows agy's native rules.
    await expect(post(server.port, 'not json', token)).resolves.toMatchObject({
      decision: 'deny'
    })
    await expect(
      post(server.port, { toolCall: { name: 'view_file', args: {} } }, token)
    ).resolves.toEqual({})
    expect(seen).toEqual(['git log --oneline', 'rm -rf build'])

    unregister()
    await expect(post(server.port, toolCallBody('git log'), token)).resolves.toMatchObject({
      decision: 'deny'
    })
  })

  it('denies when the gate handler itself throws', async () => {
    const server = await startServer()
    const token = createAgyHookBridgeToken()
    server.registerRun(token, async () => {
      throw new Error('gate exploded')
    })
    await expect(post(server.port, toolCallBody('git status'), token)).resolves.toMatchObject({
      decision: 'deny'
    })
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
