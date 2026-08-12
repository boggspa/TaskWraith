import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { InstructionStore } from './InstructionStore'
import { INSTRUCTION_LAYER_MAX_BYTES } from '../../shared/instructions/InstructionTypes'

let userDataPath: string
let store: InstructionStore

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-instr-store-'))
  store = new InstructionStore({ userDataPath, now: () => new Date('2026-08-11T12:00:00Z') })
})

afterEach(() => {
  fs.rmSync(userDataPath, { recursive: true, force: true })
})

describe('InstructionStore', () => {
  it('returns an empty document before any write', () => {
    const doc = store.readGlobalDocument()
    expect(doc.content).toBe('')
    expect(doc.updatedAt).toBeNull()
    expect(doc.sizeBytes).toBe(0)
  })

  it('round-trips a written document', () => {
    const written = store.writeGlobalDocument('# Global rules\n\nBe terse.\n')
    expect(written.updatedAt).toBe('2026-08-11T12:00:00.000Z')
    const read = store.readGlobalDocument()
    expect(read.content).toBe('# Global rules\n\nBe terse.\n')
    expect(read.sizeBytes).toBe(Buffer.byteLength('# Global rules\n\nBe terse.\n'))
    expect(read.updatedAt).not.toBeNull()
  })

  it('creates the instructions directory with owner-only permissions', () => {
    store.writeGlobalDocument('x')
    if (process.platform !== 'win32') {
      const mode = fs.statSync(store.instructionsRoot()).mode & 0o777
      expect(mode).toBe(0o700)
    }
  })

  it('rejects an over-cap write outright', () => {
    expect(() => store.writeGlobalDocument('a'.repeat(INSTRUCTION_LAYER_MAX_BYTES + 1))).toThrow(
      /limit/
    )
    expect(store.readGlobalDocument().content).toBe('')
  })

  it('refuses to write over a symlinked GLOBAL.md and reads it as empty', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-instr-store-outside-'))
    try {
      const target = path.join(outside, 'target.md')
      fs.writeFileSync(target, 'outside content')
      fs.mkdirSync(store.instructionsRoot(), { recursive: true, mode: 0o700 })
      fs.symlinkSync(target, store.globalDocumentPath())
      expect(() => store.writeGlobalDocument('new content')).toThrow(/non-regular/)
      expect(fs.readFileSync(target, 'utf8')).toBe('outside content')
      expect(store.readGlobalDocument().content).toBe('')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
