import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createHostNodeMuseResources } from './HostNodeMuseResources'

const paths: string[] = []
afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('resolves an explicit real binary and reads only bounded owner-safe auth text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-muse-res-'))
  paths.push(root)
  const binary = join(root, 'muse')
  const auth = join(root, 'auth.json')
  // @portability-ok: resolved via realpath only — never executed in this test
  writeFileSync(binary, '#!/bin/sh\n')
  chmodSync(binary, 0o700)
  writeFileSync(auth, '{"providers":{}}')
  chmodSync(auth, 0o600)
  const resources = createHostNodeMuseResources({
    executablePath: binary,
    authPath: auth,
    temporaryParent: root
  })
  await expect(resources.resolveBinary()).resolves.toMatchObject({
    // Separator-agnostic: realpath returns backslashes on win32.
    binaryPath: expect.stringMatching(/[\\/]muse$/),
    source: 'explicit'
  })
  await expect(resources.readAuthJsonText()).resolves.toContain('providers')
  expect(resources.getTemporaryRoot()).toContain(root)
  expect(resources.dispose()).toBe(true)
  expect(resources.dispose()).toBe(true)
})

it('rejects symlinked, loose-mode, or oversized auth artifacts without reading secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-muse-auth-'))
  paths.push(root)
  const target = join(root, 'target.json')
  const auth = join(root, 'auth.json')
  writeFileSync(target, '{}')
  chmodSync(target, 0o600)
  symlinkSync(target, auth)
  const resources = createHostNodeMuseResources({ authPath: auth, temporaryParent: root })
  await expect(resources.readAuthJsonText()).rejects.toThrow('Unsafe')
  rmSync(auth)
  writeFileSync(auth, '{}')
  // @portability-ok: octal modes are POSIX-only — NTFS reports fixed modes and owner-only is ACL-enforced
  if (process.platform !== 'win32') {
    chmodSync(auth, 0o644)
    await expect(resources.readAuthJsonText()).rejects.toThrow()
  }
  writeFileSync(auth, 'x'.repeat(1024 * 1024 + 1))
  chmodSync(auth, 0o600)
  await expect(resources.readAuthJsonText()).rejects.toThrow('Unsafe')
})

it('fails closed when auth changes after the bounded read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-muse-auth-race-'))
  paths.push(root)
  const auth = join(root, 'auth.json')
  writeFileSync(auth, '{}')
  chmodSync(auth, 0o600)
  const resources = createHostNodeMuseResources({
    authPath: auth,
    temporaryParent: root,
    afterAuthRead: () => writeFileSync(auth, '{"changed":true}')
  })
  await expect(resources.readAuthJsonText()).rejects.toThrow('changed')
})

it('adapts child spawn without shell and settles wait on error before close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-muse-spawn-'))
  paths.push(root)
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const end = vi.fn()
  const kill = vi.fn()
  Object.assign(child, { pid: 9, stdin: { end }, stdout, stderr, kill })
  const spawn = vi.fn(() => child) as never
  const resources = createHostNodeMuseResources({ temporaryParent: root, spawn })
  const handle = resources.spawn!({
    binaryPath: '/bin/muse',
    argv: ['exec', '--json'],
    cwd: root,
    env: { PATH: '/bin' },
    stdin: 'prompt'
  })
  const out = vi.fn()
  const err = vi.fn()
  handle.onStdout(out)
  handle.onStderr(err)
  stdout.emit('data', Buffer.from('out'))
  stderr.emit('data', Buffer.from('err'))
  handle.kill('SIGTERM')
  child.emit('error', new Error('spawn failed'))
  await expect(handle.wait()).resolves.toEqual({ code: null, signal: null })
  expect(spawn).toHaveBeenCalledWith(
    '/bin/muse',
    ['exec', '--json'],
    expect.objectContaining({ shell: false, cwd: root, env: { PATH: '/bin' }, stdio: 'pipe' })
  )
  expect(end).toHaveBeenCalledWith('prompt')
  expect(out).toHaveBeenCalledWith('out')
  expect(err).toHaveBeenCalledWith('err')
  expect(kill).toHaveBeenCalledWith('SIGTERM')
})
