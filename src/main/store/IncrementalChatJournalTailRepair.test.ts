import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { measureSegmentTail, repairSegmentTornTail } from './IncrementalChatJournalTailRepair'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-tail-repair-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

/** A line is valid when it is JSON with `ok: true`; an empty line is skipped. */
function isValidLine(line: Buffer): boolean {
  if (line.length === 0) return true
  try {
    return (JSON.parse(line.toString('utf8')) as { ok?: unknown }).ok === true
  } catch {
    return false
  }
}

const line = (text: string): Buffer => Buffer.from(`${JSON.stringify({ ok: true, text })}\n`)
// Two-, three- and four-byte characters, so most cut points fall inside one.
const LINES = [line('plain ascii'), line('café € \u{1f600}'), line('日本語')]
const ALL = Buffer.concat(LINES)

describe('measureSegmentTail', () => {
  it('measures nothing in an empty segment or one that is only a fragment', () => {
    expect(measureSegmentTail(Buffer.alloc(0), isValidLine)).toEqual({
      completeBytes: 0,
      validBytes: 0
    })
    expect(measureSegmentTail(LINES[0].subarray(0, 9), isValidLine)).toEqual({
      completeBytes: 0,
      validBytes: 0
    })
  })

  it('counts complete valid lines in bytes and stops at the fragment', () => {
    const complete = LINES[0].length + LINES[1].length
    expect(Buffer.from(LINES[1]).toString('utf8').length).toBeLessThan(LINES[1].length)
    expect(measureSegmentTail(ALL.subarray(0, complete + 7), isValidLine)).toEqual({
      completeBytes: complete,
      validBytes: complete
    })
    expect(measureSegmentTail(ALL, isValidLine)).toEqual({
      completeBytes: ALL.length,
      validBytes: ALL.length
    })
  })

  it('hands the validator each complete line without its newline and never the fragment', () => {
    const seen: string[] = []
    measureSegmentTail(
      Buffer.concat([LINES[0], Buffer.from('\n'), LINES[2], Buffer.from('{"ok":tr')]),
      (candidate) => {
        seen.push(candidate.toString('utf8'))
        return isValidLine(candidate)
      }
    )
    expect(seen).toEqual([
      LINES[0].toString('utf8').slice(0, -1),
      '',
      LINES[2].toString('utf8').slice(0, -1)
    ])
  })

  it('reports where an invalid complete line starts and where the complete lines end', () => {
    const damaged = Buffer.concat([LINES[0], Buffer.from('not json\n'), LINES[2], LINES[1]])
    expect(measureSegmentTail(damaged, isValidLine)).toEqual({
      completeBytes: damaged.length,
      validBytes: LINES[0].length
    })
    expect(measureSegmentTail(Buffer.concat([damaged, Buffer.from('{"ok"')]), isValidLine)).toEqual(
      { completeBytes: damaged.length, validBytes: LINES[0].length }
    )
  })
})

describe('repairSegmentTornTail', () => {
  let directory: string
  let segment: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    segment = path.join(directory, 'chat.mutations.jsonl')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    removeTemporaryDirectory(directory)
  })

  it('reports a missing segment without creating it', () => {
    expect(repairSegmentTornTail(segment, { isValidLine })).toEqual({ status: 'missing' })
    expect(fs.readdirSync(directory)).toEqual([])
  })

  it('leaves a segment that ends on a line boundary exactly as it was', () => {
    fs.writeFileSync(segment, ALL)
    const before = fs.statSync(segment, { bigint: true })
    const hooks = { beforeSourceMutation: vi.fn(), retireDescriptor: vi.fn() }

    expect(repairSegmentTornTail(segment, { isValidLine, ...hooks })).toEqual({
      status: 'clean',
      size: ALL.length
    })

    const after = fs.statSync(segment, { bigint: true })
    expect(fs.readFileSync(segment)).toEqual(ALL)
    expect({ ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({
      ino: before.ino,
      mtimeNs: before.mtimeNs
    })
    expect(hooks.beforeSourceMutation).not.toHaveBeenCalled()
    expect(hooks.retireDescriptor).not.toHaveBeenCalled()
  })

  it('cuts a segment torn at any byte back to its last complete line, in place', () => {
    const boundaries = [0, LINES[0].length, LINES[0].length + LINES[1].length, ALL.length]
    let repaired = 0
    for (let cut = 0; cut <= ALL.length; cut += 1) {
      fs.writeFileSync(segment, ALL.subarray(0, cut))
      const inode = fs.statSync(segment).ino
      const kept = Math.max(...boundaries.filter((boundary) => boundary <= cut))

      const result = repairSegmentTornTail(segment, { isValidLine })

      expect(result).toEqual(
        kept === cut
          ? { status: 'clean', size: cut }
          : { status: 'repaired', size: kept, removedBytes: cut - kept }
      )
      expect(fs.readFileSync(segment)).toEqual(ALL.subarray(0, kept))
      expect(fs.statSync(segment).ino).toBe(inode)
      if (kept !== cut) repaired += 1
    }
    // Every cut that is not on a line boundary was a repair.
    expect(repaired).toBe(ALL.length + 1 - boundaries.length)
  })

  it('asks the guard, then retires the descriptor, then truncates and syncs', () => {
    const torn = Buffer.concat([LINES[0], LINES[1].subarray(0, 11)])
    fs.writeFileSync(segment, torn)
    const order: string[] = []
    const realTruncate = fs.ftruncateSync.bind(fs)
    const realFsync = fs.fsyncSync.bind(fs)
    vi.spyOn(fs, 'ftruncateSync').mockImplementation((fd, length) => {
      order.push(`truncate to ${String(length)}`)
      realTruncate(fd, length)
    })
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      order.push(`sync at ${fs.fstatSync(fd).size}`)
      realFsync(fd)
    })
    syncBuiltinESMExports()

    repairSegmentTornTail(segment, {
      isValidLine,
      beforeSourceMutation: () => order.push(`guard at ${fs.statSync(segment).size}`),
      retireDescriptor: () => order.push(`retire at ${fs.statSync(segment).size}`)
    })

    expect(order).toEqual([
      `guard at ${torn.length}`,
      `retire at ${torn.length}`,
      `truncate to ${LINES[0].length}`,
      `sync at ${LINES[0].length}`
    ])
  })

  it.each(['beforeSourceMutation', 'retireDescriptor'] as const)(
    'removes nothing when %s refuses',
    (hook) => {
      const torn = Buffer.concat([LINES[0], LINES[1].subarray(0, 11)])
      fs.writeFileSync(segment, torn)

      expect(() =>
        repairSegmentTornTail(segment, {
          isValidLine,
          [hook]: () => {
            throw new Error('held for recovery')
          }
        })
      ).toThrow('held for recovery')

      expect(fs.readFileSync(segment)).toEqual(torn)
    }
  )

  it.each([
    ['with no fragment after it', ''],
    ['with a fragment after it', '{"ok":tr']
  ])('never removes a complete line once one is invalid, %s', (_case, fragment) => {
    // The valid line after the damage may be the only copy of what it holds.
    const damaged = Buffer.concat([
      LINES[0],
      Buffer.from('{"ok":tr{"ok":true}\n'),
      LINES[2],
      Buffer.from(fragment)
    ])
    fs.writeFileSync(segment, damaged)
    const hooks = { beforeSourceMutation: vi.fn(), retireDescriptor: vi.fn() }

    expect(repairSegmentTornTail(segment, { isValidLine, ...hooks })).toEqual({
      status: 'corrupt',
      size: damaged.length,
      validBytes: LINES[0].length
    })

    expect(fs.readFileSync(segment)).toEqual(damaged)
    expect(hooks.beforeSourceMutation).not.toHaveBeenCalled()
    expect(hooks.retireDescriptor).not.toHaveBeenCalled()
  })

  it('refuses a segment over the byte bound without touching it', () => {
    const torn = Buffer.concat([LINES[0], LINES[1].subarray(0, 11)])
    fs.writeFileSync(segment, torn)

    expect(() =>
      repairSegmentTornTail(segment, { isValidLine, maxBytes: torn.length - 1 })
    ).toThrow(`exceeds ${torn.length - 1} bytes`)
    expect(fs.readFileSync(segment)).toEqual(torn)
    expect(repairSegmentTornTail(segment, { isValidLine, maxBytes: torn.length })).toMatchObject({
      status: 'repaired'
    })
  })

  it.skipIf(process.platform === 'win32')('does not follow a symbolic link', () => {
    const target = path.join(directory, 'elsewhere.jsonl')
    const torn = Buffer.concat([LINES[0], LINES[1].subarray(0, 11)])
    fs.writeFileSync(target, torn)
    fs.symlinkSync(target, segment)

    expect(() => repairSegmentTornTail(segment, { isValidLine })).toThrow()
    expect(fs.readFileSync(target)).toEqual(torn)
  })
})
