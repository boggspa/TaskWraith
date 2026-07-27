import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskWraithTuiDemoState } from '../../tui/state'
import { TaskWraithControlClient } from '../../tui/client/TaskWraithControlClient'
import { TASKWRAITH_CONTROL_MAX_LINE_BYTES } from '../../shared/taskWraithControlProtocol'
import { LocalControlServer } from './LocalControlServer'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

describe('LocalControlServer', () => {
  it('authenticates a TUI client and delegates only the bounded facade methods', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-'))
    const demo = createTaskWraithTuiDemoState(1_000)
    if (!demo.snapshot || !demo.thread) throw new Error('Demo projection is incomplete.')
    const sendPrompt = vi.fn(async () => ({
      dispatched: true,
      message: 'Prompt dispatched'
    }))
    const cancelRun = vi.fn(async () => ({
      cancelled: true,
      message: 'Run cancelled'
    }))
    const server = new LocalControlServer({
      userDataPath,
      hostVersion: '1.8.9-test',
      pollIntervalMs: 25,
      facade: {
        snapshot: () => demo.snapshot!,
        selectThread: (threadId) => {
          if (threadId !== 'demo-thread') throw new Error('Thread not found.')
          return demo.thread!
        },
        sendPrompt,
        cancelRun
      }
    })
    await server.start()
    cleanup.push(() => server.stop())

    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      userDataPath
    })
    cleanup.push(() => client.close())

    const welcome = await client.connect()
    expect(welcome.hostVersion).toBe('1.8.9-test')
    expect((await client.getSnapshot()).threads[0]?.id).toBe('demo-thread')
    expect((await client.selectThread('demo-thread')).rows).toHaveLength(3)
    await expect(client.sendPrompt('demo-thread', 'hello')).resolves.toMatchObject({
      dispatched: true
    })
    await expect(client.cancelRun('demo-thread')).resolves.toMatchObject({
      cancelled: true
    })
    expect(sendPrompt).toHaveBeenCalledWith('demo-thread', 'hello')
    expect(cancelRun).toHaveBeenCalledWith('demo-thread')

    if (process.platform !== 'win32') {
      expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600)
    }
    expect((await stat(server.tokenPath)).mode & 0o777).toBe(0o600)
    const discovery = JSON.parse(await readFile(server.discoveryPath, 'utf8')) as {
      tokenPath: string
      socketPath: string
    }
    expect(discovery.tokenPath).toBe(server.tokenPath)
    expect(discovery.socketPath).toBe(server.socketPath)
    expect(await readFile(server.tokenPath, 'utf8')).not.toContain('1.8.9-test')

    server.stopSync()
    await expect(stat(server.discoveryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(server.tokenPath)).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.platform !== 'win32') {
      await expect(stat(server.socketPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('returns a bounded error instead of writing an oversized projection', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-control-large-'))
    const demo = createTaskWraithTuiDemoState(1_000)
    if (!demo.snapshot || !demo.thread) throw new Error('Demo projection is incomplete.')
    const oversizedSnapshot = {
      ...demo.snapshot,
      workspaces: [
        {
          ...demo.snapshot.workspaces[0],
          name: 'x'.repeat(TASKWRAITH_CONTROL_MAX_LINE_BYTES + 1)
        }
      ]
    }
    const server = new LocalControlServer({
      userDataPath,
      hostVersion: '1.8.9-test',
      pollIntervalMs: 25,
      facade: {
        snapshot: () => oversizedSnapshot,
        selectThread: () => demo.thread!,
        sendPrompt: async () => ({ dispatched: true, message: 'ok' }),
        cancelRun: async () => ({ cancelled: true, message: 'ok' })
      }
    })
    await server.start()
    cleanup.push(() => server.stop())

    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      userDataPath
    })
    cleanup.push(() => client.close())
    await client.connect()

    await expect(client.getSnapshot()).rejects.toThrow('projection is too large')
    await expect(client.ping()).resolves.toHaveProperty('now')
  })
})
