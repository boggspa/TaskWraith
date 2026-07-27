import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PI_ENSEMBLE_COORDINATION_READY_MARKER,
  PI_ENSEMBLE_COORDINATION_TOOL_NAMES,
  isPiEnsembleCoordinationToolName,
  piEnsembleCoordinationReadyPromptAppendix,
  piEnsembleCoordinationUnavailablePromptAppendix,
  preparePiEnsembleCoordinationExtension
} from './PiEnsembleCoordination'

const temporaryHomes: string[] = []

function createCanonicalHome(): string {
  const created = mkdtempSync(join(tmpdir(), 'taskwraith-pi-coordination-'))
  temporaryHomes.push(created)
  return realpathSync(created)
}

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('Pi managed Ensemble coordination extension', () => {
  it('recognizes only the fixed ensemble coordination broker surface', () => {
    for (const toolName of PI_ENSEMBLE_COORDINATION_TOOL_NAMES) {
      expect(isPiEnsembleCoordinationToolName(toolName)).toBe(true)
    }
    expect(isPiEnsembleCoordinationToolName('run_shell_command')).toBe(false)
    expect(isPiEnsembleCoordinationToolName('capability_invoke')).toBe(false)
    expect(isPiEnsembleCoordinationToolName('write_file')).toBe(false)
  })

  it('writes a fixed owner-only extension with exactly the narrow coordination tool set', () => {
    const home = createCanonicalHome()

    const prepared = preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })

    expect(prepared.path).toBe(join(home, 'taskwraith-ensemble-coordination.mjs'))
    expect(prepared.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.toolNames).toEqual(PI_ENSEMBLE_COORDINATION_TOOL_NAMES)
    const source = readFileSync(prepared.path, 'utf8')
    expect(source).toContain(PI_ENSEMBLE_COORDINATION_READY_MARKER)
    expect(source).toContain("parentProvider: 'pi'")
    expect(source).toContain('const TOOL_NAMES')
    expect(source).toContain('function parametersFor(name)')
    expect(source).toContain('promptSnippet: descriptionFor(name)')
    expect(source).toContain("case 'ensemble_send'")
    expect(source).toContain("case 'blackboard_post'")
    expect(source).toContain('throw new Error(resultText(result))')
    expect(source).not.toContain('run_shell_command')
    expect(source).not.toContain('write_file')
  })

  it('does not overwrite an unexpected pre-existing extension file', () => {
    const home = createCanonicalHome()
    preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })

    expect(() => preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })).toThrow(/EEXIST/)
  })

  it('makes the ready and fallback prompt receipts mutually exclusive and actionable', () => {
    const home = createCanonicalHome()
    const prepared = preparePiEnsembleCoordinationExtension({ isolatedHomeDir: home })

    const ready = piEnsembleCoordinationReadyPromptAppendix(prepared)
    const unavailable = piEnsembleCoordinationUnavailablePromptAppendix('extension readiness timed out')

    expect(ready).toContain('verified for this run')
    for (const tool of PI_ENSEMBLE_COORDINATION_TOOL_NAMES) expect(ready).toContain(`\`${tool}\``)
    expect(unavailable).toContain('unavailable for this run')
    expect(unavailable).toContain('@Role')
    expect(unavailable).not.toContain('verified for this run')
  })
})
