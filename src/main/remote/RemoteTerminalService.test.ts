import { describe, expect, it, vi } from 'vitest'
import { RemoteTerminalService } from './RemoteTerminalService'

type DataHandler = (data: string) => void
type ExitHandler = (event: { exitCode: number }) => void

function fakePtyFactory() {
  const spawned: Array<{
    write: ReturnType<typeof vi.fn>
    resize: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    emitData: DataHandler
    emitExit: ExitHandler
    options: Record<string, unknown>
  }> = []
  const spawn = ((file: string, _args: string[], options: Record<string, unknown>) => {
    let dataHandler: DataHandler = () => {}
    let exitHandler: ExitHandler = () => {}
    const handle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (h: DataHandler) => {
        dataHandler = h
        return { dispose: () => {} }
      },
      onExit: (h: ExitHandler) => {
        exitHandler = h
        return { dispose: () => {} }
      },
      pid: 4242,
      cols: 80,
      rows: 24,
      process: file,
      handleFlowControl: false,
      pause: () => {},
      resume: () => {},
      clear: () => {}
    }
    spawned.push({
      write: handle.write,
      resize: handle.resize,
      kill: handle.kill,
      emitData: (d) => dataHandler(d),
      emitExit: (e) => exitHandler(e),
      options
    })
    return handle
  }) as never
  return { spawn, spawned }
}

describe('RemoteTerminalService', () => {
  it('opens in the RESOLVED workspace cwd, rings output, and reads by sequence', () => {
    const { spawn, spawned } = fakePtyFactory()
    const service = new RemoteTerminalService({ spawn })
    const opened = service.open({ workspaceId: 'ws-1', workspacePath: '/tmp/ws', cols: 100 })
    expect(opened.ok).toBe(true)
    expect(spawned[0].options.cwd).toBe('/tmp/ws')
    expect(spawned[0].options.cols).toBe(100)
    if (!opened.ok) return
    spawned[0].emitData('hello ')
    spawned[0].emitData('world')
    const all = service.read(opened.terminalId, 0)
    expect(all.ok && all.chunks.length).toBe(2)
    const tail = service.read(opened.terminalId, 1)
    if (tail.ok) {
      expect(tail.chunks).toHaveLength(1)
      expect(Buffer.from(tail.chunks[0].dataBase64, 'base64').toString()).toBe('world')
      expect(tail.latestSeq).toBe(2)
    }
  })

  it('bounds input, refuses input after exit, and reports the exit in-band', () => {
    const { spawn, spawned } = fakePtyFactory()
    const service = new RemoteTerminalService({ spawn })
    const opened = service.open({ workspaceId: 'ws-1', workspacePath: '/tmp/ws' })
    if (!opened.ok) throw new Error('open failed')
    expect(service.input(opened.terminalId, Buffer.from('ls\n').toString('base64')).ok).toBe(true)
    expect(spawned[0].write).toHaveBeenCalledWith('ls\n')
    expect(service.input(opened.terminalId, 'not-base64-!!!').ok).toBe(false)
    expect(service.input(opened.terminalId, Buffer.alloc(9000).toString('base64')).ok).toBe(false)
    spawned[0].emitExit({ exitCode: 0 })
    expect(service.input(opened.terminalId, Buffer.from('x').toString('base64'))).toEqual({
      ok: false,
      reason: 'Shell has exited'
    })
    const read = service.read(opened.terminalId, 0)
    expect(read.ok && read.exited).toBe(true)
    if (read.ok) {
      const text = read.chunks
        .map((chunk) => Buffer.from(chunk.dataBase64, 'base64').toString())
        .join('')
      expect(text).toContain('[shell exited: 0]')
    }
  })

  it('caps concurrent sessions and reaps idle ones on the sweep', () => {
    const { spawn } = fakePtyFactory()
    let nowMs = 1_000_000
    const service = new RemoteTerminalService({ spawn, now: () => nowMs })
    for (let index = 0; index < 3; index += 1) {
      expect(service.open({ workspaceId: 'ws', workspacePath: '/tmp/ws' }).ok).toBe(true)
    }
    const fourth = service.open({ workspaceId: 'ws', workspacePath: '/tmp/ws' })
    expect(fourth.ok).toBe(false)
    // Eleven idle minutes later the sweep reaps them all and a new open fits.
    nowMs += 11 * 60 * 1000
    expect(service.sessionCount()).toBe(0)
    expect(service.open({ workspaceId: 'ws', workspacePath: '/tmp/ws' }).ok).toBe(true)
  })
})
