import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_DOCTRINE_FILE,
  WORKSPACE_DOCTRINE_MAX_BYTES
} from '../../shared/instructions/InstructionTypes'
import { resolveWorkspaceDoctrine } from './WorkspaceDoctrineReader'

let workspacePath: string

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-doctrine-'))
})

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true })
})

function doctrinePath(): string {
  return path.join(workspacePath, WORKSPACE_DOCTRINE_FILE)
}

function writeDoctrine(content: string | Buffer): void {
  fs.writeFileSync(doctrinePath(), content)
}

describe('resolveWorkspaceDoctrine — bounded descriptor read', () => {
  it('accepts the largest file strictly below 32 KiB', () => {
    writeDoctrine('a'.repeat(WORKSPACE_DOCTRINE_MAX_BYTES))

    const result = resolveWorkspaceDoctrine(workspacePath)

    expect(WORKSPACE_DOCTRINE_MAX_BYTES).toBe(32 * 1024 - 1)
    expect(result.status).toBe('applied')
    expect(result.bytes).toBe(WORKSPACE_DOCTRINE_MAX_BYTES)
    expect(result.content).toHaveLength(WORKSPACE_DOCTRINE_MAX_BYTES)
  })

  it('refuses a 32 KiB file whole instead of truncating it', () => {
    writeDoctrine('a'.repeat(32 * 1024))

    const result = resolveWorkspaceDoctrine(workspacePath)

    expect(result.status).toBe('skipped')
    expect(result.skipReason).toBe('too_large')
    expect(result.bytes).toBe(32 * 1024)
    expect(result.content).toBeUndefined()
  })

  it('reports a missing file as absent and an invalid root as unreadable', () => {
    expect(resolveWorkspaceDoctrine(workspacePath)).toMatchObject({
      source: WORKSPACE_DOCTRINE_FILE,
      status: 'absent'
    })
    expect(resolveWorkspaceDoctrine(path.join(workspacePath, 'missing'))).toMatchObject({
      source: WORKSPACE_DOCTRINE_FILE,
      status: 'skipped',
      skipReason: 'unreadable'
    })
  })

  it('refuses symlinks and non-regular files', () => {
    const outside = path.join(workspacePath, 'outside.md')
    fs.writeFileSync(outside, 'outside')
    fs.symlinkSync(outside, doctrinePath())
    expect(resolveWorkspaceDoctrine(workspacePath)).toMatchObject({
      status: 'skipped',
      skipReason: 'symlink_refused'
    })

    fs.unlinkSync(doctrinePath())
    fs.mkdirSync(doctrinePath())
    expect(resolveWorkspaceDoctrine(workspacePath)).toMatchObject({
      status: 'skipped',
      skipReason: 'unreadable'
    })
  })

  it('rejects a path replacement between inspection and descriptor open', () => {
    writeDoctrine('original doctrine')

    const result = resolveWorkspaceDoctrine(workspacePath, {
      afterPathInspection: (filePath) => {
        fs.renameSync(filePath, `${filePath}.original`)
        fs.writeFileSync(filePath, 'replacement doctrine')
      }
    })

    expect(result.status).toBe('skipped')
    expect(result.skipReason).toBe('unreadable')
    expect(result.content).toBeUndefined()
  })

  it('rejects in-place mutation while the descriptor is being read', () => {
    writeDoctrine('original doctrine')

    const result = resolveWorkspaceDoctrine(workspacePath, {
      afterDescriptorOpen: (filePath) => {
        fs.writeFileSync(filePath, 'changed doctrine with a different size')
      }
    })

    expect(result.status).toBe('skipped')
    expect(result.skipReason).toBe('unreadable')
    expect(result.content).toBeUndefined()
  })
})

describe('resolveWorkspaceDoctrine — decoding and integrity', () => {
  it('strictly decodes UTF-8, normalizes CRLF, and hashes normalized content', () => {
    writeDoctrine('# Rules\r\n\r\n\tПиши ясно.\r\n')

    const result = resolveWorkspaceDoctrine(workspacePath)
    const expected = '# Rules\n\n\tПиши ясно.'

    expect(result.status).toBe('applied')
    expect(result.content).toBe(expected)
    expect(result.sha256).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'))
  })

  it('reports an empty file as absent with its byte count', () => {
    writeDoctrine('  \n\t\n')

    expect(resolveWorkspaceDoctrine(workspacePath)).toMatchObject({
      status: 'absent',
      bytes: 5
    })
  })

  it('refuses invalid UTF-8', () => {
    writeDoctrine(Buffer.from([0x48, 0x69, 0xc3, 0x28]))

    expect(resolveWorkspaceDoctrine(workspacePath)).toMatchObject({
      status: 'skipped',
      skipReason: 'invalid_utf8'
    })
  })

  it('refuses every invisible and direction-control range used by the doctrine guard', () => {
    const forbiddenCodePoints = [
      0x00ad, 0x180e, 0x200b, 0x200d, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066,
      0x2069, 0xfe00, 0xfe0f, 0xfeff, 0xe0000, 0xe007f
    ]

    for (const codePoint of forbiddenCodePoints) {
      writeDoctrine(`visible${String.fromCodePoint(codePoint)}text`)
      const result = resolveWorkspaceDoctrine(workspacePath)
      expect(result.status, `U+${codePoint.toString(16)}`).toBe('skipped')
      expect(result.skipReason, `U+${codePoint.toString(16)}`).toBe('unsafe_characters')
    }
  })

  it('refuses a UTF-8 BOM and disallowed C0 controls before normalization', () => {
    writeDoctrine(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Rules')]))
    expect(resolveWorkspaceDoctrine(workspacePath)).toMatchObject({
      status: 'skipped',
      skipReason: 'unsafe_characters'
    })

    writeDoctrine('visible\u0007bell')
    expect(resolveWorkspaceDoctrine(workspacePath)).toMatchObject({
      status: 'skipped',
      skipReason: 'unsafe_characters'
    })
  })
})
