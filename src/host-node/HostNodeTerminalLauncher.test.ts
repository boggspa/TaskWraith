import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { expect, it, vi } from 'vitest'

import { HostNodeTerminalLauncher } from './HostNodeTerminalLauncher'

function child(): ChildProcess & EventEmitter {
  return new EventEmitter() as ChildProcess & EventEmitter
}

it('hands off only the exact Muse login argv through inherited stdio without a shell', async () => {
  const spawned = child()
  const spawn = vi.fn(() => spawned)
  const launcher = new HostNodeTerminalLauncher({ spawn })
  let handedOff = false
  const launch = launcher.launch({ argv: ['/opt/muse', 'login'] }).then(() => {
    handedOff = true
  })

  expect(spawn).toHaveBeenCalledWith('/opt/muse', ['login'], { shell: false, stdio: 'inherit' })
  expect(handedOff).toBe(false)
  spawned.emit('spawn')
  await launch
  expect(handedOff).toBe(true)

  // The handoff is complete before the user-owned login process exits.
  spawned.emit('close', 0)
})

it('rejects a failed spawn handoff and permits a later retry', async () => {
  const first = child()
  const second = child()
  const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
  const launcher = new HostNodeTerminalLauncher({ spawn })

  const failed = launcher.launch({ argv: ['/opt/muse', 'login'] })
  first.emit('error', new Error('cannot spawn'))
  await expect(failed).rejects.toThrow('handoff failed')

  const retry = launcher.launch({ argv: ['/opt/muse', 'login'] })
  second.emit('spawn')
  await expect(retry).resolves.toBeUndefined()
})

it('rejects an overlapping duplicate handoff and malformed login commands', async () => {
  const spawned = child()
  const launcher = new HostNodeTerminalLauncher({ spawn: vi.fn(() => spawned) })
  const first = launcher.launch({ argv: ['/opt/muse', 'login'] })

  await expect(launcher.launch({ argv: ['/opt/muse', 'login'] })).rejects.toThrow('already pending')
  await expect(launcher.launch({ argv: ['/opt/muse', 'logout'] as never })).rejects.toThrow(
    'exact login command'
  )
  await expect(launcher.launch({ argv: ['relative/muse', 'login'] as never })).rejects.toThrow(
    'exact login command'
  )

  spawned.emit('spawn')
  await first
})

it('normalizes synchronous spawn failures without forwarding process details', async () => {
  const launcher = new HostNodeTerminalLauncher({
    spawn: (() => {
      throw new Error('/private/token')
    }) as unknown as (
      executable: string,
      args: readonly string[],
      options: SpawnOptions
    ) => ChildProcess
  })

  await expect(launcher.launch({ argv: ['/opt/muse', 'login'] })).rejects.toThrow(
    'handoff could not start'
  )
})
