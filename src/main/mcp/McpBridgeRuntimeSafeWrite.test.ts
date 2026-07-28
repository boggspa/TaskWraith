import fs from 'fs'
import { spawn } from 'child_process'
import { createConnection } from 'net'
import { syncBuiltinESMExports } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { buildSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import {
  applyMcpBridgeProfileArgvToEnv,
  beginBridgeSubprocessLogHistoryClear,
  buildBridgeStartupLogMessage,
  canonicalBridgeLogDirectory,
  clearBridgeSubprocessLogHistory,
  endBridgeSubprocessLogHistoryClear,
  GEMINI_MCP_CORE_SUBSET_ARG,
  GEMINI_MCP_GATEWAY_SUBSET_ARG,
  GEMINI_MCP_LOG_EPOCH_ARG,
  GEMINI_MCP_MESH_DIRECT_ARG,
  GEMINI_MCP_SKETCH_DIRECT_ARG,
  McpBridgeRuntime,
  brokerRequest,
  handleMcpJsonRpcMessage,
  mcpToolCallResponseFromBrokerResult,
  safeMcpStreamWrite,
  sanitizeBridgeStartupArgvForLog,
  writeMcpFrame,
  writeMcpPayload
} from './McpBridgeRuntime'

function privateBridgeTestDirectory(prefix: string): string {
  const path = fs.mkdtempSync(join(tmpdir(), prefix))
  fs.chmodSync(path, 0o700)
  return path
}

describe('MCP bridge stream writes', () => {
  it('clears the exact bridge diagnostic log during a full history purge', () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-history-')
    const target = join(directory, 'bridge-subprocess.log')
    try {
      fs.writeFileSync(target, '__LEGACY_CANVAS_SCRIPT__', { encoding: 'utf8', mode: 0o600 })
      clearBridgeSubprocessLogHistory(target)
      expect(fs.readFileSync(target, 'utf8')).toBe('')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not follow a prepositioned bridge-log symlink during purge', () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-symlink-')
    const victim = join(directory, 'victim.txt')
    const link = join(directory, 'bridge-subprocess.log')
    try {
      fs.writeFileSync(victim, '__DO_NOT_TRUNCATE__', { encoding: 'utf8', mode: 0o600 })
      fs.symlinkSync(victim, link)
      clearBridgeSubprocessLogHistory(link)
      expect(fs.readFileSync(victim, 'utf8')).toBe('__DO_NOT_TRUNCATE__')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('sanitizes broker credentials and path-bearing startup values deterministically', () => {
    const token = '__BRIDGE_TOKEN_SENTINEL__'
    const socket = '/tmp/__BRIDGE_SOCKET_SENTINEL__.sock'
    const workspace = '/tmp/__BRIDGE_WORKSPACE_SENTINEL__'
    const cwd = '/tmp/__BRIDGE_CWD_SENTINEL__'
    const appPath = '/Applications/__BRIDGE_APP_PATH_SENTINEL__.app/Contents/app.asar'
    const argv = [
      appPath,
      '--taskwraith-gemini-mcp-bridge',
      '--socket',
      socket,
      `--token=${token}`,
      '--workspace-path',
      workspace,
      '--bridge-log-epoch',
      '7',
      '--safe-subset',
      '__ARBITRARY_ARG_SECRET__',
      '--unknown=__ARBITRARY_OPTION_SECRET__'
    ]

    expect(sanitizeBridgeStartupArgvForLog(argv)).toEqual([
      '<redacted-path>',
      '--taskwraith-gemini-mcp-bridge',
      '--socket',
      '<redacted-path>',
      '--token=<redacted>',
      '--workspace-path',
      '<redacted-path>',
      '--bridge-log-epoch',
      '<epoch>',
      '--safe-subset',
      '<arg>',
      '<option>'
    ])
    const message = buildBridgeStartupLogMessage({
      argv,
      cwd,
      runId: '__RUN_ID_IS_NOT_LOGGED__',
      parentProvider: 'claude',
      workspacePath: workspace
    })
    expect(message).toContain('cwd=<redacted-path>')
    expect(message).toContain('env.TASKWRAITH_RUN_ID.present=true')
    expect(message).not.toContain(token)
    expect(message).not.toContain(socket)
    expect(message).not.toContain(workspace)
    expect(message).not.toContain(cwd)
    expect(message).not.toContain(appPath)
    expect(message).not.toContain('__RUN_ID_IS_NOT_LOGGED__')
    expect(message).not.toContain('__ARBITRARY_ARG_SECRET__')
    expect(message).not.toContain('__ARBITRARY_OPTION_SECRET__')
  })

  it('persists only structural startup, tool, rejection, stack, and stream-error metadata', async () => {
    const home = privateBridgeTestDirectory('taskwraith-bridge-startup-log-')
    const bundledRuntimePath = join(home, 'McpBridgeRuntime.mjs')
    buildSync({
      entryPoints: [fileURLToPath(new URL('./McpBridgeRuntime.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundledRuntimePath,
      logLevel: 'silent'
    })
    const runtimeModuleUrl = pathToFileURL(bundledRuntimePath).href
    const sentinels = {
      token: '__PERSISTED_TOKEN_SENTINEL__',
      socket: '/tmp/__PERSISTED_SOCKET_SENTINEL__.sock',
      cwd: '/tmp/__PERSISTED_CWD_SENTINEL__',
      workspace: '/tmp/__PERSISTED_WORKSPACE_SENTINEL__',
      app: '/Applications/__PERSISTED_APP_SENTINEL__.app/Contents/app.asar',
      rawTool: '__PERSISTED_RAW_TOOL_NAME_SENTINEL__',
      requestId: '__PERSISTED_REQUEST_ID_SENTINEL__',
      argument: '__PERSISTED_ARGUMENT_SENTINEL__',
      argumentPath: '/tmp/__PERSISTED_ARGUMENT_PATH_SENTINEL__',
      gatewayTarget: '__PERSISTED_GATEWAY_TARGET_SENTINEL__',
      rejection: '__PERSISTED_REJECTION_SENTINEL__',
      streamError: '__PERSISTED_STREAM_ERROR_SENTINEL__',
      stackError: '__PERSISTED_STACK_ERROR_SENTINEL__'
    }
    const source = `
      import { PassThrough } from 'node:stream';
      import { startGeminiMcpBridgeProcess } from ${JSON.stringify(runtimeModuleUrl)};
      const input = new PassThrough();
      const output = new PassThrough();
      startGeminiMcpBridgeProcess({
        getDefaultSocketPath: () => ${JSON.stringify(sentinels.socket)},
        getAppVersion: () => 'test',
        getMcpToolDefinitions: () => [],
        brokerRequest: async () => { throw new Error(${JSON.stringify(sentinels.rejection)}); },
        argv: [
          'taskwraith',
          ${JSON.stringify(sentinels.app)},
          '--taskwraith-gemini-mcp-bridge',
          '--socket', ${JSON.stringify(sentinels.socket)},
          '--token', ${JSON.stringify(sentinels.token)},
          '--bridge-log-epoch', '0'
        ],
        env: {
          TASKWRAITH_RUN_ID: '__PERSISTED_RUN_ID_SENTINEL__',
          TASKWRAITH_PARENT_PROVIDER: 'claude',
          TASKWRAITH_WORKSPACE_PATH: ${JSON.stringify(sentinels.workspace)}
        },
        stdin: input,
        stdout: output,
        cwd: () => ${JSON.stringify(sentinels.cwd)},
        pid: () => 4242,
        exit: () => {}
      });
      input.write(JSON.stringify({
        jsonrpc: '2.0',
        id: ${JSON.stringify(sentinels.requestId)},
        method: 'tools/call',
        params: {
          name: ${JSON.stringify(sentinels.rawTool)},
          arguments: {
            prompt: ${JSON.stringify(sentinels.argument)},
            path: ${JSON.stringify(sentinels.argumentPath)}
          }
        }
      }) + '\\n');
      input.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 'gateway-target-id',
        method: 'tools/call',
        params: {
          name: 'capability_invoke',
          arguments: { name: ${JSON.stringify(sentinels.gatewayTarget)} }
        }
      }) + '\\n');
      input.emit('error', new Error(${JSON.stringify(sentinels.streamError)}));
      output.emit('error', new Error(${JSON.stringify(sentinels.streamError)}));
      process.emit('uncaughtException', new Error(${JSON.stringify(sentinels.stackError)}));
      process.emit('unhandledRejection', new Error(${JSON.stringify(sentinels.stackError)}));
      setTimeout(() => process.exit(0), 25);
    `
    try {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        // Windows os.homedir() prefers USERPROFILE over HOME; pin both so the
        // bridge child writes under the test home on every platform.
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(code, stderr).toBe(0)

      const logPath = join(canonicalBridgeLogDirectory(home), 'bridge-subprocess.log')
      const persisted = fs.readFileSync(logPath, 'utf8')
      expect(persisted).toContain('--token')
      expect(persisted).toContain('<redacted>')
      expect(persisted).toContain('<redacted-path>')
      expect(persisted).toContain('tools/call started tool=unknown')
      expect(persisted).toContain('args.kind=object args.fields=2')
      expect(persisted).toContain('tools/call broker-rejected failure.kind=error')
      expect(persisted).toContain(
        'tools/call rejected scope=gateway-target tool=capability_invoke reason=invalid-target'
      )
      expect(persisted).toContain('stdin error failure.kind=error')
      expect(persisted).toContain('stdout error failure.kind=error')
      expect(persisted).toContain('uncaughtException failure.kind=error')
      expect(persisted).toContain('unhandledRejection failure.kind=error')
      expect(persisted).not.toContain('__PERSISTED_RUN_ID_SENTINEL__')
      for (const sentinel of Object.values(sentinels)) {
        expect(persisted).not.toContain(sentinel)
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  it('fences an old child that never resolved the log before clear and admits a newly stamped child', async () => {
    const home = fs.mkdtempSync(join(tmpdir(), 'taskwraith-bridge-epoch-'))
    const logDirectory = canonicalBridgeLogDirectory(home)
    const logPath = join(logDirectory, 'bridge-subprocess.log')
    fs.mkdirSync(logDirectory, { recursive: true })
    fs.chmodSync(logDirectory, 0o700)
    const bundledRuntimePath = join(home, 'McpBridgeRuntime.mjs')
    buildSync({
      entryPoints: [fileURLToPath(new URL('./McpBridgeRuntime.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundledRuntimePath,
      logLevel: 'silent'
    })
    const runtimeModuleUrl = pathToFileURL(bundledRuntimePath).href
    const runChild = async (epoch: number, marker: string) => {
      const source = `
        import { bridgeLog, configureBridgeLogProcessEpochFromLaunch } from ${JSON.stringify(runtimeModuleUrl)};
        configureBridgeLogProcessEpochFromLaunch(['taskwraith', '--bridge-log-epoch', ${JSON.stringify(String(epoch))}]);
        process.stdout.write('ready\\n');
        process.stdin.once('data', () => {
          bridgeLog(${JSON.stringify(marker)});
          process.stdout.write('done\\n');
          process.exit(0);
        });
      `
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        // Pin both home envs so Windows os.homedir() and POSIX HOME agree.
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let output = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`bridge child readiness timeout: ${stderr}`)), 5_000)
        const poll = () => {
          if (output.includes('ready')) {
            clearTimeout(timeout)
            resolve()
          } else if (child.exitCode !== null) {
            clearTimeout(timeout)
            reject(new Error(`bridge child exited before ready: ${stderr}`))
          } else {
            setTimeout(poll, 10)
          }
        }
        poll()
      })
      return {
        finish: async () => {
          child.stdin.write('go\n')
          const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
          if (code !== 0) throw new Error(`bridge child failed (${code}): ${stderr}`)
        }
      }
    }

    try {
      const oldChild = await runChild(0, '__OLD_CHILD_LATE_LOG__')
      await beginBridgeSubprocessLogHistoryClear(logPath)
      endBridgeSubprocessLogHistoryClear()
      await oldChild.finish()
      expect(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '').not.toContain(
        '__OLD_CHILD_LATE_LOG__'
      )

      const newChild = await runChild(1, '__NEW_CHILD_LOG__')
      await newChild.finish()
      expect(fs.readFileSync(logPath, 'utf8')).toContain('__NEW_CHILD_LOG__')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  it('serializes a paused pre-clear append before the final strict truncate', async () => {
    const home = privateBridgeTestDirectory('taskwraith-bridge-append-clear-race-')
    const logDirectory = canonicalBridgeLogDirectory(home)
    const logPath = join(logDirectory, 'bridge-subprocess.log')
    const releasePath = join(home, 'release-paused-append')
    fs.mkdirSync(logDirectory, { recursive: true })
    fs.chmodSync(logDirectory, 0o700)
    const bundledRuntimePath = join(home, 'McpBridgeRuntime.mjs')
    buildSync({
      entryPoints: [fileURLToPath(new URL('./McpBridgeRuntime.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundledRuntimePath,
      logLevel: 'silent'
    })
    const marker = '__PAUSED_PRE_CLEAR_APPEND__'
    const runtimeModuleUrl = pathToFileURL(bundledRuntimePath).href
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalWriteSync = fs.writeSync.bind(fs);
      fs.writeSync = (...args) => {
        const chunk = args[1];
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        if (text.includes(${JSON.stringify(marker)})) {
          process.stdout.write('paused\\n');
          const waiter = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(${JSON.stringify(releasePath)})) {
            Atomics.wait(waiter, 0, 0, 10);
          }
        }
        return originalWriteSync(...args);
      };
      syncBuiltinESMExports();
      const { bridgeLog, configureBridgeLogProcessEpochFromLaunch } = await import(${JSON.stringify(runtimeModuleUrl)});
      configureBridgeLogProcessEpochFromLaunch(['taskwraith', '--bridge-log-epoch', '0']);
      bridgeLog(${JSON.stringify(marker)});
      process.exit(0);
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let stderr = ''
    let clearStarted = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`paused append timeout: ${stderr}`)),
          5_000
        )
        const poll = () => {
          if (output.includes('paused')) {
            clearTimeout(timeout)
            resolve()
          } else if (child.exitCode !== null) {
            clearTimeout(timeout)
            reject(new Error(`append child exited before pause: ${stderr}`))
          } else {
            setTimeout(poll, 10)
          }
        }
        poll()
      })

      let clearSettled = false
      clearStarted = true
      const clearing = beginBridgeSubprocessLogHistoryClear(logPath).then(
        (result) => {
          clearSettled = true
          return result
        },
        (error) => {
          clearSettled = true
          throw error
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(clearSettled).toBe(false)

      fs.writeFileSync(releasePath, 'release', { mode: 0o600 })
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(code, stderr).toBe(0)
      expect(await clearing).toEqual({ status: 'cleared', epoch: 1 })
      expect(fs.readFileSync(logPath, 'utf8')).toBe('')
    } finally {
      if (!fs.existsSync(releasePath)) {
        fs.writeFileSync(releasePath, 'release', { mode: 0o600 })
      }
      if (child.exitCode === null) child.kill('SIGKILL')
      if (clearStarted) endBridgeSubprocessLogHistoryClear()
      fs.rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  it('treats a missing log as a successful strict purge and creates private epoch state', async () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-missing-')
    const logPath = join(directory, 'bridge-subprocess.log')
    try {
      const result = await beginBridgeSubprocessLogHistoryClear(logPath)
      expect(result).toEqual({ status: 'missing', epoch: 1 })
      expect(fs.existsSync(logPath)).toBe(false)
      // Windows does not expose POSIX mode authority; production already skips
      // 0700/0600 enforcement there (assertBridgePrivateMode).
      if (process.platform !== 'win32') {
        expect(fs.statSync(directory).mode & 0o777).toBe(0o700)
        expect(fs.statSync(`${logPath}.epoch`).mode & 0o777).toBe(0o600)
      } else {
        expect(fs.existsSync(`${logPath}.epoch`)).toBe(true)
      }
    } finally {
      endBridgeSubprocessLogHistoryClear()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a hardlinked bridge log without truncating either link', async () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-hardlink-log-')
    const victim = join(directory, 'victim.log')
    const logPath = join(directory, 'bridge-subprocess.log')
    fs.writeFileSync(victim, '__HARDLINK_LOG_VICTIM__', { encoding: 'utf8', mode: 0o600 })
    fs.linkSync(victim, logPath)
    try {
      await expect(beginBridgeSubprocessLogHistoryClear(logPath)).rejects.toThrow(
        /unsafe link count/
      )
      expect(fs.readFileSync(victim, 'utf8')).toBe('__HARDLINK_LOG_VICTIM__')
      expect(fs.readFileSync(logPath, 'utf8')).toBe('__HARDLINK_LOG_VICTIM__')
    } finally {
      endBridgeSubprocessLogHistoryClear()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a hardlinked epoch file before mutating the log or epoch victim', async () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-hardlink-epoch-')
    const logPath = join(directory, 'bridge-subprocess.log')
    const epochVictim = join(directory, 'epoch-victim')
    fs.writeFileSync(logPath, '__LOG_MUST_SURVIVE__', { encoding: 'utf8', mode: 0o600 })
    fs.writeFileSync(epochVictim, '0', { encoding: 'utf8', mode: 0o600 })
    fs.linkSync(epochVictim, `${logPath}.epoch`)
    try {
      await expect(beginBridgeSubprocessLogHistoryClear(logPath)).rejects.toThrow(
        /unsafe link count/
      )
      expect(fs.readFileSync(epochVictim, 'utf8')).toBe('0')
      expect(fs.readFileSync(logPath, 'utf8')).toBe('__LOG_MUST_SURVIVE__')
    } finally {
      endBridgeSubprocessLogHistoryClear()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked log directory without touching its target', async () => {
    const root = privateBridgeTestDirectory('taskwraith-bridge-symlink-directory-')
    const realDirectory = join(root, 'real')
    const linkedDirectory = join(root, 'logs')
    fs.mkdirSync(realDirectory, { mode: 0o700 })
    const victim = join(realDirectory, 'bridge-subprocess.log')
    fs.writeFileSync(victim, '__SYMLINK_DIRECTORY_VICTIM__', {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.symlinkSync(realDirectory, linkedDirectory)
    try {
      await expect(
        beginBridgeSubprocessLogHistoryClear(join(linkedDirectory, 'bridge-subprocess.log'))
      ).rejects.toThrow(/trusted directory/)
      expect(fs.readFileSync(victim, 'utf8')).toBe('__SYMLINK_DIRECTORY_VICTIM__')
    } finally {
      endBridgeSubprocessLogHistoryClear()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a prepositioned symlink at the append-clear transaction lock', async () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-lock-symlink-')
    const logPath = join(directory, 'bridge-subprocess.log')
    const lockTarget = join(directory, 'lock-target')
    fs.writeFileSync(logPath, '__LOCK_SYMLINK_LOG__', { encoding: 'utf8', mode: 0o600 })
    fs.mkdirSync(lockTarget, { mode: 0o700 })
    fs.symlinkSync(lockTarget, `${logPath}.lock`)
    try {
      await expect(beginBridgeSubprocessLogHistoryClear(logPath)).rejects.toThrow(
        /trusted directory/
      )
      expect(fs.readFileSync(logPath, 'utf8')).toBe('__LOCK_SYMLINK_LOG__')
      expect(fs.existsSync(`${logPath}.epoch`)).toBe(false)
    } finally {
      endBridgeSubprocessLogHistoryClear()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a same-path directory substitution after identity is pinned', async () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-directory-swap-')
    const displacedDirectory = `${directory}-displaced`
    const logPath = join(directory, 'bridge-subprocess.log')
    fs.writeFileSync(logPath, '__INITIAL_LOG__', { encoding: 'utf8', mode: 0o600 })
    try {
      await beginBridgeSubprocessLogHistoryClear(logPath)
      endBridgeSubprocessLogHistoryClear()

      fs.renameSync(directory, displacedDirectory)
      fs.mkdirSync(directory, { mode: 0o700 })
      fs.writeFileSync(logPath, '__DIRECTORY_SWAP_VICTIM__', {
        encoding: 'utf8',
        mode: 0o600
      })
      await expect(beginBridgeSubprocessLogHistoryClear(logPath)).rejects.toThrow(
        /directory identity changed/
      )
      expect(fs.readFileSync(logPath, 'utf8')).toBe('__DIRECTORY_SWAP_VICTIM__')
    } finally {
      endBridgeSubprocessLogHistoryClear()
      fs.rmSync(directory, { recursive: true, force: true })
      fs.rmSync(displacedDirectory, { recursive: true, force: true })
    }
  })

  it('propagates an fsync failure from the strict purge path', async () => {
    const directory = privateBridgeTestDirectory('taskwraith-bridge-fsync-failure-')
    const logPath = join(directory, 'bridge-subprocess.log')
    fs.writeFileSync(logPath, '__STRICT_PURGE_FSYNC__', { encoding: 'utf8', mode: 0o600 })
    const originalFsync = fs.fsyncSync
    let fsyncCalls = 0
    const fsync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      fsyncCalls += 1
      if (fsyncCalls === 2) throw new Error('injected bridge purge fsync failure')
      originalFsync(fd)
    })
    syncBuiltinESMExports()
    try {
      await expect(beginBridgeSubprocessLogHistoryClear(logPath)).rejects.toThrow(
        'injected bridge purge fsync failure'
      )
      expect(fsyncCalls).toBe(2)
    } finally {
      fsync.mockRestore()
      syncBuiltinESMExports()
      endBridgeSubprocessLogHistoryClear()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never projects the internal canvas_eval approval receipt to provider transport', () => {
    const response = mcpToolCallResponseFromBrokerResult({
      text: 'ok',
      canvasEvalApproval: {
        schemaVersion: 1,
        approvalId: 'approval-1',
        scriptHashAlgorithm: 'sha256',
        scriptHash: 'a'.repeat(64),
        scriptLength: 1,
        scriptByteLength: 1
      }
    })

    expect(response).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false
    })
    expect(JSON.stringify(response)).not.toContain('approval-1')
  })

  it('swallows terminal EPIPE writes', () => {
    const stream = {
      write: vi.fn(() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      })
    }

    expect(() => safeMcpStreamWrite(stream, '{"ok":true}\n')).not.toThrow()
    expect(stream.write).toHaveBeenCalledOnce()
  })

  it('does not write to already closed streams', () => {
    const stream = {
      destroyed: true,
      write: vi.fn()
    }

    safeMcpStreamWrite(stream, '{"ok":true}\n')

    expect(stream.write).not.toHaveBeenCalled()
  })

  it('uses safe writes for line and framed MCP responses', () => {
    const stream = {
      write: vi.fn(() => {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      })
    }

    expect(() => writeMcpPayload({ ok: true }, 'line', stream as never)).not.toThrow()
    expect(() => writeMcpFrame({ ok: true }, stream as never)).not.toThrow()
    expect(stream.write).toHaveBeenCalledTimes(2)
  })

  it('stamps caller route and workspace metadata onto brokered tool calls', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'ok' }))
    const stream = {
      write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => callback?.())
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_RUN_ID: 'run-1',
          TASKWRAITH_CHAT_ID: 'chat-1',
          TASKWRAITH_PARENT_PROVIDER: 'grok',
          TASKWRAITH_WORKSPACE_PATH: '/repo'
        },
        cwd: () => '/repo/subdir',
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'README.md' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({
        id: 7,
        token: 'token-1',
        tool: 'read_file',
        appRunId: 'run-1',
        appChatId: 'chat-1',
        parentProvider: 'grok',
        callerCwd: '/repo/subdir',
        callerWorkspacePath: '/repo'
      })
    )
  })

  it('does not reflect unexpected broker rejection details to the provider', async () => {
    const sentinel = '/Users/operator/private/workspace/.secrets/token=host-secret'
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest: vi.fn(async () => {
          throw new Error(sentinel)
        }),
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 71,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: 'README.md' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    const response = JSON.parse(chunks.join('').trim()) as {
      result: { isError: boolean; content: Array<{ type: string; text: string }> }
    }
    expect(response.result).toEqual({
      content: [
        {
          type: 'text',
          text: 'TaskWraith MCP bridge encountered an unexpected internal error.'
        }
      ],
      isError: true
    })
    expect(chunks.join('')).not.toContain(sentinel)
  })

  // Windows GitHub runners reject AF_UNIX listen() with EACCES on pathname
  // sockets under %TEMP%. Gemini MCP broker remains a Unix-domain socket path
  // (historical/retired transport); named-pipe migration is out of 1.8.5 scope.
  it.skipIf(process.platform === 'win32')(
    'returns a constant broker parse error without reflecting malformed provider bytes',
    async () => {
      const socketPath = join(
        tmpdir(),
        `taskwraith-malformed-broker-${process.pid}-${Math.random().toString(36).slice(2)}.sock`
      )
      const runtime = new McpBridgeRuntime({
        getGeminiMcpSocketPath: () => socketPath,
        getGeminiMcpBrokerToken: () => 'token-1',
        executeGeminiMcpTool: vi.fn()
      } as never)
      await runtime.startGeminiMcpBroker()
      try {
        const response = await new Promise<string>((resolve, reject) => {
          const socket = createConnection(socketPath)
          let buffer = ''
          socket.setEncoding('utf8')
          socket.once('connect', () => {
            socket.write('{"secret":"__MALFORMED_BROKER_SECRET__"\n')
          })
          socket.on('data', (chunk) => {
            buffer += chunk
            if (!buffer.includes('\n')) return
            socket.destroy()
            resolve(buffer)
          })
          socket.once('error', reject)
        })
        expect(response).toContain('Malformed broker JSON request.')
        expect(response).not.toContain('__MALFORMED_BROKER_SECRET__')
      } finally {
        runtime.closeGeminiMcpBroker()
        fs.rmSync(socketPath, { force: true })
      }
    }
  )

  it('canonicalizes AskUserQuestion aliases before brokered tool calls', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'ok' }))
    const stream = {
      write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => callback?.())
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_SAFE_SUBSET: '1',
          TASKWRAITH_PARENT_PROVIDER: 'claude'
        },
        cwd: () => '/repo',
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'ASkUserQuestion', arguments: { question: 'Continue?' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({
        tool: 'ask_user_question',
        parentProvider: 'claude'
      })
    )
  })

  it('passes broker caller context into the main MCP executor', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'read_file',
      arguments: { path: 'README.md' },
      parentProvider: 'grok',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      callerCwd: '/repo/subdir',
      callerWorkspacePath: '/repo'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'README.md' },
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'grok',
      { callerCwd: '/repo/subdir', callerWorkspacePath: '/repo' }
    )
  })

  it('confines a Pi broker credential to the fixed ensemble coordination surface', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)
    const piCredential = runtime.issuePiEnsembleCoordinationCredential({
      appRunId: 'pi-run-1',
      appChatId: 'chat-1'
    })

    const rejected = await runtime.handleGeminiMcpBrokerRequest({
      token: piCredential,
      tool: 'run_shell_command',
      arguments: { command: 'pwd' },
      parentProvider: 'pi',
      appRunId: 'pi-run-1',
      appChatId: 'chat-1'
    })

    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringContaining('only permits ensemble coordination tools')
    })
    expect(executeGeminiMcpTool).not.toHaveBeenCalled()

    await runtime.handleGeminiMcpBrokerRequest({
      token: piCredential,
      tool: 'ensemble_yield',
      arguments: { target: 'Reviewer' },
      parentProvider: 'pi',
      appRunId: 'pi-run-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'ensemble_yield',
      { target: 'Reviewer' },
      { appRunId: 'pi-run-1', appChatId: 'chat-1' },
      'pi',
      {}
    )
  })

  it('does not let a Pi coordination credential impersonate another live run', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool,
      resolveBrokerParentProviderFromRunId: () => 'grok'
    } as never)
    const piCredential = runtime.issuePiEnsembleCoordinationCredential({
      appRunId: 'pi-run-1',
      appChatId: 'pi-chat-1'
    })

    const rejected = await runtime.handleGeminiMcpBrokerRequest({
      token: piCredential,
      tool: 'ensemble_yield',
      arguments: { target: 'Reviewer' },
      parentProvider: 'grok',
      appRunId: 'grok-run-2',
      appChatId: 'grok-chat-2'
    })

    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringContaining('bound to a different run route')
    })
    expect(executeGeminiMcpTool).not.toHaveBeenCalled()

    const rejectedSharedToken = await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'ensemble_yield',
      arguments: { target: 'Reviewer' },
      parentProvider: 'pi',
      appRunId: 'pi-run-1',
      appChatId: 'pi-chat-1'
    })
    expect(rejectedSharedToken).toMatchObject({
      ok: false,
      error: expect.stringContaining('requires a run-bound credential')
    })
  })

  it('prefers the live run provider when appRunId maps to a different provider stamp', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool,
      resolveBrokerParentProviderFromRunId: () => 'grok'
    } as never)

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'read_file',
      arguments: { path: 'README.md' },
      parentProvider: 'cursor',
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'README.md' },
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'grok',
      {}
    )
  })

  // See skip rationale on the malformed-broker AF_UNIX case above.
  it.skipIf(process.platform === 'win32')(
    'redacts a real broker executor rejection and client socket path end to end',
    async () => {
    const directory = privateBridgeTestDirectory('tw-br-')
    const socketPath = join(directory, 'broker.sock')
    const rejectionSentinel =
      '/Users/operator/private/workspace/.secrets/token=__BROKER_EXECUTOR_SENTINEL__'
    const runtime = new McpBridgeRuntime({
      getGeminiMcpSocketPath: () => socketPath,
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool: vi.fn(async () => {
        throw new Error(rejectionSentinel)
      })
    } as never)

    try {
      await runtime.startGeminiMcpBroker()
      const executorResponse = await brokerRequest(socketPath, {
        id: 72,
        token: 'token-1',
        tool: 'read_file',
        arguments: { path: 'README.md' },
        parentProvider: 'kimi'
      })
      expect(executorResponse).toMatchObject({
        id: 72,
        ok: false,
        error: 'TaskWraith MCP bridge encountered an unexpected internal error.'
      })
      expect(JSON.stringify(executorResponse)).not.toContain(rejectionSentinel)
    } finally {
      runtime.closeGeminiMcpBroker()
    }

    const missingSocket = join(directory, '__MISSING_PRIVATE_SOCKET_SENTINEL__.sock')
    const socketResponse = await brokerRequest(missingSocket, { id: 73 })
    expect(socketResponse).toEqual({
      ok: false,
      error: 'TaskWraith MCP bridge encountered an unexpected internal error.'
    })
    expect(JSON.stringify(socketResponse)).not.toContain(missingSocket)
    fs.rmSync(directory, { recursive: true, force: true })
    }
  )

  it('canonicalizes AskUserQuestion aliases before main MCP execution', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'mcp__TaskWraith__AskUserQuestion',
      arguments: { question: 'Continue?' },
      parentProvider: 'claude',
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'ask_user_question',
      { question: 'Continue?' },
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'claude',
      {}
    )
  })

  it('preserves gateway calls for main-side target resolution and approval', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'ok' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)
    const args = { name: 'video_encode_clip', arguments: { path: 'clip.mp4' } }

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'capability_invoke',
      arguments: args,
      parentProvider: 'codex',
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'capability_invoke',
      args,
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'codex',
      {}
    )
  })

  it('advertises only the explicit core profile to tool-constrained models', () => {
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [
          { name: 'read_file' },
          { name: 'apply_patch' },
          { name: 'canvas_eval' }
        ],
        env: { TASKWRAITH_MCP_CORE_SUBSET: '1' },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 9, method: 'tools/list' },
      'line'
    )

    const response = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(response.result.tools.map((tool) => tool.name)).toEqual(['read_file', 'apply_patch'])
  })

  it('advertises only the gateway direct set plus gateway and audit tools', () => {
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [
          { name: 'read_file' },
          { name: 'tw_introspection_read' },
          { name: 'video_encode_clip' }
        ],
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_AUDIT: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 16, method: 'tools/list' },
      'line'
    )

    const response = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'capability_search',
      'capability_invoke',
      'audit_set_profile',
      'audit_record_finding',
      'audit_record_verdict'
    ])
  })

  it('adds Mesh Canvas only for the participant-run mesh-direct gateway variant', () => {
    const tools = [{ name: 'read_file' }, { name: 'mesh_scene_present' }, { name: 'video_encode_clip' }]
    const list = (env: Record<string, string>) => {
      const chunks: string[] = []
      handleMcpJsonRpcMessage(
        {
          getDefaultSocketPath: () => '/tmp/taskwraith.sock',
          getAppVersion: () => '1.0.0',
          getMcpToolDefinitions: () => tools,
          env,
          stdout: { write: vi.fn((chunk: string) => (chunks.push(chunk), true)) } as never
        },
        '/tmp/taskwraith.sock',
        'token-1',
        { jsonrpc: '2.0', id: 24, method: 'tools/list' },
        'line'
      )
      return (JSON.parse(chunks.join('').trim()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name
      )
    }
    expect(list({ TASKWRAITH_MCP_GATEWAY_SUBSET: '1' })).not.toContain('mesh_scene_present')
    expect(
      list({ TASKWRAITH_MCP_GATEWAY_SUBSET: '1', TASKWRAITH_MCP_MESH_DIRECT: '1' })
    ).toContain('mesh_scene_present')
  })

  it('adds all Sketch Canvas verbs only for a v8 sketch-direct gateway receipt', () => {
    const tools = [
      { name: 'read_file' },
      { name: 'canvas_sketch_open' },
      { name: 'canvas_sketch_get' },
      { name: 'canvas_sketch_update' },
      { name: 'ensemble_roster_edit' },
      { name: 'video_encode_clip' }
    ]
    const list = (env: Record<string, string>) => {
      const chunks: string[] = []
      handleMcpJsonRpcMessage(
        {
          getDefaultSocketPath: () => '/tmp/taskwraith.sock',
          getAppVersion: () => '1.0.0',
          getMcpToolDefinitions: () => tools,
          env,
          stdout: { write: vi.fn((chunk: string) => (chunks.push(chunk), true)) } as never
        },
        '/tmp/taskwraith.sock',
        'token-1',
        { jsonrpc: '2.0', id: 25, method: 'tools/list' },
        'line'
      )
      return (
        JSON.parse(chunks.join('').trim()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((tool) => tool.name)
    }
    const legacy = list({ TASKWRAITH_MCP_GATEWAY_SUBSET: '1' })
    const fresh = list({
      TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
      TASKWRAITH_MCP_SKETCH_DIRECT: '1'
    })
    const freshMesh = list({
      TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
      TASKWRAITH_MCP_SKETCH_DIRECT: '1',
      TASKWRAITH_MCP_MESH_DIRECT: '1'
    })
    for (const tool of ['canvas_sketch_open', 'canvas_sketch_get', 'canvas_sketch_update']) {
      expect(legacy).not.toContain(tool)
      expect(fresh).toContain(tool)
      expect(freshMesh).toContain(tool)
    }
    expect(fresh).toContain('ensemble_roster_edit')
    expect(freshMesh).toContain('ensemble_roster_edit')
  })

  it('forwards direct Sketch calls only when the v8 receipt flag is present', async () => {
    const call = async (env: Record<string, string>) => {
      const brokerRequest = vi.fn(async () => ({ ok: true, text: 'updated' }))
      handleMcpJsonRpcMessage(
        {
          getDefaultSocketPath: () => '/tmp/taskwraith.sock',
          getAppVersion: () => '1.0.0',
          getMcpToolDefinitions: () => [],
          brokerRequest,
          env,
          stdout: { write: vi.fn(() => true) } as never
        },
        '/tmp/taskwraith.sock',
        'token-1',
        {
          jsonrpc: '2.0',
          id: 26,
          method: 'tools/call',
          params: {
            name: 'canvas_sketch_update',
            arguments: { canvasId: 'sketch-1', mode: 'clear' }
          }
        },
        'line'
      )
      await new Promise((resolve) => setImmediate(resolve))
      return brokerRequest
    }

    const legacy = await call({ TASKWRAITH_MCP_GATEWAY_SUBSET: '1' })
    expect(legacy).not.toHaveBeenCalled()

    const fresh = await call({
      TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
      TASKWRAITH_MCP_SKETCH_DIRECT: '1'
    })
    expect(fresh).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({
        tool: 'canvas_sketch_update',
        arguments: { canvasId: 'sketch-1', mode: 'clear' }
      })
    )
  })

  it('allows a hidden read-only target through capability_invoke without unwrapping it', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'found' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_SAFE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/call',
        params: {
          name: 'capability_invoke',
          arguments: { name: 'tw_introspection_read', arguments: { packId: 'pack-1' } }
        }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({
        tool: 'capability_invoke',
        arguments: {
          name: 'tw_introspection_read',
          arguments: { packId: 'pack-1' }
        }
      })
    )
  })

  it('allows capability_search in a read-only gateway seat', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'matches' }))
    const stream = {
      write: vi.fn((_chunk: string, callback?: (error?: Error | null) => void) => callback?.())
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_SAFE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'capability_search', arguments: { query: 'edit video' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({ tool: 'capability_search' })
    )
  })

  it('rejects a hidden mutating target wrapped by a read-only gateway call', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: {
          TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
          TASKWRAITH_MCP_SAFE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: {
          name: 'capability_invoke',
          arguments: { name: 'video_encode_clip', arguments: { path: 'clip.mp4' } }
        }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const response = JSON.parse(chunks.join('').trim()) as { error: { code: number } }
    expect(response.error.code).toBe(-32601)
  })

  it.each(['missing_capability', 'capability_invoke', 'capability_search'])(
    'rejects invalid capability_invoke target %s before broker dispatch',
    async (target) => {
      const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
      const chunks: string[] = []
      const stream = {
        write: vi.fn((chunk: string) => {
          chunks.push(chunk)
          return true
        })
      }

      handleMcpJsonRpcMessage(
        {
          getDefaultSocketPath: () => '/tmp/taskwraith.sock',
          getAppVersion: () => '1.0.0',
          getMcpToolDefinitions: () => [],
          brokerRequest,
          env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
          stdout: stream as never
        },
        '/tmp/taskwraith.sock',
        'token-1',
        {
          jsonrpc: '2.0',
          id: 19,
          method: 'tools/call',
          params: {
            name: 'capability_invoke',
            arguments: { name: target, arguments: {} }
          }
        },
        'line'
      )
      await new Promise((resolve) => setImmediate(resolve))

      expect(brokerRequest).not.toHaveBeenCalled()
      const response = JSON.parse(chunks.join('').trim()) as { error: { code: number } }
      expect(response.error.code).toBe(-32602)
    }
  )

  it('intersects the core profile with the existing read-only safety scope', () => {
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [
          { name: 'read_file' },
          { name: 'prompt_task_normalize' },
          { name: 'write_file' }
        ],
        env: {
          TASKWRAITH_MCP_SAFE_SUBSET: '1',
          TASKWRAITH_MCP_CORE_SUBSET: '1'
        },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      'line'
    )

    const response = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    // prompt_task_normalize is safe but not core; write_file is core but not
    // read-only. Only tools present in both profiles may be advertised.
    expect(response.result.tools.map((tool) => tool.name)).toEqual(['read_file'])
  })

  it('keeps core as a hard ceiling over plan instruments', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'approved' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }
    const deps = {
      getDefaultSocketPath: () => '/tmp/taskwraith.sock',
      getAppVersion: () => '1.0.0',
      getMcpToolDefinitions: () => [
        { name: 'read_file' },
        { name: 'canvas_click' },
        { name: 'video_probe' },
        { name: 'write_file' }
      ],
      brokerRequest,
      env: {
        TASKWRAITH_MCP_SAFE_SUBSET: '1',
        TASKWRAITH_MCP_PLAN_SUBSET: '1',
        TASKWRAITH_MCP_CORE_SUBSET: '1'
      },
      stdout: stream as never
    }

    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 14, method: 'tools/list' },
      'line'
    )
    const listResponse = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(listResponse.result.tools.map((tool) => tool.name)).toEqual(['read_file'])

    chunks.length = 0
    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 15,
        method: 'tools/call',
        params: { name: 'canvas_click', arguments: { ref: 'e1' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const callResponse = JSON.parse(chunks.join('').trim()) as {
      error: { code: number; message: string }
    }
    expect(callResponse.error.code).toBe(-32601)
    expect(callResponse.error.message).toContain('core MCP profile')
  })

  it('rejects a stale direct call outside the advertised core profile', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: { TASKWRAITH_MCP_CORE_SUBSET: '1' },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'canvas_eval', arguments: { expression: '1 + 1' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const response = JSON.parse(chunks.join('').trim()) as { error: { code: number; message: string } }
    expect(response.error.code).toBe(-32601)
    expect(response.error.message).toContain('core MCP profile')
  })

  it('rejects a hidden direct call outside the advertised gateway profile', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'unexpected' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }

    handleMcpJsonRpcMessage(
      {
        getDefaultSocketPath: () => '/tmp/taskwraith.sock',
        getAppVersion: () => '1.0.0',
        getMcpToolDefinitions: () => [],
        brokerRequest,
        env: { TASKWRAITH_MCP_GATEWAY_SUBSET: '1' },
        stdout: stream as never
      },
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'video_encode_clip',
          arguments: { inputPath: 'clip.mp4', outputPath: 'trimmed.mp4' }
        }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).not.toHaveBeenCalled()
    const response = JSON.parse(chunks.join('').trim()) as { error: { code: number; message: string } }
    expect(response.error.code).toBe(-32601)
    expect(response.error.message).toContain('gateway MCP profile')
    expect(response.error.message).toContain('capability_search and capability_invoke')
  })

  it('keeps run-scoped audit tools callable when the core profile is active', async () => {
    const brokerRequest = vi.fn(async () => ({ ok: true, text: 'recorded' }))
    const chunks: string[] = []
    const stream = {
      write: vi.fn((chunk: string) => {
        chunks.push(chunk)
        return true
      })
    }
    const deps = {
      getDefaultSocketPath: () => '/tmp/taskwraith.sock',
      getAppVersion: () => '1.0.0',
      getMcpToolDefinitions: () => [{ name: 'read_file' }],
      brokerRequest,
      env: {
        TASKWRAITH_MCP_CORE_SUBSET: '1',
        TASKWRAITH_MCP_AUDIT: '1'
      },
      stdout: stream as never
    }

    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      { jsonrpc: '2.0', id: 12, method: 'tools/list' },
      'line'
    )
    const listResponse = JSON.parse(chunks.join('').trim()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(listResponse.result.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'audit_set_profile',
      'audit_record_finding',
      'audit_record_verdict'
    ])

    chunks.length = 0
    handleMcpJsonRpcMessage(
      deps,
      '/tmp/taskwraith.sock',
      'token-1',
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'audit_record_finding', arguments: { claim: 'Finding' } }
      },
      'line'
    )
    await new Promise((resolve) => setImmediate(resolve))

    expect(brokerRequest).toHaveBeenCalledWith(
      '/tmp/taskwraith.sock',
      expect.objectContaining({ tool: 'audit_record_finding' })
    )
  })

  it('routes run-scoped audit tools through the main executor', async () => {
    const executeGeminiMcpTool = vi.fn(async () => ({ text: 'recorded' }))
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      executeGeminiMcpTool
    } as never)

    await runtime.handleGeminiMcpBrokerRequest({
      token: 'token-1',
      tool: 'audit_record_finding',
      arguments: { claim: 'Finding' },
      parentProvider: 'grok',
      appRunId: 'run-audit-1',
      appChatId: 'chat-1'
    })

    expect(executeGeminiMcpTool).toHaveBeenCalledWith(
      'audit_record_finding',
      { claim: 'Finding' },
      { appRunId: 'run-audit-1', appChatId: 'chat-1' },
      'grok',
      {}
    )
  })

  it('carries the core profile atomically in bridge argv', () => {
    const runtime = new McpBridgeRuntime({
      getGeminiMcpSocketPath: () => '/tmp/taskwraith.sock',
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false
    } as never)

    const args = runtime.taskwraithMcpBridgeArgs('/tmp/taskwraith.sock', false, false, true)

    expect(args).toContain(GEMINI_MCP_CORE_SUBSET_ARG)
    expect(args).toContain(GEMINI_MCP_LOG_EPOCH_ARG)
    expect(args[args.indexOf(GEMINI_MCP_LOG_EPOCH_ARG) + 1]).toMatch(/^\d+$/)
    expect(args[args.length - 1]).toBe(GEMINI_MCP_CORE_SUBSET_ARG)
  })

  it('carries the gateway profile atomically in bridge argv', () => {
    const runtime = new McpBridgeRuntime({
      getGeminiMcpSocketPath: () => '/tmp/taskwraith.sock',
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false
    } as never)

    const args = runtime.taskwraithMcpBridgeArgs(
      '/tmp/taskwraith.sock',
      false,
      false,
      false,
      true
    )

    expect(args).toContain(GEMINI_MCP_GATEWAY_SUBSET_ARG)
    expect(args[args.length - 1]).toBe(GEMINI_MCP_GATEWAY_SUBSET_ARG)
  })

  it('carries the mesh-direct catalogue receipt atomically beside the gateway profile', () => {
    const runtime = new McpBridgeRuntime({
      getGeminiMcpSocketPath: () => '/tmp/taskwraith.sock',
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false
    } as never)
    const args = runtime.taskwraithMcpBridgeArgs(
      '/tmp/taskwraith.sock',
      false,
      false,
      false,
      true,
      false,
      true
    )
    expect(args).toContain(GEMINI_MCP_GATEWAY_SUBSET_ARG)
    expect(args).toContain(GEMINI_MCP_MESH_DIRECT_ARG)
    expect(args.at(-1)).toBe(GEMINI_MCP_MESH_DIRECT_ARG)

    const env: Record<string, string | undefined> = {}
    applyMcpBridgeProfileArgvToEnv(args, env)
    expect(env.TASKWRAITH_MCP_MESH_DIRECT).toBe('1')
  })

  it('carries the sketch-direct v8 receipt atomically beside the gateway profile', () => {
    const runtime = new McpBridgeRuntime({
      getGeminiMcpSocketPath: () => '/tmp/taskwraith.sock',
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false
    } as never)
    const args = runtime.taskwraithMcpBridgeArgs(
      '/tmp/taskwraith.sock',
      false,
      false,
      false,
      true,
      false,
      false,
      true
    )
    expect(args).toContain(GEMINI_MCP_GATEWAY_SUBSET_ARG)
    expect(args).toContain(GEMINI_MCP_SKETCH_DIRECT_ARG)
    expect(args.at(-1)).toBe(GEMINI_MCP_SKETCH_DIRECT_ARG)

    const env: Record<string, string | undefined> = {}
    applyMcpBridgeProfileArgvToEnv(args, env)
    expect(env.TASKWRAITH_MCP_SKETCH_DIRECT).toBe('1')
  })

  it('translates the gateway argv receipt into the child catalogue guard', () => {
    const gatewayEnv: Record<string, string | undefined> = {}
    applyMcpBridgeProfileArgvToEnv(
      ['taskwraith', GEMINI_MCP_GATEWAY_SUBSET_ARG],
      gatewayEnv
    )
    expect(gatewayEnv).toEqual({ TASKWRAITH_MCP_GATEWAY_SUBSET: '1' })

    const fullEnv: Record<string, string | undefined> = {}
    applyMcpBridgeProfileArgvToEnv(['taskwraith'], fullEnv)
    expect(fullEnv).toEqual({})
  })

  it('rejects retired Kimi global MCP registration without invoking the provider CLI', async () => {
    const captureProcessOutput = vi.fn(
      async (_command: string, _args: string[]) => ({
        stdout: '',
        stderr: '',
        code: 0,
        timedOut: false
      })
    )
    const runtime = new McpBridgeRuntime({
      getGeminiMcpBrokerToken: () => 'token-1',
      isDev: () => false,
      getProcessExecPath: () => '/Applications/TaskWraith.app/TaskWraith',
      captureProcessOutput
    } as never)

    await expect(
      runtime.addKimiMcpBridgeRegistration('/usr/local/bin/kimi', '/tmp/taskwraith.sock')
    ).rejects.toThrow(
      'Global Kimi MCP registration is retired; managed Kimi uses a per-run authenticated HTTP gateway.'
    )
    expect(captureProcessOutput).not.toHaveBeenCalled()
  })

  it('fails closed for a legacy Kimi sender without starting global broker repair', async () => {
    const sendAgentCompatLine = vi.fn()
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: true }),
      sendAgentCompatLine
    } as never)
    vi.spyOn(runtime, 'startGeminiMcpBroker').mockResolvedValue()
    const repair = vi.spyOn(runtime, 'repairKimiMcpBridge').mockResolvedValue()

    await expect(runtime.prepareKimiMcpBridgeForRun({} as never)).resolves.toBe(false)
    expect(runtime.startGeminiMcpBroker).not.toHaveBeenCalled()
    expect(repair).not.toHaveBeenCalled()
    expect(sendAgentCompatLine).not.toHaveBeenCalled()

    await expect(runtime.prepareKimiMcpBridgeForRun(undefined as never)).resolves.toBe(false)
    expect(runtime.startGeminiMcpBroker).not.toHaveBeenCalled()
    expect(sendAgentCompatLine).not.toHaveBeenCalled()
  })

  it('reports Kimi gateway unavailable when the bridge setting is disabled', async () => {
    const runtime = new McpBridgeRuntime({
      getSettings: () => ({ geminiMcpBridgeEnabled: false })
    } as never)
    await expect(runtime.prepareKimiMcpBridgeForRun({} as never)).resolves.toBe(false)
  })
})
