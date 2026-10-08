import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  prepare,
  mainSource,
  snapshotSources
} = require('./journal-publication-electron-qualification.cjs')
const asar = require('@electron/asar')

it('builds the exact source snapshot as standalone ASAR entries without native launch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-publication-prepare-'))
  try {
    const prepared = await prepare(root)
    expect(
      asar.listPackage(prepared.archive).map((entry: string) => entry.split(path.sep).join('/'))
    ).toContain('/out/worker.cjs')
    expect(prepared.archiveSha256).toBe(
      createHash('sha256').update(fs.readFileSync(prepared.archive)).digest('hex')
    )
    for (const [file, hash] of Object.entries(prepared.sourceSha256)) {
      expect(
        createHash('sha256')
          .update(fs.readFileSync(path.join(root, 'source-snapshot', file)))
          .digest('hex')
      ).toBe(hash)
    }
    expect(prepared.env.OPENAI_API_KEY).toBeUndefined()
    expect(prepared.sourceSha256['src/main/store/CheckpointPreparationProtocol.ts']).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(
      fs.readFileSync(
        path.join(root, 'source-snapshot/src/main/store/CheckpointPreparationProtocol.ts'),
        'utf8'
      )
    ).toContain('outputDirectory:')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('records immutable relative import snapshots and never hashes later live mutations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-publication-snapshot-'))
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), "import {b} from './b'\nexport const a=b\n")
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b=1\n')
    const copies = path.join(root, 'copies')
    const hashes = snapshotSources(root, copies, { a: 'a.ts', alias: './a.ts' })
    expect(Object.keys(hashes).sort()).toEqual(['a.ts', 'b.ts'])
    fs.writeFileSync(path.join(root, 'b.ts'), 'export const b=2\n')
    expect(fs.readFileSync(path.join(copies, 'b.ts'), 'utf8')).toContain('b=1')
    expect(hashes['b.ts']).toBe(
      createHash('sha256')
        .update(fs.readFileSync(path.join(copies, 'b.ts')))
        .digest('hex')
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('requires browser Electron41 and nonzero revision/custody assertions without windows', () => {
  const source = mainSource()
  expect(source).toContain("process.type,'browser'")
  expect(source).toContain("captureSource('chat',2)")
  expect(source).toContain('JSON.stringify(second)')
  expect(source).toContain('sourceClosed,false')
  expect(source).not.toContain('new BrowserWindow')
})
