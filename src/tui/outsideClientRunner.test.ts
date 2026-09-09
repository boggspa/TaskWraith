import { describe, expect, it, vi } from 'vitest'
import type {
  TaskWraithControlThreadFindParams,
  TaskWraithControlThreadFindResult,
  TaskWraithControlThreadSummary
} from '../shared/taskWraithControlProtocol'
import type { OutsideSocketCommand } from './outsideCommand'
import {
  runOutsideCommand,
  type OutsideClientPort,
  type OutsideCommandIo
} from './outsideClientRunner'

function thread(overrides: Partial<TaskWraithControlThreadSummary> = {}) {
  return {
    id: 'thread-1',
    title: 'Host persistence',
    status: 'running',
    chatKind: 'ensemble',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    archived: false,
    updatedAt: 1_700_000_000_000,
    messageCount: 12,
    provider: { displayProvider: 'Codex' },
    ...overrides
  } as TaskWraithControlThreadSummary
}

function harness(threads: TaskWraithControlThreadSummary[]) {
  const out: string[] = []
  const err: string[] = []
  const findThreads = vi.fn(
    async (
      _params: TaskWraithControlThreadFindParams
    ): Promise<TaskWraithControlThreadFindResult> => ({
      threads,
      total: threads.length
    })
  )
  const sendPrompt = vi.fn(async () => ({ dispatched: true, message: 'Prompt dispatched.' }))
  const close = vi.fn()
  const selectThread = vi.fn(async () => ({
    rows: [
      {
        id: 'r1',
        role: 'user',
        speaker: 'External Agent',
        text: 'nice work',
        timestamp: '2026-09-09T10:00:00.000Z',
        truncated: false
      },
      {
        id: 'r2',
        role: 'assistant',
        speaker: 'Codex',
        text: 'thanks',
        timestamp: '2026-09-09T10:00:09.000Z',
        truncated: false
      }
    ],
    totalRows: 2,
    hasMoreAbove: false
  }))
  const port: OutsideClientPort = {
    connect: vi.fn(async () => undefined),
    findThreads,
    sendPrompt,
    selectThread: selectThread as unknown as OutsideClientPort['selectThread'],
    close
  }
  const io: OutsideCommandIo = {
    identity: { pid: 84536, label: 'Claude Code' },
    openClient: vi.fn(async () => port),
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    readStdin: vi.fn(async () => '')
  }
  return { io, out, err, findThreads, sendPrompt, selectThread, close, port }
}

const threadsCommand: OutsideSocketCommand = { kind: 'threads', cwd: '/repo/worktree', json: false }
const sendCommand: OutsideSocketCommand = {
  kind: 'send',
  selector: 'Host persistence',
  text: 'nice work',
  cwd: '/repo/worktree',
  json: false
}

describe('runOutsideCommand — threads', () => {
  it('scopes the lookup to the working tree and lists what it found', async () => {
    const h = harness([thread()])
    expect(await runOutsideCommand(threadsCommand, h.io)).toBe(0)
    expect(h.findThreads).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/repo/worktree' })
    )
    expect(h.out.join('\n')).toContain('thread-1')
    expect(h.out.join('\n')).toContain('Host persistence')
  })

  it('omits the workspace filter when the command asked for every workspace', async () => {
    const h = harness([thread()])
    await runOutsideCommand({ kind: 'threads', json: false }, h.io)
    expect(h.findThreads.mock.calls[0]?.[0]).not.toHaveProperty('workspacePath')
  })

  it('emits machine output on --json', async () => {
    const h = harness([thread()])
    await runOutsideCommand({ ...threadsCommand, json: true }, h.io)
    expect(JSON.parse(h.out.join('\n'))).toMatchObject({ threads: [{ id: 'thread-1' }], total: 1 })
  })

  it('says so plainly when this working tree has no threads', async () => {
    const h = harness([])
    expect(await runOutsideCommand(threadsCommand, h.io)).toBe(0)
    expect(h.out.join('\n')).toMatch(/no threads/i)
  })

  it('always closes the socket, so the host never keeps a dead client', async () => {
    const h = harness([thread()])
    await runOutsideCommand(threadsCommand, h.io)
    expect(h.close).toHaveBeenCalled()
  })
})

describe('runOutsideCommand — send', () => {
  it('resolves the selector, sends once, and reports the host message', async () => {
    const h = harness([thread()])
    expect(await runOutsideCommand(sendCommand, h.io)).toBe(0)
    expect(h.sendPrompt).toHaveBeenCalledWith('thread-1', 'nice work')
    expect(h.out.join('\n')).toContain('Prompt dispatched.')
  })

  it('presents the resolved sender identity to the client so the host can stamp the row', async () => {
    const h = harness([thread()])
    await runOutsideCommand(sendCommand, h.io)
    expect(h.io.openClient).toHaveBeenCalledWith({ pid: 84536, label: 'Claude Code' })
  })

  it('prefers an exact id over a title that merely contains it', async () => {
    const h = harness([
      thread({ id: 'other', title: 'about thread-1' }),
      thread({ id: 'thread-1' })
    ])
    await runOutsideCommand({ ...sendCommand, selector: 'thread-1' }, h.io)
    expect(h.sendPrompt).toHaveBeenCalledWith('thread-1', 'nice work')
  })

  it('refuses an ambiguous selector and names the candidates instead of guessing', async () => {
    const h = harness([
      thread({ id: 'a', title: 'Host one' }),
      thread({ id: 'b', title: 'Host two' })
    ])
    expect(await runOutsideCommand({ ...sendCommand, selector: 'Host' }, h.io)).toBe(1)
    expect(h.sendPrompt).not.toHaveBeenCalled()
    const text = h.err.join('\n')
    expect(text).toContain('a')
    expect(text).toContain('b')
  })

  it('refuses when nothing matches in this working tree', async () => {
    const h = harness([])
    expect(await runOutsideCommand(sendCommand, h.io)).toBe(1)
    expect(h.sendPrompt).not.toHaveBeenCalled()
    expect(h.err.join('\n')).toMatch(/no thread/i)
  })

  it('reads the prompt from stdin when the command carried no text', async () => {
    const h = harness([thread()])
    h.io.readStdin = vi.fn(async () => '  piped body\n')
    const { text: _dropped, ...withoutText } = sendCommand as Extract<
      OutsideSocketCommand,
      { kind: 'send' }
    >
    await runOutsideCommand(withoutText as OutsideSocketCommand, h.io)
    expect(h.sendPrompt).toHaveBeenCalledWith('thread-1', 'piped body')
  })

  it('refuses an empty prompt rather than sending a blank row', async () => {
    const h = harness([thread()])
    h.io.readStdin = vi.fn(async () => '   \n')
    const { text: _dropped, ...withoutText } = sendCommand as Extract<
      OutsideSocketCommand,
      { kind: 'send' }
    >
    expect(await runOutsideCommand(withoutText as OutsideSocketCommand, h.io)).toBe(2)
    expect(h.sendPrompt).not.toHaveBeenCalled()
  })

  it('reports a refused dispatch as a failing exit code', async () => {
    const h = harness([thread()])
    h.port.sendPrompt = vi.fn(async () => ({ dispatched: false, message: 'Thread is busy.' }))
    expect(await runOutsideCommand(sendCommand, h.io)).toBe(1)
    expect(h.err.join('\n')).toContain('Thread is busy.')
  })

  it('closes the socket even when the send throws', async () => {
    const h = harness([thread()])
    h.port.sendPrompt = vi.fn(async () => {
      throw new Error('socket died')
    })
    await expect(runOutsideCommand(sendCommand, h.io)).rejects.toThrow(/socket died/)
    expect(h.close).toHaveBeenCalled()
  })
})

const readCommand: OutsideSocketCommand = {
  kind: 'read',
  selector: 'Host persistence',
  cwd: '/repo/worktree',
  json: false
}

describe('runOutsideCommand — read', () => {
  it('resolves the selector and prints each row with its speaker', async () => {
    const h = harness([thread()])
    expect(await runOutsideCommand(readCommand, h.io)).toBe(0)
    expect(h.selectThread).toHaveBeenCalledWith('thread-1', undefined)
    const text = h.out.join('\n')
    expect(text).toContain('External Agent')
    expect(text).toContain('nice work')
    expect(text).toContain('Codex')
    expect(text).toContain('thanks')
  })

  it('passes an explicit row limit to the host', async () => {
    const h = harness([thread()])
    await runOutsideCommand({ ...readCommand, limit: 5 }, h.io)
    expect(h.selectThread).toHaveBeenCalledWith('thread-1', 5)
  })

  it('emits the rows verbatim on --json', async () => {
    const h = harness([thread()])
    await runOutsideCommand({ ...readCommand, json: true }, h.io)
    const parsed = JSON.parse(h.out.join('\n'))
    expect(parsed).toMatchObject({ threadId: 'thread-1', totalRows: 2 })
    expect(parsed.rows).toHaveLength(2)
  })

  it('refuses an ambiguous selector without reading anything', async () => {
    const h = harness([
      thread({ id: 'a', title: 'Host one' }),
      thread({ id: 'b', title: 'Host two' })
    ])
    expect(await runOutsideCommand({ ...readCommand, selector: 'Host' }, h.io)).toBe(1)
    expect(h.selectThread).not.toHaveBeenCalled()
  })

  it('refuses when nothing matches in this working tree', async () => {
    const h = harness([])
    expect(await runOutsideCommand(readCommand, h.io)).toBe(1)
    expect(h.selectThread).not.toHaveBeenCalled()
    expect(h.err.join('\n')).toMatch(/no thread/i)
  })

  it('says so plainly when the thread has no rows yet', async () => {
    const h = harness([thread()])
    h.port.selectThread = vi.fn(async () => ({
      rows: [],
      totalRows: 0,
      hasMoreAbove: false
    })) as unknown as OutsideClientPort['selectThread']
    expect(await runOutsideCommand(readCommand, h.io)).toBe(0)
    expect(h.out.join('\n')).toMatch(/no messages/i)
  })

  it('closes the socket after reading', async () => {
    const h = harness([thread()])
    await runOutsideCommand(readCommand, h.io)
    expect(h.close).toHaveBeenCalled()
  })
})
