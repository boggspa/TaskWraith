import { execFile, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GEMINI_MCP_BRIDGE_ARG, startGeminiMcpBridgeProcess } from '../mcp/McpBridgeRuntime'
import {
  buildMcpBridgeRouteEnv,
  MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
  parseMcpBridgeRouteFromEnv
} from '../mcp/McpBridgeRoute'
import {
  attachCursorBrokerParentRouteIfNeeded,
  cursorBrokerParentRouteDirectory,
  execFileCursorMcpBoundToParentRoute,
  recordCursorBrokerParentRoute,
  releaseCursorBrokerParentRoute,
  resolveCursorBrokerParentRouteFromAncestors
} from './CursorBrokerParentRouteLookup'

const tokenA = 'a'.repeat(64)
const epochA = 'c'.repeat(32)

function privateDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(join(tmpdir(), prefix))
  fs.chmodSync(directory, 0o700)
  return directory
}

function liveRouteEnv(socketPath: string): Record<string, string> {
  const built = buildMcpBridgeRouteEnv({
    parentProvider: 'cursor',
    route: { appRunId: 'run-parent', appChatId: 'chat-parent' },
    workspacePath: '/workspace/parent',
    endpoint: {
      socketPath,
      brokerToken: tokenA,
      instanceEpoch: epochA,
      bridgeLogEpoch: 3
    },
    profile: { gatewaySubset: true, soloSubset: true }
  })
  if (!built.ok) throw new Error('Expected a valid Path-B route environment.')
  return built.env
}

function envWithoutMcpRouteKeys(): NodeJS.ProcessEnv {
  return { TASKWRAITH_GEMINI_MCP_BRIDGE: '1' }
}

describe('Cursor broker parent-pid route lookup', () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const directory = cleanup.pop()
      if (directory) fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resolves a recorded ancestor pid when the helper env has no TASKWRAITH_MCP_* keys', () => {
    const directory = privateDirectory('cursor-broker-parent-route-')
    cleanup.push(directory)
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
    const env = liveRouteEnv(socketPath)
    const recorded = recordCursorBrokerParentRoute({
      pid: 4242,
      env,
      socketPath,
      isPidAlive: () => true
    })

    expect(recorded.path).toBe(join(cursorBrokerParentRouteDirectory(socketPath), '4242.json'))
    if (process.platform !== 'win32') {
      // NTFS reports 0666; owner-only on Windows is ACL-enforced, not octal.
      expect(fs.statSync(recorded.path).mode & 0o777).toBe(0o600)
      expect(fs.statSync(cursorBrokerParentRouteDirectory(socketPath)).mode & 0o777).toBe(0o700)
    }

    const resolved = resolveCursorBrokerParentRouteFromAncestors({
      startPid: 99,
      socketPath,
      readParentPid: (pid) => (pid === 99 ? 4242 : pid === 4242 ? 1 : null),
      isPidAlive: () => true
    })
    expect(resolved?.ok).toBe(true)
    if (!resolved?.ok) throw new Error('Expected ancestor route.')
    expect(resolved.value.endpoint.brokerToken).toBe(tokenA)
    expect(resolved.value.route.appRunId).toBe('run-parent')
    expect(resolved.value.parentProvider).toBe('cursor')
    expect(Object.keys(env).some((key) => key.startsWith('TASKWRAITH_MCP_'))).toBe(true)
  })

  it('returns null when no ancestor pid has a recorded route', () => {
    const directory = privateDirectory('cursor-broker-parent-missing-')
    cleanup.push(directory)
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')

    expect(
      resolveCursorBrokerParentRouteFromAncestors({
        startPid: 99,
        socketPath,
        readParentPid: (pid) => (pid === 99 ? 7 : pid === 7 ? 1 : null),
        isPidAlive: () => true
      })
    ).toBeNull()
  })

  it('boots the MCP helper from a recorded ancestor pid when inherited route env is absent', () => {
    const directory = privateDirectory('cursor-broker-parent-helper-boot-')
    cleanup.push(directory)
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
    recordCursorBrokerParentRoute({
      pid: 4242,
      env: liveRouteEnv(socketPath),
      socketPath,
      isPidAlive: () => true
    })

    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const exit = vi.fn()
    startGeminiMcpBridgeProcess({
      getDefaultSocketPath: () => socketPath,
      getAppVersion: () => 'test',
      getMcpToolDefinitions: () => [],
      argv: ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
      env: envWithoutMcpRouteKeys(),
      stdin: stdin as never,
      stdout: stdout as never,
      exit,
      pid: () => 99,
      readParentPid: (pid) => (pid === 99 ? 4242 : pid === 4242 ? 1 : null),
      isPidAlive: () => true
    })

    expect(exit).not.toHaveBeenCalled()
    expect(stdin.listenerCount('data')).toBeGreaterThan(0)
    stdin.end()
  })

  it('still exits 1 when inherited route env is absent and no ancestor is recorded', () => {
    const directory = privateDirectory('cursor-broker-parent-helper-missing-')
    cleanup.push(directory)
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const exit = vi.fn()
    startGeminiMcpBridgeProcess({
      getDefaultSocketPath: () => socketPath,
      getAppVersion: () => 'test',
      getMcpToolDefinitions: () => [],
      argv: ['taskwraith', GEMINI_MCP_BRIDGE_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG],
      env: envWithoutMcpRouteKeys(),
      stdin: stdin as never,
      stdout: stdout as never,
      exit,
      pid: () => 99,
      readParentPid: (pid) => (pid === 99 ? 7 : pid === 7 ? 1 : null),
      isPidAlive: () => true
    })

    expect(exit).toHaveBeenCalledWith(1)
    expect(stdin.listenerCount('data')).toBe(0)
    expect(stdin.listenerCount('end')).toBe(0)
  })

  it('refuses a recorded route whose socket does not match this helper instance', () => {
    const localDirectory = privateDirectory('cursor-broker-parent-local-')
    const foreignDirectory = privateDirectory('cursor-broker-parent-foreign-')
    cleanup.push(localDirectory, foreignDirectory)
    const localSocket = join(localDirectory, 'taskwraith-gemini-mcp.sock')
    const foreignSocket = join(foreignDirectory, 'taskwraith-gemini-mcp.sock')
    recordCursorBrokerParentRoute({
      pid: 4242,
      env: liveRouteEnv(foreignSocket),
      socketPath: foreignSocket,
      isPidAlive: () => true
    })
    fs.mkdirSync(cursorBrokerParentRouteDirectory(localSocket), { recursive: true, mode: 0o700 })
    fs.copyFileSync(
      join(cursorBrokerParentRouteDirectory(foreignSocket), '4242.json'),
      join(cursorBrokerParentRouteDirectory(localSocket), '4242.json')
    )

    expect(
      resolveCursorBrokerParentRouteFromAncestors({
        startPid: 99,
        socketPath: localSocket,
        readParentPid: (pid) => (pid === 99 ? 4242 : 1),
        isPidAlive: () => true
      })
    ).toBeNull()
  })

  it('releases the pid-keyed file when the bound child closes', async () => {
    const directory = privateDirectory('cursor-broker-parent-release-')
    cleanup.push(directory)
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
    const env = liveRouteEnv(socketPath)
    const child = new PassThrough() as unknown as ChildProcess
    Object.assign(child, { pid: 4242 })
    const closeListeners: Array<() => void> = []
    child.once = ((event: string, listener: () => void) => {
      if (event === 'close') closeListeners.push(listener)
      return child
    }) as ChildProcess['once']

    expect(
      attachCursorBrokerParentRouteIfNeeded({
        provider: 'cursor',
        child,
        extraEnv: env,
        socketPath,
        isPidAlive: () => true
      })
    ).toBe(true)
    expect(fs.existsSync(join(cursorBrokerParentRouteDirectory(socketPath), '4242.json'))).toBe(
      true
    )
    closeListeners.forEach((listener) => listener())
    expect(fs.existsSync(join(cursorBrokerParentRouteDirectory(socketPath), '4242.json'))).toBe(
      false
    )
    releaseCursorBrokerParentRoute({ pid: 4242, socketPath })
  })

  it('no-ops for a non-Cursor spawn', () => {
    const directory = privateDirectory('cursor-broker-parent-noop-')
    cleanup.push(directory)
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
    const child = { pid: 4242, once: vi.fn() } as unknown as ChildProcess
    expect(
      attachCursorBrokerParentRouteIfNeeded({
        provider: 'claude',
        child,
        extraEnv: liveRouteEnv(socketPath),
        socketPath
      })
    ).toBe(false)
    expect(fs.existsSync(join(cursorBrokerParentRouteDirectory(socketPath), '4242.json'))).toBe(
      false
    )
  })

  it('parses a recorded file as the same route environment the Path-B seat stamped', () => {
    const directory = privateDirectory('cursor-broker-parent-parse-')
    cleanup.push(directory)
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
    const env = liveRouteEnv(socketPath)
    recordCursorBrokerParentRoute({ pid: 8, env, socketPath, isPidAlive: () => true })
    const bytes = fs.readFileSync(
      join(cursorBrokerParentRouteDirectory(socketPath), '8.json'),
      'utf8'
    )
    const parsedFile = JSON.parse(bytes) as Record<string, string>
    expect(parseMcpBridgeRouteFromEnv(parsedFile).ok).toBe(true)
    expect(Object.keys(parsedFile).every((key) => typeof parsedFile[key] === 'string')).toBe(true)
  })
})

describe('execFileCursorMcpBoundToParentRoute', () => {
  it('records the spawned pid before the exec callback runs', async () => {
    const directory = privateDirectory('cursor-broker-parent-exec-')
    const socketPath = join(directory, 'taskwraith-gemini-mcp.sock')
    const env = liveRouteEnv(socketPath)
    let recordedPid: number | undefined
    const child = {
      pid: 777,
      once: vi.fn()
    } as unknown as ChildProcess
    const result = execFileCursorMcpBoundToParentRoute({
      binaryPath: '/bin/echo',
      args: ['mcp', 'list'],
      cwd: directory,
      routeEnv: env,
      socketPath,
      timeout: 1000,
      execFileImpl: ((_file, _args, _options, callback) => {
        recordedPid = child.pid
        queueMicrotask(() => callback(null, 'taskwraith-broker: ready\n', ''))
        return child
      }) as typeof execFile,
      isPidAlive: () => true,
      callback: () => undefined
    })
    expect(result).toBe(child)
    expect(recordedPid).toBe(777)
    expect(fs.existsSync(join(cursorBrokerParentRouteDirectory(socketPath), '777.json'))).toBe(true)
    fs.rmSync(directory, { recursive: true, force: true })
  })
})
