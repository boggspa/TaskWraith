import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { GLOBAL_INSTRUCTIONS_SOURCE_LABEL, resolveInstructionContext } from './InstructionResolver'
import {
  INSTRUCTION_LAYER_MAX_BYTES,
  WORKSPACE_DOCTRINE_FILE,
  WORKSPACE_INSTRUCTIONS_FILE
} from '../../shared/instructions/InstructionTypes'

let workspacePath: string

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-instr-ws-'))
})

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true })
})

function writeWorkspaceFile(content: string | Buffer): string {
  const filePath = path.join(workspacePath, WORKSPACE_INSTRUCTIONS_FILE)
  fs.writeFileSync(filePath, content)
  return filePath
}

function writeDoctrineFile(content: string | Buffer): string {
  const filePath = path.join(workspacePath, WORKSPACE_DOCTRINE_FILE)
  fs.writeFileSync(filePath, content)
  return filePath
}

function layerByScope(
  result: ReturnType<typeof resolveInstructionContext>,
  scope: 'global' | 'workspace'
) {
  const layer = result.layers.find((entry) => entry.scope === scope)
  if (!layer) throw new Error(`No ${scope} layer in result`)
  return layer
}

describe('resolveInstructionContext — layer shape', () => {
  it('applies a non-empty global document with digest, hash, and byte count', () => {
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: 'Always answer in British English.\n',
      workspacePath: null
    })
    expect(result.enabled).toBe(true)
    expect(result.layers).toHaveLength(1)
    const layer = layerByScope(result, 'global')
    expect(layer.status).toBe('applied')
    expect(layer.source).toBe(GLOBAL_INSTRUCTIONS_SOURCE_LABEL)
    expect(layer.content).toBe('Always answer in British English.')
    expect(layer.sha256).toBe(
      createHash('sha256').update('Always answer in British English.', 'utf8').digest('hex')
    )
    expect(layer.bytes).toBe(Buffer.byteLength('Always answer in British English.\n'))
    expect(result.digest).not.toBe('none')
  })

  it('reports an empty global document as absent and digest none', () => {
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '   \n\n  ',
      workspacePath: null
    })
    expect(layerByScope(result, 'global').status).toBe('absent')
    expect(result.digest).toBe('none')
  })

  it('omits the workspace layer entirely for global (no-workspace) runs', () => {
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: 'x',
      workspacePath: null
    })
    expect(result.layers.map((layer) => layer.scope)).toEqual(['global'])
    expect(result.workspaceDoctrine).toBeUndefined()
    expect(result.workspaceDoctrineDigest).toBe('none')
  })

  it('lists both layers as disabled (digest none) when the setting is off', () => {
    writeWorkspaceFile('Workspace rules.')
    const result = resolveInstructionContext({
      enabled: false,
      globalContent: 'Global rules.',
      workspacePath
    })
    expect(result.enabled).toBe(false)
    expect(result.digest).toBe('none')
    expect(layerByScope(result, 'global').status).toBe('disabled')
    expect(layerByScope(result, 'workspace').status).toBe('disabled')
  })

  it('still resolves workspace doctrine when custom instructions are disabled', () => {
    writeWorkspaceFile('Custom workspace preference.')
    writeDoctrineFile('Repository doctrine remains active.')

    const result = resolveInstructionContext({
      enabled: false,
      globalContent: 'Global preference.',
      workspacePath
    })

    expect(result.enabled).toBe(false)
    expect(result.digest).toBe('none')
    expect(result.workspaceDoctrine).toMatchObject({
      source: WORKSPACE_DOCTRINE_FILE,
      status: 'applied',
      content: 'Repository doctrine remains active.'
    })
    expect(result.workspaceDoctrineDigest).toBe(result.workspaceDoctrine?.sha256)
  })
})

describe('resolveInstructionContext — workspace doctrine', () => {
  it('resolves root AGENTS.md with a separate digest', () => {
    writeWorkspaceFile('Prefer tabs in this repo.')
    writeDoctrineFile('# Agent rules\r\n\r\nCheck ownership before editing.\r\n')

    const result = resolveInstructionContext({
      enabled: true,
      globalContent: 'Answer in British English.',
      workspacePath
    })

    expect(result.workspaceDoctrine).toMatchObject({
      source: WORKSPACE_DOCTRINE_FILE,
      status: 'applied',
      content: '# Agent rules\n\nCheck ownership before editing.'
    })
    expect(result.workspaceDoctrineDigest).toBe(result.workspaceDoctrine?.sha256)
    expect(result.workspaceDoctrineDigest).not.toBe('none')
  })

  it('reports a missing doctrine file as absent without changing custom-instruction digest', () => {
    writeWorkspaceFile('Prefer tabs in this repo.')
    const before = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    expect(before.workspaceDoctrine).toMatchObject({
      source: WORKSPACE_DOCTRINE_FILE,
      status: 'absent'
    })
    expect(before.workspaceDoctrineDigest).toBe('none')

    writeDoctrineFile('Doctrine v1.')
    const after = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    expect(after.workspaceDoctrine?.status).toBe('applied')
    expect(after.workspaceDoctrineDigest).not.toBe('none')
    expect(after.digest).toBe(before.digest)
  })

  it('changes only the doctrine digest when AGENTS.md changes', () => {
    writeWorkspaceFile('Stable custom preference.')
    writeDoctrineFile('Doctrine v1.')
    const first = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })

    writeDoctrineFile('Doctrine v2.')
    const second = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })

    expect(second.digest).toBe(first.digest)
    expect(second.workspaceDoctrineDigest).not.toBe(first.workspaceDoctrineDigest)
  })
})

describe('resolveInstructionContext — workspace file', () => {
  it('applies TASKWRAITH.md at the workspace root', () => {
    writeWorkspaceFile('Prefer tabs in this repo.\r\nSecond line.')
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    const layer = layerByScope(result, 'workspace')
    expect(layer.status).toBe('applied')
    expect(layer.source).toBe(WORKSPACE_INSTRUCTIONS_FILE)
    // CRLF is normalized before hashing/injection.
    expect(layer.content).toBe('Prefer tabs in this repo.\nSecond line.')
  })

  it('reports a missing TASKWRAITH.md as absent', () => {
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    expect(layerByScope(result, 'workspace').status).toBe('absent')
    expect(result.digest).toBe('none')
  })

  it('refuses a symlinked TASKWRAITH.md', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-instr-outside-'))
    try {
      const target = path.join(outside, 'real.md')
      fs.writeFileSync(target, 'Instructions living outside the workspace.')
      fs.symlinkSync(target, path.join(workspacePath, WORKSPACE_INSTRUCTIONS_FILE))
      const result = resolveInstructionContext({
        enabled: true,
        globalContent: '',
        workspacePath
      })
      const layer = layerByScope(result, 'workspace')
      expect(layer.status).toBe('skipped')
      expect(layer.skipReason).toBe('symlink_refused')
      expect(layer.content).toBeUndefined()
      expect(result.digest).toBe('none')
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reports an unreadable workspace root as skipped, never throws', () => {
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath: path.join(workspacePath, 'does-not-exist')
    })
    const layer = layerByScope(result, 'workspace')
    expect(layer.status).toBe('skipped')
    expect(layer.skipReason).toBe('unreadable')
  })
})

describe('resolveInstructionContext — content safety gates', () => {
  it('skips an over-cap layer whole rather than truncating', () => {
    writeWorkspaceFile('a'.repeat(INSTRUCTION_LAYER_MAX_BYTES + 1))
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    const layer = layerByScope(result, 'workspace')
    expect(layer.status).toBe('skipped')
    expect(layer.skipReason).toBe('too_large')
    expect(layer.content).toBeUndefined()
  })

  it('skips bytes that do not strictly decode as UTF-8', () => {
    writeWorkspaceFile(Buffer.from([0x48, 0x69, 0xc3, 0x28]))
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    const layer = layerByScope(result, 'workspace')
    expect(layer.status).toBe('skipped')
    expect(layer.skipReason).toBe('invalid_utf8')
  })

  it('refuses bidi override characters (Trojan Source) instead of stripping them', () => {
    writeWorkspaceFile('Safe start \u202Ehidden reversal\u202C end.')
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    const layer = layerByScope(result, 'workspace')
    expect(layer.status).toBe('skipped')
    expect(layer.skipReason).toBe('unsafe_characters')
  })

  it('refuses C0 controls in the global document too', () => {
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: 'Line one\u0007bell',
      workspacePath: null
    })
    const layer = layerByScope(result, 'global')
    expect(layer.status).toBe('skipped')
    expect(layer.skipReason).toBe('unsafe_characters')
  })

  it('allows tabs, newlines, plain markdown, and non-Latin text', () => {
    writeWorkspaceFile('# Rules\n\n\tIndent with tabs.\n\nПиши по-русски. 日本語も大丈夫。')
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    expect(layerByScope(result, 'workspace').status).toBe('applied')
  })

  it('strips a UTF-8 BOM before applying', () => {
    writeWorkspaceFile('\uFEFF' + 'Real content.')
    const result = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    const layer = layerByScope(result, 'workspace')
    expect(layer.status).toBe('applied')
    expect(layer.content).toBe('Real content.')
  })
})

describe('resolveInstructionContext — digest stability', () => {
  it('is stable for identical content and changes when any applied layer changes', () => {
    writeWorkspaceFile('Workspace rules v1.')
    const input = { enabled: true, globalContent: 'Global rules.', workspacePath }
    const first = resolveInstructionContext(input)
    const second = resolveInstructionContext(input)
    expect(first.digest).toBe(second.digest)

    writeWorkspaceFile('Workspace rules v2.')
    const third = resolveInstructionContext(input)
    expect(third.digest).not.toBe(first.digest)
  })

  it('distinguishes which scope carries the content', () => {
    const globalOnly = resolveInstructionContext({
      enabled: true,
      globalContent: 'Same words.',
      workspacePath: null
    })
    writeWorkspaceFile('Same words.')
    const workspaceOnly = resolveInstructionContext({
      enabled: true,
      globalContent: '',
      workspacePath
    })
    expect(globalOnly.digest).not.toBe(workspaceOnly.digest)
  })
})
