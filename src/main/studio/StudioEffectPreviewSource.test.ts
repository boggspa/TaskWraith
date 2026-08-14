import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STUDIO_EFFECT_PREVIEW_MAX_BYTES,
  STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION,
  StudioEffectPreviewError,
  loadStudioEffectPreview
} from './StudioEffectPreviewSource'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true }))
  )
})

function temporaryRoot(label: string): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(nodePath.join(os.tmpdir(), label)))
  roots.push(root)
  return root
}

/** A structurally valid cube: exactly size^3 triples, R varying fastest. */
function validCube(size = 2): string {
  const lines = [
    '# generated fixture',
    'TITLE "fixture"',
    'DOMAIN_MIN 0.0 0.0 0.0',
    `LUT_3D_SIZE ${size}`
  ]
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(`${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

function writeCube(root: string, name: string, text: string): string {
  const path = nodePath.join(root, name)
  fs.writeFileSync(path, text, 'utf8')
  return path
}

function expectRejection(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(StudioEffectPreviewError)
    expect((error as StudioEffectPreviewError).code).toBe(code)
    return
  }
  throw new Error(`expected rejection ${code}, but the load succeeded`)
}

describe('Studio effect preview source', () => {
  it('accepts an authorized cube and returns a content-addressed inline payload', () => {
    const root = temporaryRoot('studio-lut-ok-')
    const text = validCube(2)
    const path = writeCube(root, 'grade.cube', text)

    const preview = loadStudioEffectPreview({ path, allowedMediaRoots: [root] })

    expect(preview.schemaVersion).toBe(STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION)
    expect(preview.cubeText).toBe(text)
    expect(preview.cubeByteLength).toBe(Buffer.byteLength(text, 'utf8'))
    expect(preview.effectId).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(preview.effectId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('never returns the filesystem path, so it cannot reach the document or the wire', () => {
    // LOAD-BEARING. The contract requires the external path to exist only at
    // this boundary. Enforced structurally: if a path field is ever added to the
    // payload this fails, rather than relying on callers to strip it.
    const root = temporaryRoot('studio-lut-nopath-')
    const path = writeCube(root, 'grade.cube', validCube(2))

    const preview = loadStudioEffectPreview({ path, allowedMediaRoots: [root] })

    expect(Object.keys(preview).sort()).toEqual([
      'cubeByteLength',
      'cubeText',
      'effectId',
      'schemaVersion'
    ])
    expect(JSON.stringify(preview)).not.toContain(root)
  })

  it('refuses a cube outside every allowed root', () => {
    const root = temporaryRoot('studio-lut-root-')
    const outside = temporaryRoot('studio-lut-outside-')
    const path = writeCube(outside, 'grade.cube', validCube(2))

    expectRejection(
      () => loadStudioEffectPreview({ path, allowedMediaRoots: [root] }),
      'path_outside_allowed_roots'
    )
  })

  it('refuses a symlink even when the link itself sits inside an allowed root', () => {
    // The escape shape: the link is authorized, the target is not. Refused as a
    // symlink rather than resolved, so the target is never opened at all.
    const root = temporaryRoot('studio-lut-link-')
    const outside = temporaryRoot('studio-lut-linktarget-')
    const target = writeCube(outside, 'real.cube', validCube(2))
    const link = nodePath.join(root, 'escape.cube')
    fs.symlinkSync(target, link)

    expectRejection(
      () => loadStudioEffectPreview({ path: link, allowedMediaRoots: [root] }),
      'symlink_refused'
    )
  })

  it('fails closed when no allowed roots are configured', () => {
    const root = temporaryRoot('studio-lut-noroots-')
    const path = writeCube(root, 'grade.cube', validCube(2))

    expectRejection(
      () => loadStudioEffectPreview({ path, allowedMediaRoots: [] }),
      'no_allowed_roots'
    )
  })

  it('refuses a relative path, a non-cube extension, a directory and an absent file', () => {
    const root = temporaryRoot('studio-lut-shape-')
    writeCube(root, 'grade.cube', validCube(2))

    expectRejection(
      () => loadStudioEffectPreview({ path: 'grade.cube', allowedMediaRoots: [root] }),
      'path_not_absolute'
    )
    const notCube = writeCube(root, 'grade.txt', validCube(2))
    expectRejection(
      () => loadStudioEffectPreview({ path: notCube, allowedMediaRoots: [root] }),
      'not_a_cube_file'
    )
    const directory = nodePath.join(root, 'folder.cube')
    fs.mkdirSync(directory)
    expectRejection(
      () => loadStudioEffectPreview({ path: directory, allowedMediaRoots: [root] }),
      'not_a_regular_file'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: nodePath.join(root, 'absent.cube'),
          allowedMediaRoots: [root]
        }),
      'read_failed'
    )
  })

  it('bounds the file at both ends', () => {
    const root = temporaryRoot('studio-lut-bounds-')
    const empty = nodePath.join(root, 'empty.cube')
    fs.writeFileSync(empty, '')
    expectRejection(
      () => loadStudioEffectPreview({ path: empty, allowedMediaRoots: [root] }),
      'empty_file'
    )

    const oversize = nodePath.join(root, 'huge.cube')
    fs.writeFileSync(oversize, Buffer.alloc(STUDIO_EFFECT_PREVIEW_MAX_BYTES + 1, 0x20))
    expectRejection(
      () => loadStudioEffectPreview({ path: oversize, allowedMediaRoots: [root] }),
      'too_large'
    )
  })

  it('refuses non-UTF-8 bytes, control characters and a byte-order mark', () => {
    const root = temporaryRoot('studio-lut-text-')

    const invalidUtf8 = nodePath.join(root, 'binary.cube')
    fs.writeFileSync(invalidUtf8, Buffer.from([0x4c, 0x55, 0x54, 0xff, 0xfe, 0x0a]))
    expectRejection(
      () => loadStudioEffectPreview({ path: invalidUtf8, allowedMediaRoots: [root] }),
      'not_utf8'
    )

    const nul = String.fromCharCode(0)
    const withControl = writeCube(root, 'control.cube', validCube(2) + nul)
    expectRejection(
      () => loadStudioEffectPreview({ path: withControl, allowedMediaRoots: [root] }),
      'control_characters'
    )
  })

  it('strips a leading byte-order mark and hashes what is actually transmitted', () => {
    // A real export can carry a BOM. It is decoded away here, so the Companion
    // never sees one, and the identity/length describe the PAYLOAD rather than
    // the file on disk — which is the only pair the Companion can re-verify.
    const root = temporaryRoot('studio-lut-bom-')
    const bom = String.fromCharCode(0xfeff)
    const text = validCube(2)
    const path = writeCube(root, 'bom.cube', bom + text)

    const preview = loadStudioEffectPreview({ path, allowedMediaRoots: [root] })

    expect(preview.cubeText).toBe(text)
    expect(preview.cubeText.charCodeAt(0)).not.toBe(0xfeff)
    expect(preview.effectId).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(preview.cubeByteLength).toBe(Buffer.byteLength(text, 'utf8'))
    expect(preview.cubeByteLength).toBeLessThan(fs.statSync(path).size)
  })

  it('enforces exactly the Companion parser structural rules', () => {
    const root = temporaryRoot('studio-lut-struct-')

    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'nosize.cube', '0.0 0.0 0.0\n'),
          allowedMediaRoots: [root]
        }),
      'missing_lut_3d_size'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'onedee.cube', 'LUT_1D_SIZE 16\n'),
          allowedMediaRoots: [root]
        }),
      'one_dimensional_lut'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'small.cube', 'LUT_3D_SIZE 1\n0.0 0.0 0.0\n'),
          allowedMediaRoots: [root]
        }),
      'unsupported_lut_size'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'big.cube', 'LUT_3D_SIZE 65\n0.0 0.0 0.0\n'),
          allowedMediaRoots: [root]
        }),
      'unsupported_lut_size'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'short.cube', validCube(2).replace('0 0 0\n', '0 0\n')),
          allowedMediaRoots: [root]
        }),
      'malformed_entry'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'infinite.cube', validCube(2).replace('0 0 0\n', 'Infinity 0 0\n')),
          allowedMediaRoots: [root]
        }),
      'non_finite_value'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'truncated.cube', 'LUT_3D_SIZE 2\n0.0 0.0 0.0\n'),
          allowedMediaRoots: [root]
        }),
      'entry_count_mismatch'
    )
    expectRejection(
      () =>
        loadStudioEffectPreview({
          path: writeCube(root, 'twosize.cube', 'LUT_3D_SIZE 2\nLUT_3D_SIZE 2\n'),
          allowedMediaRoots: [root]
        }),
      'duplicate_lut_3d_size'
    )
  })

  it('tolerates the metadata a real export carries, exactly as the Companion does', () => {
    // Rejecting TITLE/DOMAIN_/comments would refuse most files in the wild and
    // would be STRICTER than the Companion, which is its own kind of defect.
    const root = temporaryRoot('studio-lut-tolerant-')
    const text = [
      '# exported by a real grading tool',
      '',
      'TITLE "Look A"',
      'DOMAIN_MIN 0.0 0.0 0.0',
      'DOMAIN_MAX 1.0 1.0 1.0',
      'LUT_3D_SIZE 2',
      ...Array.from({ length: 8 }, () => '0.5\t0.5\t0.5')
    ].join('\r\n')

    const preview = loadStudioEffectPreview({
      path: writeCube(root, 'real.cube', text),
      allowedMediaRoots: [root]
    })
    expect(preview.cubeText).toBe(text)
  })
})
