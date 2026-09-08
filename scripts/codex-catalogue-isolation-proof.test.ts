[read_file: lines 1-920 of 920]
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const common = require('./codex-proof/common.cjs')
const planModule = require('./codex-proof/plan.cjs')
const protocol = require('./codex-proof/protocol.cjs')
const proxy = require('./codex-proof/proxy.cjs')
const runtime = require('./codex-proof/runtime.cjs')
const runner = require('./codex-proof/runner.cjs')
const entry = require('./codex-catalogue-isolation-proof.cjs')
const temporary: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'codex-proof-test-')))
  temporary.push(root)
  const home = path.join(root, 'app-a', 'codex-home')
  const secondHome = path.join(root, 'app-b', 'codex-home')
  const output = path.join(root, 'evidence')
  const source = path.join(root, 'source')
  for (const directory of [home, secondHome, output, source])
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(home, 'auth.json'), '{}', { mode: 0o600 })
  writeFileSync(path.join(secondHome, 'auth.json'), '{}', { mode: 0o600 })
  const manifest = planModule.defaults({
    workspace: root,
    outputDir: output,
    codeHome: home,
    bridgeCommand: '/real/test/bridge',
    models: ['model-a', 'model-b'],
    runtimes: [
      { id: 'a', binary: 'codex', env: {} },
      { id: 'b', binary: 'codex-b', env: {} }
    ],
    routes: Object.fromEntries(
      ['solo', 'ensemble', 'mesh'].map((role) => [
        role,
        Object.fromEntries(
          ['fresh', 'resume', 'retained'].map((phase) => [
            phase,
            { appRunId: role + '-' + phase, appChatId: role + '-chat' }
          ])
        )
      ])
    ),
    directCall: { name: 'read_file', arguments: { path: 'fixture.txt' }, readOnly: true },
    permissionCall: {
      name: 'apply_patch',
      arguments: { check: true, patch: 'a valid dry-run patch' }
    }
  })
  manifest.secondInstance = {
    endpoint: {
      ...manifest.endpoint,
      instanceEpoch: 'b'.repeat(32),
      socketPath: '/second/app/broker.sock'
    }
  }
  manifest.routePostures = {}
  manifest.mixedPermissionRoutes = {}
  for (const [index, role] of ['solo', 'ensemble', 'mesh'].entries()) {
    manifest.mixedPermissionRoutes[role] = {}
    for (const phase of ['fresh', 'resume', 'retained']) {
      manifest.routePostures[role + '-' + phase] = {
        presetId: 'read_only',
        evidenceRef: 'fake-ledger-reference'
      }
      manifest.mixedPermissionRoutes[role][phase] = {
        appRunId: role + '-' + phase + '-mixed',
        appChatId: role + '-chat'
      }
      manifest.routePostures[role + '-' + phase + '-mixed'] = {
        presetId: index % 2 ? 'workspace_write' : 'read_only',
        evidenceRef: 'fake-ledger-reference'
      }
    }
  }
  writeFileSync(path.join(output, 'events.jsonl'), '', { mode: 0o600 })
  const options = {
    live: true,
    iHaveCredentials: true,
    reuseExistingLogin: false,
    codeHome: home,
    outputDir: output,
    timeoutMs: 100,
    secondCodeHome: secondHome
  }
  return { root, home, secondHome, output, source, manifest, options }
}

function sourceArgvBuilder() {
  const source = readFileSync(path.join(common.ROOT, 'src/main/CodexAppServerClient.ts'), 'utf8')
  const tree = ts.createSourceFile('client.ts', source, ts.ScriptTarget.Latest, true)
  const names = [
    'tomlEscapeString',
    'isTomlBareKeyComponent',
    'formatTomlInlineStringTable',
    'buildCodexTaskWraithMcpArgs'
  ]
  const declarations = tree.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || '')
  )
  expect(declarations).toHaveLength(4)
  const compiled = ts.transpileModule(declarations.map((node) => node.getText(tree)).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS }
  }).outputText
  const exports: Record<string, unknown> = {}
  vm.runInNewContext(compiled, { exports })
  return exports.buildCodexTaskWraithMcpArgs as (config: unknown) => string[]
}

describe('native catalogue proof plan', () => {
  it('covers every axis, all three seats/lifecycles and both special experiments', () => {
    const plan = planModule.createProofPlan()
    expect(plan.cases).toHaveLength(64)
    expect(new Set(plan.cases.map((item: { id: string }) => item.id)).size).toBe(64)
    for (const item of plan.cases) {
      expect(item.seats.map((seat: { role: string }) => seat.role)).toEqual([
        'solo',
        'ensemble',
        'mesh'
      ])
      for (const seat of item.seats)
        expect(seat.lifecycles.map((phase: { lifecycle: string }) => phase.lifecycle)).toEqual([
          'fresh',
          'resume',
          'retained'
        ])
      expect(Object.keys(item.observables)).toEqual([
        'P1',
        'P2',
        'P3',
        'P4',
        'P5',
        'permission',
        'brokerRestart',
        'dualInstance'
      ])
    }
    expect(plan.specialCases[0].daemon.args[0]).toBe('app-server')
    expect(plan.specialCases[1].instances[0].daemon.env.CODEX_HOME).not.toBe(
      plan.specialCases[1].instances[1].daemon.env.CODEX_HOME
    )
    expect(plan.specialCases.map((item: { id: string }) => item.id)).toEqual([
      'broker-restart',
      'dual-instance'
    ])
    for (const field of ['mixedModels', 'mixedPermissions', 'bridgeEnabled', 'perThreadArgs']) {
      expect(new Set(plan.cases.map((item: Record<string, unknown>) => item[field]))).toEqual(
        new Set([true, false])
      )
    }
    expect(new Set(plan.cases.map((item: { runtimeIndex: number }) => item.runtimeIndex))).toEqual(
      new Set([0, 1])
    )
  })

  it('default and explicit plan never spawn, acquire credentials, or load the live runner', async () => {
    const spawns = [
      'spawn',
      'spawnSync',
      'exec',
      'execFile',
      'execSync',
      'execFileSync',
      'fork'
    ].map((name) =>
      vi.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error('must not spawn')
      })
    )
    const runLive = vi.fn()
    for (const args of [[], ['--plan']]) {
      const output = vi.fn()
      const plan = await entry.main(args, { output, runner: { runLive } })
      expect(plan.executed).toBe(false)
      expect(JSON.parse(output.mock.calls[0][0]).cases).toHaveLength(64)
      expect(output.mock.calls[0][0].includes('f'.repeat(64))).toBe(false)
    }
    for (const spy of spawns) expect(spy).not.toHaveBeenCalled()
    expect(runLive).not.toHaveBeenCalled()
  })

  it('copies the app argv builder exactly without importing its Electron graph', () => {
    const original = sourceArgvBuilder()
    const config = {
      enabled: true,
      bridgeBinaryPath: 'C:\\some "path"\nbridge',
      bridgeArgs: ['--x', 'a\tb\r\n"\\'],
      parentProvider: 'codex',
      userMcpServers: [
        {
          transport: 'http',
          serverName: 'http_1',
          url: 'https://example.invalid/a',
          bearerTokenEnvVar: 'TOKEN',
          headers: { 'X-"key': 'a\\b\tc' }
        },
        {
          transport: 'stdio',
          serverName: 'stdio_1',
          command: 'some"command',
          args: ['a\nb'],
          env: { NORMAL: 'escaped"\t' }
        },
        { transport: 'stdio', serverName: 'invalid.key', command: 'no', args: [] },
        { transport: 'unknown', serverName: 'ignored' }
      ]
    }
    expect(planModule.buildCodexTaskWraithMcpArgs(config)).toEqual(original(config))
    expect(planModule.buildCodexTaskWraithMcpArgs({ ...config, enabled: false })).toEqual(
      original({ ...config, enabled: false })
    )
  })

  it('reuses static argv and per-thread route/profile helpers without Electron', () => {
    const route = common.loadHelper('src/main/mcp/McpBridgeRoute.ts')
    const profiles = planModule.profiles()
    const manifest = planModule.defaults()
    expect(planModule.bridgeArgs('route-env', manifest.endpoint, profiles[0])).toEqual(
      route.buildStaticMcpBridgeRegistrationArgv()
    )
    const env = planModule.routeEnvironment(manifest, 'solo', 'fresh', profiles[0])
    const parsed = route.parseMcpBridgeRouteFromEnv(env)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.route.appRunId).toBe('proof-solo-fresh')
    expect(parsed.value.route.appChatId).toBe('proof-solo')
    expect(env.TASKWRAITH_MCP_SOLO_SUBSET).toBe('1')
    expect(planModule.bridgeArgs('direct', manifest.endpoint, profiles[0])).toContain(
      '--solo-subset'
    )
    expect(() => common.loadHelper('src/main/CodexAppServerClient.ts')).toThrow('unapproved')
    expect(() => common.loadHelper('src/main/codex/CodexOAuthCredentialLease.ts')).toThrow(
      'live-only'
    )
    expect(
      common.loadHelper('src/main/codex/CodexOAuthCredentialLease.ts', true)
        .acquireCodexOAuthCredentialLease
    ).toBeTypeOf('function')
  })

  it('separates daemon args from override tags and rotates the requested resume profile', () => {
    const plan = planModule.createProofPlan()
    const item = plan.cases.find(
      (item: Record<string, unknown>) => item.perThreadArgs && item.bridgeEnabled
    )
    const solo = item.seats[0]
    expect(solo.lifecycles[0].requestedProfileId).not.toEqual(solo.lifecycles[1].requestedProfileId)
    for (const phase of solo.lifecycles) {
      expect(phase.config['mcp_servers.TaskWraith.args']).toContain('solo-' + phase.lifecycle)
      expect(
        common.fingerprint(proxy.observedEnvironment(phase.config['mcp_servers.TaskWraith.env']))
      ).toEqual(phase.expectedEnvSha256)
    }
    const disabled = plan.cases.find((item: Record<string, unknown>) => !item.bridgeEnabled)
    expect(disabled.daemon.args.join(' ')).not.toContain('mcp_servers.TaskWraith')
    expect(disabled.seats[0].lifecycles[0].config).toEqual({})
  })

  it('rejects malformed modes before reading credentials or launching anything', async () => {
    const readManifest = vi.fn()
    await expect(entry.main(['--live'], { readManifest })).rejects.toThrow('live_requires')
    expect(readManifest).not.toHaveBeenCalled()
    expect(() => entry.parseArgs(['--live', '--plan'])).toThrow('conflicting')
    expect(() => entry.parseArgs(['--code-home'])).toThrow('missing')
    expect(() => entry.parseArgs(['--timeout-ms', 'NaN'])).toThrow('timeout')
    expect(() => entry.parseArgs(['--unknown'])).toThrow('unknown')
  })
})

describe('redacted evidence and live boundaries', () => {
  it('redacts secret env values, inline/escaped tokens and external paths without erasing outcome fields', () => {
    const secret = 'a"b\\c/secret'
    const redact = common.createRedactor({ secrets: [secret], paths: ['/private/user/codex-home'] })
    const result = redact({
      env: { MY_SECRET: 'secret1', SOME_TOKEN: 'secret2', MONKEY: 'secret3', API_KEY: 'secret4' },
      argv: [
        '--token',
        secret,
        JSON.stringify(secret),
        'mcp="C:\\external\\auth.json"',
        '/Users/example/file'
      ],
      details: 'home=/private/user/codex-home/state data=/some/other/path',
      credentialOutcome: 'busy',
      brokerCredentialFound: true
    })
    const text = JSON.stringify(result)
    for (const value of [
      'secret1',
      'secret2',
      'secret3',
      'secret4',
      secret,
      '/Users/example',
      '/some/other',
      'external',
      '/private/user'
    ]) {
      expect(text).not.toContain(value)
    }
    expect(result.credentialOutcome).toBe('busy')
    expect(result.brokerCredentialFound).toBe(true)
  })

  it('requires explicit credential consent, private homes and non-mutating permission probes', () => {
    const f = fixture()
    expect(runtime.validateLive(f.options, f.manifest).home).toBe(f.home)
    expect(() =>
      runtime.validateLive({ ...f.options, iHaveCredentials: false }, f.manifest)
    ).toThrow('ack')
    expect(() => runtime.validateLive({ ...f.options, loginSource: f.source }, f.manifest)).toThrow(
      'reuse_consent'
    )
    expect(() =>
      runtime.validateLive(f.options, {
        ...f.manifest,
        permissionCall: { name: 'apply_patch', arguments: {} }
      })
    ).toThrow('dry_run')
    expect(() => runtime.validateLive(f.options, { ...f.manifest, routes: {} })).toThrow(
      'explicit_live_route'
    )
    expect(() =>
      runtime.validateLive(f.options, {
        ...f.manifest,
        runtimes: [
          { id: 'bad', binary: 'codex', env: { CODEX_HOME: '/escape' } },
          f.manifest.runtimes[1]
        ]
      })
    ).toThrow('override_home')
    writeFileSync(
      path.join(f.home, 'config.toml'),
      '[mcp_servers.unrelated]\ncommand="do-not-spawn"',
      { mode: 0o600 }
    )
    expect(() => runtime.validateLive(f.options, f.manifest)).toThrow('existing_mcp')
  })

  it('does not inherit API keys, Codex state overrides or unrelated profile variables', () => {
    expect(
      runtime.launchEnvironment(
        { CODEX_HOME: '/explicit' },
        {
          PATH: '/bin',
          CODEX_HOME: '/wrong',
          OPENAI_API_KEY: 'secret',
          TASKWRAITH_MCP_TOKEN: 'secret'
        }
      )
    ).toEqual({ PATH: '/bin', CODEX_HOME: '/explicit' })
  })

  it('refuses symlink home and overlapping evidence/native state', () => {
    const f = fixture()
    const link = path.join(f.root, 'alias')
    symlinkSync(f.home, link)
    expect(() => runtime.validateLive({ ...f.options, codeHome: link }, f.manifest)).toThrow(
      'nonsymlink'
    )
    const child = path.join(f.home, 'evidence')
    mkdirSync(child, { mode: 0o700 })
    expect(() => runtime.validateLive({ ...f.options, outputDir: child }, f.manifest)).toThrow(
      'disjoint'
    )
  })

  it('seeds only through the canonical lease, notes the PID, then releases idempotently', async () => {
    const f = fixture()
    const calls: unknown[] = []
    const credentials = {
      acquireCodexOAuthCredentialLease: vi.fn(async (input) => {
        calls.push(input)
        return {
          ok: true,
          lease: {
            seedIntoIsolatedHome: async () => calls.push('seed'),
            noteProviderProcess: async (pid: number) => calls.push(pid),
            commitAndRelease: async () => {
              calls.push('release')
              return { status: 'committed' }
            }
          }
        }
      })
    }
    const held = await runtime.acquireHome(
      { ...f.options, reuseExistingLogin: true, loginSource: f.source },
      { credentials }
    )
    expect(calls).toEqual([{ userDataPath: path.dirname(f.home), sourceHome: f.source }, 'seed'])
    await held.noteProviderProcess(99)
    await held.release()
    await held.release()
    expect(calls.slice(1)).toEqual(['seed', 99, 'release'])
    expect(existsSync(path.join(f.home, '.taskwraith-proof.lock'))).toBe(false)
  })

  it('does not adopt an existing proof lock or turn a busy authority into a copy fallback', async () => {
    const f = fixture()
    const held = await runtime.acquireHome(f.options)
    await expect(runtime.acquireHome(f.options)).rejects.toThrow()
    await held.release()
    const credentials = {
      acquireCodexOAuthCredentialLease: vi.fn(async () => ({ ok: false, reason: 'busy' }))
    }
    expect(
      await runtime.acquireHome(
        { ...f.options, reuseExistingLogin: true, loginSource: f.source },
        { credentials }
      )
    ).toEqual({ ok: false, reason: 'busy' })
    expect(readFileSync(path.join(f.home, 'auth.json'), 'utf8')).toBe('{}')
  })

  it('scans native byte persistence without reading credentials and never passes a negative', () => {
    const f = fixture()
    writeFileSync(path.join(f.home, 'auth.json'), 'AUTH_ONLY_TOKEN', { mode: 0o600 })
    writeFileSync(
      path.join(f.home, 'state.sqlite-wal'),
      Buffer.from('native\0BROKER_TOKEN\0route-a')
    )
    const evidence = runtime.scanNativeState(f.home, {
      auth: 'AUTH_ONLY_TOKEN',
      brokerCredential: 'BROKER_TOKEN',
      route: 'route-a'
    })
    expect(evidence.matches).toEqual([
      { nativeRelativePath: 'state.sqlite-wal', found: ['brokerCredential', 'route'] }
    ])
    expect(JSON.stringify(evidence)).not.toContain('BROKER_TOKEN')
    expect(evidence.status).toBe('observed')
    expect(runtime.scanNativeState(f.home, { absent: 'not-there' }).status).toBe('inconclusive')
    expect(
      runtime.scanNativeState(f.home, { brokerCredential: 'BROKER_TOKEN' }, { maxBytes: 3 })
        .censored
    ).toBe(true)
  })

  it('fingerprints the installed schema/version and removes raw generated JSON even on failure', async () => {
    const f = fixture()
    const execute = vi.fn(async (_binary: string, args: string[]) => {
      if (args[0] === '--version') return { stdout: 'codex-test-version\n' }
      writeFileSync(
        path.join(args.at(-1)!, 'Tool.json'),
        JSON.stringify({ type: 'object', properties: { threadId: {} } })
      )
      return { stdout: '' }
    })
    const result = await runtime.nativeSchemas('fake', {}, f.output, execute)
    expect(result.version).toBe('codex-test-version')
    expect(result.index.has('Tool')).toBe(true)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(readdirSync(f.output).filter((name) => name.startsWith('native-schema-'))).toEqual([])
    await expect(
      runtime.nativeSchemas('fake', {}, f.output, async () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    expect(readdirSync(f.output).filter((name) => name.startsWith('native-schema-'))).toEqual([])
  })

  it('writes exclusive redacted files and leaves raw event partial lines unparsed', () => {
    const f = fixture()
    const file = path.join(f.output, 'evidence.json')
    common.writeEvidence(file, { API_KEY: 'secret' }, common.createRedactor())
    expect(readFileSync(file, 'utf8')).not.toContain('secret')
    expect(() => common.writeEvidence(file, {}, common.createRedactor())).toThrow()
    writeFileSync(path.join(f.output, 'events.jsonl'), '{"kind":"ok"}\n{"partial":')
    expect(runtime.readEvents(path.join(f.output, 'events.jsonl'))).toEqual([{ kind: 'ok' }])
  })
})

describe('native wire client and live execution with fakes', () => {
  it('decodes fragmented UTF-8 newline and Content-Length MCP traffic byte-for-byte', () => {
    const frames: unknown[] = []
    const raws: Buffer[] = []
    const body = Buffer.from(JSON.stringify({ result: '☃' }))
    const input = Buffer.concat([
      Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'),
      body,
      Buffer.from('\n{"id":2}\n')
    ])
    const decode = protocol.frameDecoder((value: unknown, raw: Buffer) => {
      frames.push(value)
      raws.push(raw)
    })
    for (const byte of input) decode(Buffer.from([byte]))
    expect(frames.filter(Boolean)).toEqual([{ result: '☃' }, { id: 2 }])
    expect(Buffer.concat(raws)).toEqual(input)
    expect(() => protocol.frameDecoder(() => {}, 3)(Buffer.from('1234'))).toThrow('limit')
  })

  it('relays exact MCP bytes, captures catalogue/call witnesses and releases a held reply', async () => {
    const f = fixture()
    const child = Object.assign(new EventEmitter(), {
      pid: 19,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    })
    const io = Object.assign(new EventEmitter(), {
      pid: 17,
      stdin: new PassThrough(),
      stdout: new PassThrough()
    })
    const inbound: Buffer[] = []
    const outbound: Buffer[] = []
    child.stdin.on('data', (chunk) => inbound.push(chunk))
    io.stdout.on('data', (chunk) => outbound.push(chunk))
    const spawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(child)
    const holdFile = path.join(f.output, 'solo.hold')
    const env = {
      TASKWRAITH_PROOF_ROOT: f.output,
      TASKWRAITH_PROOF_EVENT_FILE: path.join(f.output, 'events.jsonl'),
      TASKWRAITH_PROOF_HOLD_FILE: holdFile,
      TASKWRAITH_RUN_ID: 'actual-run',
      TASKWRAITH_CHAT_ID: 'actual-chat',
      TASKWRAITH_MCP_BROKER_TOKEN: 'private-broker-token'
    }
    proxy.runProxy(
      [
        '--target-command',
        'real-bridge',
        '--argv-tag',
        'solo-fresh',
        '--target-arg',
        '--token',
        '--target-arg',
        'private-broker-token'
      ],
      env,
      io
    )
    const listRequest = '{"id":1,"method":"tools/list"}\n'
    const listReply = '{"id":1,"result":{"tools":[{"name":"read","inputSchema":{}}]}}\n'
    io.stdin.write(listRequest)
    child.stdout.write(listReply)
    expect(Buffer.concat(inbound).toString()).toBe(listRequest)
    expect(Buffer.concat(outbound).toString()).toBe(listReply)
    writeFileSync(holdFile, 'hold')
    io.stdin.write('{"id":2,"method":"tools/call","params":{"name":"read","arguments":{}}}\n')
    const toolReply =
      '{"id":2,"result":{"content":[{"type":"text","text":"private-broker-token"}]}}\n'
    child.stdout.write(toolReply)
    expect(Buffer.concat(outbound).toString()).toBe(listReply)
    expect(
      runtime
        .readEvents(path.join(f.output, 'events.jsonl'))
        .map((event: { kind: string }) => event.kind)
    ).toContain('response-held')
    rmSync(holdFile)
    await new Promise((resolve) => setTimeout(resolve, 35))
    expect(Buffer.concat(outbound).toString()).toBe(listReply + toolReply)
    child.emit('close', 0, null)
    const events = runtime.readEvents(path.join(f.output, 'events.jsonl'))
    expect(events[0]).toMatchObject({
      kind: 'spawn',
      targetPid: 19,
      pid: 17,
      argvTag: 'solo-fresh'
    })
    expect(events.find((event: { kind: string }) => event.kind === 'tool-call').route).toEqual({
      appRunId: 'actual-run',
      appChatId: 'actual-chat'
    })
    expect(readFileSync(path.join(f.output, 'events.jsonl'), 'utf8')).not.toContain(
      'private-broker-token'
    )
    expect(spawn.mock.calls[0][2].shell).toBe(false)
  })

  it('normalizes tool schema fingerprints while preserving schema differences', () => {
    const first = [
      { name: 'b', inputSchema: { type: 'string' } },
      { name: 'a', inputSchema: {} }
    ]
    const same = [
      { name: 'a', input_schema: {}, nativeExtra: 123 },
      { name: 'b', input_schema: { type: 'string' } }
    ]
    expect(protocol.catalogue(first).schemaSha256).toBe(protocol.catalogue(same).schemaSha256)
    expect(protocol.catalogue(first).schemaSha256).not.toBe(
      protocol.catalogue([{ name: 'b', inputSchema: {} }, first[1]]).schemaSha256
    )
  })

  it('binds tool-call shape to installed schemas and rejects unscoped global methods', () => {
    const index = new Map([
      [
        'ClientRequest',
        {
          oneOf: [
            {
              properties: {
                method: { const: 'mcpServer/tool/call' },
                params: {
                  properties: { threadId: {}, serverName: {}, toolName: {}, arguments: {} }
                }
              }
            }
          ]
        }
      ]
    ])
    expect(
      protocol.toolCallParams(index, 'native-id', { name: 'read', arguments: { x: 1 } })
    ).toEqual({
      threadId: 'native-id',
      serverName: 'TaskWraith',
      toolName: 'read',
      arguments: { x: 1 }
    })
    expect(() => protocol.toolCallParams(new Map(), 'id', { name: 'read' })).toThrow('unsupported')
  })

  it('pairs JSON-RPC responses, refuses native approval and confirms closure', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    })
    const sent: Record<string, unknown>[] = []
    child.stdin.on('data', (bytes) => sent.push(JSON.parse(bytes.toString())))
    child.stdin.on('finish', () => child.emit('close', 0, null))
    const spawn = vi.fn(() => child)
    const client = protocol.openAppServer(
      { command: 'fake', args: [], env: {} },
      { spawn, timeoutMs: 100 }
    )
    const pending = client.request('hello', {})
    child.stdout.write('{"id":1,"result":{"ok":true}}\n')
    expect(await pending).toEqual({ ok: true })
    child.stdout.write(
      '{"id":"approval","method":"item/commandExecution/requestApproval","params":{}}\n'
    )
    expect(sent.at(-1)?.error).toMatchObject({ code: -32601 })
    expect(spawn.mock.calls[0][2].shell).toBe(false)
    expect(await client.stop()).toEqual({ code: 0, signal: null })
  })

  it('counts a native turn only when the expected real bridge call/result was observed', async () => {
    const f = fixture()
    const client = {
      events: new EventEmitter(),
      request: vi.fn(async () => {
        queueMicrotask(() =>
          client.events.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'id' }
          })
        )
        return { turn: { id: 't' } }
      })
    }
    const result = await runner.invokeProbe(
      client,
      new Map(),
      'id',
      f.manifest.directCall,
      path.join(f.output, 'events.jsonl'),
      100
    )
    expect(result.status).toBe('inconclusive')
    expect(result.bridgeCallObserved).toBe(false)
    expect(result.transport).toBe('native-turn')
  })

  it('records active held-reply evidence before unsubscribe/resume and always removes the hold', async () => {
    const f = fixture()
    const log: string[] = []
    const client = {
      events: new EventEmitter(),
      request: vi.fn(async (method: string) => {
        log.push(method)
        if (method === 'turn/start') {
          writeFileSync(path.join(f.output, 'events.jsonl'), '{"kind":"response-held","pid":7}\n')
          return { turn: { id: 'turn-id' } }
        }
        if (method === 'thread/resume') {
          expect(readFileSync(path.join(f.output, 'solo.hold'), 'utf8')).toBe('hold')
          return { thread: { id: 'id' } }
        }
        return {}
      })
    }
    const seat = planModule.createProofPlan(f.manifest).cases[0].seats[0]
    const result = await runner.retainedTransition(
      {
        client,
        eventFile: path.join(f.output, 'events.jsonl'),
        manifest: f.manifest,
        options: f.options
      },
      seat,
      'id'
    )
    expect(result.status).toBe('observed')
    expect(result.activeWitness.pid).toBe(7)
    expect(log).toEqual(['turn/start', 'thread/unsubscribe', 'thread/resume', 'turn/interrupt'])
    expect(existsSync(path.join(f.output, 'solo.hold'))).toBe(false)
  })

  function fakeRun(deathFails = false) {
    const calls: string[] = []
    let id = 0
    const client = {
      child: { pid: 123 },
      events: new EventEmitter(),
      notify: vi.fn(),
      request: vi.fn(async (method: string, params: { threadId?: string }) => {
        calls.push(method)
        return method === 'thread/start'
          ? { thread: { id: 'thread-' + ++id } }
          : { thread: { id: params.threadId } }
      }),
      stop: vi.fn(async () => {
        calls.push('death')
        if (deathFails) throw new Error('live')
        return { code: 0 }
      })
    }
    const release = vi.fn(async () => {
      calls.push('release')
      return { status: 'released' }
    })
    const dependencies = {
      acquireHome: vi.fn(async () => ({
        ok: true,
        mode: 'fake',
        noteProviderProcess: async () => calls.push('pid'),
        release
      })),
      openAppServer: vi.fn(() => {
        calls.push('spawn')
        return client
      }),
      nativeSchemas: vi.fn(async () => ({ index: new Map(), sha256: 'schema' })),
      inspectPhase: vi.fn(async (_context, seat, phase, nativeId) => ({
        role: seat.role,
        lifecycle: phase.lifecycle,
        nativeThreadId: nativeId,
        P1: { childPid: seat.role.length }
      })),
      retainedTransition: vi.fn(async () => ({ status: 'inconclusive', reason: 'no_witness' }))
    }
    return { calls, client, release, dependencies }
  }

  it('notes lease PID before initialize, visits every lifecycle, releases after proven death', async () => {
    const f = fixture()
    const fake = fakeRun()
    const spec = planModule.createProofPlan(f.manifest).cases[0]
    const result = await runner.runCase(spec, f.options, f.manifest, fake.dependencies)
    expect(result.status).toBe('executed')
    expect(result.phases).toHaveLength(9)
    expect(fake.calls.slice(0, 3)).toEqual(['spawn', 'pid', 'initialize'])
    expect(fake.calls.slice(-2)).toEqual(['death', 'release'])
    expect(fake.dependencies.retainedTransition).toHaveBeenCalledTimes(3)
    expect(
      result.phases
        .filter((phase: { lifecycle: string }) => phase.lifecycle === 'retained')
        .every((phase: { P2: { status: string } }) => phase.P2.status === 'inconclusive')
    ).toBe(true)
  })

  it('retains the credential lease if provider death is unproven', async () => {
    const f = fixture()
    const fake = fakeRun(true)
    const result = await runner.runCase(
      planModule.createProofPlan(f.manifest).cases[0],
      f.options,
      f.manifest,
      fake.dependencies
    )
    expect(result.credentialRelease.reason).toBe('retained_until_native_death_is_proven')
    expect(fake.release).not.toHaveBeenCalled()
  })

  it('requires declared signed presets matching every case route before it acquires or spawns', async () => {
    const f = fixture()
    const fake = fakeRun()
    const spec = planModule.createProofPlan(f.manifest).cases[0]
    const result = await runner.runCase(
      spec,
      f.options,
      { ...f.manifest, routePostures: {} },
      fake.dependencies
    )
    expect(result.reason).toBe('signed_route_posture_declaration_missing_or_mismatched')
    expect(fake.dependencies.acquireHome).not.toHaveBeenCalled()
    expect(fake.dependencies.openAppServer).not.toHaveBeenCalled()
    const mixed = planModule
      .createProofPlan(f.manifest)
      .cases.find((item: { mixedPermissions: boolean }) => item.mixedPermissions)
    expect(mixed.seats.map((seat: { signedPresetId: string }) => seat.signedPresetId)).toEqual([
      'read_only',
      'workspace_write',
      'read_only'
    ])
    expect(mixed.seats[1].lifecycles[0].postureDeclaration.presetId).toBe('workspace_write')
  })

  it('records a refused credential domain without spawning a daemon', async () => {
    const f = fixture()
    const fake = fakeRun()
    fake.dependencies.acquireHome = vi.fn(async () => ({
      ok: false,
      reason: 'busy'
    })) as typeof fake.dependencies.acquireHome
    const result = await runner.runCase(
      planModule.createProofPlan(f.manifest).cases[0],
      f.options,
      f.manifest,
      fake.dependencies
    )
    expect(result.credentialDomain).toMatchObject({ status: 'refused', reason: 'busy' })
    expect(fake.dependencies.openAppServer).not.toHaveBeenCalled()
  })

  it('requires an actual changed broker epoch and resumes the same native ids', async () => {
    const f = fixture()
    const fake = fakeRun()
    const spec = planModule.createProofPlan(f.manifest).cases[0]
    const unchanged = await runner.runBrokerRestart(spec, f.options, f.manifest, {
      ...fake.dependencies,
      restartBroker: async () => f.manifest
    })
    expect(unchanged.brokerRestart.reason).toBe('broker_instance_epoch_did_not_change')
    const other = fakeRun()
    const changed = await runner.runBrokerRestart(spec, f.options, f.manifest, {
      ...other.dependencies,
      restartBroker: async () => ({
        ...f.manifest,
        endpoint: { ...f.manifest.endpoint, instanceEpoch: 'a'.repeat(32) }
      })
    })
    expect(changed.brokerRestart.phases).toHaveLength(3)
    expect(
      changed.brokerRestart.phases.every((phase: { sameThread: boolean }) => phase.sameThread)
    ).toBe(true)
  })

  it('measures dual-home contention while A holds its lease, then starts B after release', async () => {
    const f = fixture()
    const fake = fakeRun()
    let owned = false
    fake.dependencies.acquireHome = vi.fn(async () => {
      if (owned) return { ok: false, reason: 'busy' }
      owned = true
      return {
        ok: true,
        mode: 'fake',
        noteProviderProcess: async () => {},
        release: async () => {
          owned = false
          return { status: 'released' }
        }
      }
    }) as typeof fake.dependencies.acquireHome
    const result = await runner.runDualInstance(
      planModule.createProofPlan(f.manifest).cases[0],
      {
        ...f.options,
        reuseExistingLogin: true,
        loginSource: f.source
      },
      f.manifest,
      fake.dependencies
    )
    expect(result.contention).toEqual({ status: 'refused', reason: 'busy' })
    expect(result.afterRelease.status).toBe('executed')
    expect(fake.dependencies.openAppServer).toHaveBeenCalledTimes(2)
  })

  it('persists a selected fake live run with no token or private path leakage', async () => {
    const f = fixture()
    const fake = fakeRun()
    const spec = planModule.createProofPlan(f.manifest).cases[0]
    const result = await runner.runLive(
      { ...f.options, caseId: spec.id },
      f.manifest,
      fake.dependencies
    )
    expect(result.report.cases).toHaveLength(1)
    const files = readdirSync(result.output)
    expect(files).toContain('summary.json')
    const plan = readFileSync(path.join(result.output, 'plan.json'), 'utf8')
    expect(plan).not.toContain(f.home)
    expect(plan).not.toContain(f.manifest.endpoint.brokerToken)
    expect(result.report.verdict).toContain('no programme gate')
  })
})
