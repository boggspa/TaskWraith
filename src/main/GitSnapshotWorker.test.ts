import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRepositorySnapshot } from './services/GitService'

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  setPriority: vi.fn()
}))

vi.mock('electron', () => ({
  utilityProcess: { fork: mocks.fork }
}))

vi.mock('node:os', () => ({
  constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } },
  setPriority: mocks.setPriority
}))

import { GitSnapshotWorkerClient } from './GitSnapshotWorker'

class FakeUtilityProcess extends EventEmitter {
  pid = 4242
  kill = vi.fn()
  postMessage = vi.fn()
}

function snapshot(): GitRepositorySnapshot {
  return {
    requestedPath: '/repo',
    repoRoot: '/repo',
    branch: 'master',
    commit: 'abc123',
    detached: false,
    ahead: 0,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 }
  }
}

describe('GitSnapshotWorkerClient', () => {
  beforeEach(() => {
    mocks.fork.mockReset()
    mocks.setPriority.mockReset()
  })

  it('reuses one deprioritized utility process for detailed snapshots', async () => {
    const child = new FakeUtilityProcess()
    mocks.fork.mockReturnValue(child)
    const client = new GitSnapshotWorkerClient('/git-worker.js')

    const first = client.snapshot('/repo')
    expect(child.postMessage).toHaveBeenLastCalledWith({
      type: 'snapshot',
      requestId: 1,
      inputPath: '/repo'
    })
    child.emit('message', {
      type: 'snapshot-complete',
      requestId: 1,
      result: { ok: true, data: snapshot() }
    })
    await expect(first).resolves.toEqual({ ok: true, data: snapshot() })

    const second = client.snapshot('/repo')
    child.emit('message', {
      type: 'snapshot-complete',
      requestId: 2,
      result: { ok: true, data: snapshot() }
    })
    await expect(second).resolves.toEqual({ ok: true, data: snapshot() })
    expect(mocks.fork).toHaveBeenCalledOnce()
    expect(mocks.fork).toHaveBeenCalledWith('/git-worker.js', [], {
      serviceName: 'taskwraith-git-snapshot',
      execArgv: ['--max-old-space-size=256']
    })
    expect(mocks.setPriority).toHaveBeenCalledWith(4242, 10)
  })

  it('fails pending reads compactly when the worker exits and restarts next time', async () => {
    const firstChild = new FakeUtilityProcess()
    const secondChild = new FakeUtilityProcess()
    mocks.fork.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild)
    const client = new GitSnapshotWorkerClient('/git-worker.js')

    const first = client.snapshot('/repo')
    firstChild.emit('exit', 9)
    await expect(first).resolves.toEqual({
      ok: false,
      error: 'Git snapshot utility process exited with code 9.'
    })

    const second = client.snapshot('/repo')
    expect(mocks.fork).toHaveBeenCalledTimes(2)
    secondChild.emit('message', {
      type: 'snapshot-complete',
      requestId: 2,
      result: { ok: true, data: snapshot() }
    })
    await expect(second).resolves.toEqual({ ok: true, data: snapshot() })
  })
})
