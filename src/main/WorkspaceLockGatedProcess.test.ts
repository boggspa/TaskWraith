import { once } from 'node:events'
import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { spawnWorkspaceLockGatedProcess } from './WorkspaceLockGatedProcess'

const itPosix = process.platform === 'win32' ? it.skip : it

describe('spawnWorkspaceLockGatedProcess', () => {
  itPosix('does not execute until released and preserves the exact owner in the target', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'taskwraith-lock-gate-'))
    const gated = spawnWorkspaceLockGatedProcess(
      {
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({ owner: process.env.TASKWRAITH_LOCK_OWNER_ID || "missing", pid: process.pid }))'
        ],
        cwd,
        env: {
          PATH: process.env.PATH,
          TASKWRAITH_LOCK_OWNER_ID: 'ambient-owner'
        }
      },
      'exact-admitted-owner'
    )
    const gatePid = gated.child.pid
    let stdout = ''
    gated.child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stdout).toBe('')

    gated.start()
    await once(gated.child, 'close')

    expect(JSON.parse(stdout)).toEqual({
      owner: 'exact-admitted-owner',
      pid: gatePid
    })
  })

  itPosix('exits without executing when its parent disconnects before release', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'taskwraith-lock-gate-disconnect-'))
    const gated = spawnWorkspaceLockGatedProcess(
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("must-not-run")'],
        cwd,
        env: { PATH: process.env.PATH }
      },
      'exact-admitted-owner'
    )
    let stdout = ''
    gated.child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    gated.child.disconnect()
    await once(gated.child, 'exit')

    expect(stdout).toBe('')
  })

  itPosix('forwards provider stdin only after the exact gate is released', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'taskwraith-lock-gate-stdin-'))
    const gated = spawnWorkspaceLockGatedProcess(
      {
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.once("data", (chunk) => { process.stdout.write(chunk); process.exit(0) })'
        ],
        cwd,
        env: { PATH: process.env.PATH }
      },
      'exact-admitted-owner'
    )
    let stdout = ''
    gated.child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    gated.child.stdin?.write('provider prompt')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(stdout).toBe('')

    gated.start()
    await once(gated.child, 'close')

    expect(stdout).toBe('provider prompt')
  })

  itPosix('resolves a bare command from the exact sanitized PATH before execve', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'taskwraith-lock-gate-path-'))
    const bareCommand = 'taskwraith-test-provider'
    await symlink(process.execPath, join(cwd, bareCommand))
    const gated = spawnWorkspaceLockGatedProcess(
      {
        command: bareCommand,
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({ argv0: process.argv0, pid: process.pid, undefinedPresent: Object.hasOwn(process.env, "DROP_UNDEFINED") }))'
        ],
        cwd,
        env: {
          PATH: cwd,
          DROP_UNDEFINED: undefined
        }
      },
      'exact-admitted-owner'
    )
    const gatePid = gated.child.pid
    let stdout = ''
    gated.child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    gated.start()
    await once(gated.child, 'close')

    expect(JSON.parse(stdout)).toEqual({
      argv0: bareCommand,
      pid: gatePid,
      undefinedPresent: false
    })
  })

  it('fails closed before spawn when same-PID replacement is unavailable', () => {
    let spawned = false

    expect(() =>
      spawnWorkspaceLockGatedProcess(
        {
          command: '/provider',
          args: ['--run'],
          cwd: '/workspace',
          env: {}
        },
        'exact-admitted-owner',
        {
          platform: 'win32',
          execveAvailable: false,
          spawnProcess: (() => {
            spawned = true
            throw new Error('must not spawn')
          }) as never
        }
      )
    ).toThrow(/Same-PID workspace-lock process replacement is unavailable/)
    expect(spawned).toBe(false)
  })

  itPosix('rejects shell-string fallback before spawn', () => {
    expect(() =>
      spawnWorkspaceLockGatedProcess(
        {
          command: 'touch owned',
          args: [],
          cwd: '/workspace',
          env: {},
          shell: true
        },
        'exact-admitted-owner'
      )
    ).toThrow(/requires exact argv/)
  })

  itPosix('rejects malformed execve environment values before spawn', () => {
    expect(() =>
      spawnWorkspaceLockGatedProcess(
        {
          command: process.execPath,
          args: ['--version'],
          cwd: '/workspace',
          env: { MALFORMED: 'value\u0000suffix' }
        },
        'exact-admitted-owner'
      )
    ).toThrow(/environment is malformed/)
  })
})
