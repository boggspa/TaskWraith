import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises'
import os from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CODEX_CODE_MODE_HOST_ENV,
  codeModeHostBinaryName,
  resolveCodexCodeModeHostPath,
  withCodexCodeModeHostEnv
} from './CodexCodeModeHost'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), 'taskwraith-code-mode-host-'))
  tempDirs.push(dir)
  return dir
}

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\n')
  await chmod(path, 0o755)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveCodexCodeModeHostPath', () => {
  it('prefers a companion next to the selected Codex binary', async () => {
    const dir = await makeTempDir()
    const codexPath = join(dir, 'codex')
    const hostPath = join(dir, codeModeHostBinaryName())
    await makeExecutable(codexPath)
    await makeExecutable(hostPath)

    await expect(resolveCodexCodeModeHostPath(codexPath, ['/fallback/host'])).resolves.toBe(
      hostPath
    )
  })

  it('checks beside the real target of a Codex symlink', async () => {
    const dir = await makeTempDir()
    const installDir = join(dir, 'install')
    const binDir = join(dir, 'bin')
    await mkdir(installDir)
    await mkdir(binDir)
    const realCodexPath = join(installDir, 'codex')
    const hostPath = join(installDir, codeModeHostBinaryName())
    const linkedCodexPath = join(binDir, 'codex')
    await makeExecutable(realCodexPath)
    await makeExecutable(hostPath)
    await symlink(realCodexPath, linkedCodexPath)

    await expect(resolveCodexCodeModeHostPath(linkedCodexPath, [])).resolves.toBe(
      await realpath(hostPath)
    )
  })

  it('uses an executable fallback when a standalone CLI has no companion', async () => {
    const dir = await makeTempDir()
    const codexPath = join(dir, 'codex')
    const fallbackHostPath = join(dir, 'bundled-code-mode-host')
    await makeExecutable(codexPath)
    await makeExecutable(fallbackHostPath)

    await expect(resolveCodexCodeModeHostPath(codexPath, [fallbackHostPath])).resolves.toBe(
      fallbackHostPath
    )
  })

  it('ignores missing and non-executable candidates', async () => {
    const dir = await makeTempDir()
    const codexPath = join(dir, 'codex')
    const hostPath = join(dir, 'codex-code-mode-host')
    await makeExecutable(codexPath)
    await writeFile(hostPath, 'not executable')

    await expect(resolveCodexCodeModeHostPath(codexPath, ['/missing/host'])).resolves.toBeNull()
  })
})

describe('withCodexCodeModeHostEnv', () => {
  it('preserves an explicit host override', async () => {
    const env = { [CODEX_CODE_MODE_HOST_ENV]: '/custom/code-mode-host' }
    await expect(withCodexCodeModeHostEnv(env, '/missing/codex', [])).resolves.toBe(env)
  })

  it('adds the discovered companion without mutating the input env', async () => {
    const dir = await makeTempDir()
    const codexPath = join(dir, 'codex')
    const hostPath = join(dir, codeModeHostBinaryName())
    await makeExecutable(codexPath)
    await makeExecutable(hostPath)
    const env = { PATH: '/usr/bin' }

    const resolved = await withCodexCodeModeHostEnv(env, codexPath, [])

    expect(resolved).toEqual({ PATH: '/usr/bin', [CODEX_CODE_MODE_HOST_ENV]: hostPath })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
