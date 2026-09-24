import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { isHostPayloadVersion, resolveHostPayloadVersion } from './HostPayloadIdentity'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function payload(files: ReadonlyArray<readonly [string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-host-payload-'))
  roots.push(root)
  for (const [relative, body] of files) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return root
}

it('derives an order-independent SHA-256 identity from shipped payload bytes', () => {
  const first = payload([
    ['host-runtime/cli.js', 'cli-v1'],
    ['host-node/server.js', 'server-v1'],
    ['host-node/server.js.map', 'ignored-map-v1']
  ])
  const same = payload([
    ['host-node/server.js.map', 'ignored-map-v2'],
    ['host-node/server.js', 'server-v1'],
    ['host-runtime/cli.js', 'cli-v1']
  ])
  const changed = payload([
    ['host-runtime/cli.js', 'cli-v1'],
    ['host-node/server.js', 'server-v2']
  ])

  const version = resolveHostPayloadVersion(first)
  expect(version).toMatch(/^sha256:[a-f0-9]{64}$/)
  expect(isHostPayloadVersion(version)).toBe(true)
  expect(resolveHostPayloadVersion(same)).toBe(version)
  expect(resolveHostPayloadVersion(changed)).not.toBe(version)
  expect(isHostPayloadVersion('node-host-v1')).toBe(false)
})
