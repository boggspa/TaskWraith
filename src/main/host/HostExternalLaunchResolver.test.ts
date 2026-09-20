import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHostExternalLaunch } from './HostExternalLaunchResolver'

const cwdProbe = String.raw`
const { Worker } = require('node:worker_threads')
const failure = (error) => ({
  ok: false,
  code: error && error.code,
  syscall: error && error.syscall,
  message: error instanceof Error ? error.message : String(error)
})
const finish = (value) => process.send({ type: 'result', ...value }, () => process.exit(0))
process.send({ type: 'ready' })
process.once('message', () => {
  let worker
  try {
    worker = new Worker(
      "const { parentPort } = require('node:worker_threads'); try { parentPort.postMessage({ ok: true, cwd: process.cwd() }) } catch (error) { parentPort.postMessage({ ok: false, code: error.code, syscall: error.syscall, message: error.message }) }",
      { eval: true }
    )
  } catch (error) {
    finish(failure(error))
    return
  }
  worker.once('message', finish)
  worker.once('error', (error) => finish(failure(error)))
})
`

async function probeCwdAfterReplacement(cwd: string, replacePayload: () => void) {
  const child = spawn(process.execPath, ['-e', cwdProbe], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  const exit = once(child, 'exit')
  try {
    const [ready] = await once(child, 'message')
    expect(ready).toEqual({ type: 'ready' })
    replacePayload()
    const result = once(child, 'message')
    child.send({ type: 'continue' })
    const [message] = await result
    await exit
    return message as {
      type: 'result'
      ok: boolean
      cwd?: string
      code?: string
      syscall?: string
      message?: string
    }
  } finally {
    if (child.exitCode === null) child.kill()
  }
}

function createFakePayload(root: string): string {
  const cliDirectory = join(root, 'out', 'host', 'host-runtime')
  mkdirSync(cliDirectory, { recursive: true })
  writeFileSync(join(cliDirectory, 'cli.js'), '// fake Host payload\n')
  return cliDirectory
}

function replaceFakePayload(root: string): void {
  rmSync(root, { recursive: true, force: true })
  createFakePayload(root)
}

describe('HostExternalLaunchResolver', () => {
  const payloadVersion = `sha256:${'a'.repeat(64)}`

  it('resolves packaged Node/Host CLI paths without Electron arguments', async () => {
    const node = '/App/Resources/tui-runtime/darwin-arm64/node'
    const cli = '/App/Resources/host/host-runtime/cli.js'
    await expect(
      resolveHostExternalLaunch({
        packaged: true,
        profilePath: '/profiles/a',
        resourcesPath: '/App/Resources',
        platform: 'darwin',
        architecture: 'arm64',
        env: { ELECTRON_RUN_AS_NODE: '1' },
        resolvePayloadVersion: () => payloadVersion,
        pathExists: async (path) => path === node || path === cli
      })
    ).resolves.toEqual({
      executable: node,
      args: [cli, 'serve', '--mode', 'production', '--profile', '/profiles/a'],
      cwd: '/profiles/a',
      env: {},
      payloadVersion
    })
  })

  it('keeps the detached Host cwd valid when an installed payload is replaced', async () => {
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'host-launch-cwd-')))
    const profile = join(temporaryRoot, 'profile')
    const payload = join(temporaryRoot, 'TaskWraith-install')
    mkdirSync(profile)
    const oldPayloadCwd = createFakePayload(payload)

    try {
      const command = await resolveHostExternalLaunch({
        packaged: false,
        profilePath: profile,
        repoRoot: payload,
        platform: process.platform,
        nodeExecutable: process.execPath,
        isOrdinaryNode: () => true,
        resolvePayloadVersion: () => payloadVersion,
        pathExists: async (path) => existsSync(path)
      })
      if (!command) throw new Error('Fake Host payload was not resolved')
      expect(command.cwd).toBe(profile)

      if (process.platform !== 'win32') {
        const broken = await probeCwdAfterReplacement(oldPayloadCwd, () =>
          replaceFakePayload(payload)
        )
        expect(broken).toMatchObject({
          type: 'result',
          ok: false,
          code: 'ENOENT',
          syscall: 'uv_cwd'
        })
      }

      const healthy = await probeCwdAfterReplacement(command.cwd, () => replaceFakePayload(payload))
      expect(healthy).toEqual({ type: 'result', ok: true, cwd: profile })
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects Electron as a development Node executable', async () => {
    await expect(
      resolveHostExternalLaunch({
        packaged: false,
        profilePath: '/profiles/a',
        repoRoot: '/repo',
        platform: 'darwin',
        nodeExecutable: '/repo/Electron',
        resolvePayloadVersion: () => payloadVersion,
        pathExists: async () => true
      })
    ).rejects.toThrow('ordinary Node')
  })

  it.each([
    ['win32', 'x64', 'C:\\App\\resources', 'C:\\profiles\\a', 'node.exe'],
    ['linux', 'arm64', '/app/resources', '/profiles/a', 'node']
  ] as const)(
    'resolves packaged %s-%s runtime',
    async (platform, architecture, resourcesPath, profilePath, nodeName) => {
      const apiPath = platform === 'win32' ? '\\' : '/'
      const node = `${resourcesPath}${apiPath}tui-runtime${apiPath}${platform}-${architecture}${apiPath}${nodeName}`
      const cli = `${resourcesPath}${apiPath}host${apiPath}host-runtime${apiPath}cli.js`
      const result = await resolveHostExternalLaunch({
        packaged: true,
        profilePath,
        resourcesPath,
        platform,
        architecture,
        resolvePayloadVersion: () => payloadVersion,
        pathExists: async (value) => value === node || value === cli
      })
      expect(result?.executable).toBe(node)
      expect(result?.args).toEqual([cli, 'serve', '--mode', 'production', '--profile', profilePath])
      expect(result?.payloadVersion).toBe(payloadVersion)
    }
  )
})
