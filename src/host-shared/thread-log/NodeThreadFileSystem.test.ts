import { constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  canTreatThreadPathAsMissing,
  canTreatThreadPathAsMissingSync,
  openThreadFile,
  renameThreadFile
} from './NodeThreadFileSystem'

const errno = (code: string) => Object.assign(new Error(code), { code })

describe('native thread-file operations', () => {
  it.each([true, false])(
    'distinguishes a missing child from an unusable parent (%s)',
    async (directory) => {
      const root = resolve('synthetic-parent')
      const file = join(root, 'absent', 'thread.json')
      const probe = (path: string) => {
        if (path !== root) throw errno('ENOENT')
        return { isDirectory: () => directory }
      }
      expect(canTreatThreadPathAsMissingSync(file, probe)).toBe(directory)
      await expect(canTreatThreadPathAsMissing(file, async (path) => probe(path))).resolves.toBe(
        directory
      )
    }
  )

  it('never treats an inaccessible parent as evidence of absence', async () => {
    const probe = () => {
      throw errno('EACCES')
    }
    expect(canTreatThreadPathAsMissingSync(resolve('thread.json'), probe)).toBe(false)
    await expect(
      canTreatThreadPathAsMissing(resolve('thread.json'), async () => probe())
    ).resolves.toBe(false)
  })

  it('retries Windows sharing failures without reporting success before the rename', async () => {
    const move = vi
      .fn()
      .mockRejectedValueOnce(errno('EPERM'))
      .mockRejectedValueOnce(errno('EBUSY'))
      .mockResolvedValue(undefined)
    const wait = vi.fn(async () => {})
    await renameThreadFile('from', 'to', { platform: 'win32', rename: move, wait })
    expect(move).toHaveBeenCalledTimes(3)
    expect(wait.mock.calls).toEqual([[20], [20]])
  })

  it.each(['win32', 'linux'] as const)('bounds sharing retries on %s', async (platform) => {
    const error = errno('EACCES')
    const move = vi.fn(async () => {
      throw error
    })
    const wait = vi.fn(async () => {})
    await expect(renameThreadFile('from', 'to', { platform, rename: move, wait })).rejects.toBe(
      error
    )
    expect(move).toHaveBeenCalledTimes(platform === 'win32' ? 10 : 1)
    expect(wait).toHaveBeenCalledTimes(platform === 'win32' ? 9 : 0)
  })

  it('does not retry a Windows disk or missing-file error', async () => {
    const wait = vi.fn(async () => {})
    for (const code of ['EIO', 'ENOSPC', 'ENOENT']) {
      const error = errno(code)
      const move = vi.fn(async () => {
        throw error
      })
      await expect(
        renameThreadFile('from', 'to', { platform: 'win32', rename: move, wait })
      ).rejects.toBe(error)
      expect(move).toHaveBeenCalledOnce()
    }
    expect(wait).not.toHaveBeenCalled()
  })

  it('refuses symlinks without O_NOFOLLOW while permitting regular files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'thread-file-open-'))
    try {
      const target = join(root, 'target.json')
      writeFileSync(target, '{}')
      const linked = join(root, 'linked.json')
      symlinkSync(target, linked)
      await expect(openThreadFile(linked, constants.O_RDONLY, 'win32')).rejects.toMatchObject({
        code: 'EINVAL'
      })
      const handle = await openThreadFile(target, constants.O_RDONLY, 'win32')
      try {
        expect(await handle.readFile('utf8')).toBe('{}')
      } finally {
        await handle.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
