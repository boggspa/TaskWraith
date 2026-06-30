import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluatePlanArtifactWrite } from './PlanArtifactWritePolicy'
import type { EffectiveRunPermissions } from './store/types'

const readOnlyPermissions: EffectiveRunPermissions = {
  presetId: 'read_only',
  approvalMode: 'plan',
  readOnly: true,
  agenticServices: {
    shellCommands: 'deny',
    fileChanges: 'deny',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'deny',
    crossThreadRead: 'deny',
    mediaEditing: 'deny',
    mediaRecording: 'deny',
    canvasEval: 'deny'
  },
  networkAccess: 'deny',
  externalPathGrants: [],
  workspaceGrantServiceIds: []
}

describe('evaluatePlanArtifactWrite', () => {
  let workspacePath = ''
  let outsidePath = ''

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'tw-plan-artifact-workspace-'))
    outsidePath = mkdtempSync(join(tmpdir(), 'tw-plan-artifact-outside-'))
  })

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true })
    rmSync(outsidePath, { recursive: true, force: true })
  })

  const base = () => ({
    workflowMode: 'plan',
    effectivePermissions: readOnlyPermissions,
    globalFileChangesPolicy: 'ask',
    service: 'fileChanges' as const,
    toolName: 'write_file',
    workspacePath
  })

  it.each([
    '.taskwraith/plans/next.md',
    '.cursor/plans/refactor.markdown',
    'docs/plans/feature.md',
    'plans/sketch.md',
    'PLAN.md',
    'notes/renderer.plan.md'
  ])('allows plan workflow markdown artifacts at %s', (rawPath) => {
    const decision = evaluatePlanArtifactWrite({ ...base(), rawPath })
    expect(decision.allowed).toBe(true)
    expect(decision.relativePath).toBe(rawPath)
  })

  it('allows replace for the same narrow artifact paths', () => {
    const decision = evaluatePlanArtifactWrite({
      ...base(),
      toolName: 'replace',
      rawPath: 'docs/plans/feature.md'
    })
    expect(decision.allowed).toBe(true)
  })

  it('rejects non-plan workflow and non-read-only posture', () => {
    expect(evaluatePlanArtifactWrite({ ...base(), workflowMode: 'normal', rawPath: 'PLAN.md' })).toMatchObject({
      allowed: false,
      reason: 'not_plan_workflow'
    })
    expect(
      evaluatePlanArtifactWrite({
        ...base(),
        effectivePermissions: { ...readOnlyPermissions, readOnly: false },
        rawPath: 'PLAN.md'
      })
    ).toMatchObject({ allowed: false, reason: 'not_read_only_posture' })
  })

  it('does not override explicit global file-change denies', () => {
    expect(
      evaluatePlanArtifactWrite({
        ...base(),
        globalFileChangesPolicy: 'deny',
        rawPath: 'PLAN.md'
      })
    ).toMatchObject({ allowed: false, reason: 'global_file_changes_denied' })
  })

  it('rejects unsupported tools, non-markdown files, and generic markdown paths', () => {
    expect(
      evaluatePlanArtifactWrite({ ...base(), toolName: 'apply_patch', rawPath: 'PLAN.md' })
    ).toMatchObject({ allowed: false, reason: 'unsupported_tool' })
    expect(evaluatePlanArtifactWrite({ ...base(), rawPath: 'docs/plans/app.ts' })).toMatchObject({
      allowed: false,
      reason: 'not_markdown'
    })
    expect(evaluatePlanArtifactWrite({ ...base(), rawPath: 'README.md' })).toMatchObject({
      allowed: false,
      reason: 'not_plan_artifact'
    })
  })

  it('rejects targets outside the workspace', () => {
    expect(evaluatePlanArtifactWrite({ ...base(), rawPath: '../PLAN.md' })).toMatchObject({
      allowed: false,
      reason: 'outside_workspace'
    })
    expect(evaluatePlanArtifactWrite({ ...base(), rawPath: join(outsidePath, 'PLAN.md') })).toMatchObject({
      allowed: false,
      reason: 'outside_workspace'
    })
  })

  it('rejects plan paths whose existing parent chain resolves outside the workspace', () => {
    symlinkSync(outsidePath, join(workspacePath, 'docs'))
    expect(evaluatePlanArtifactWrite({ ...base(), rawPath: 'docs/plans/escape.md' })).toMatchObject({
      allowed: false,
      reason: 'outside_workspace_realpath'
    })
  })

  it('rejects an existing plan markdown symlink to an outside target', () => {
    const outsideTarget = join(outsidePath, 'outside.md')
    writeFileSync(outsideTarget, 'outside')
    mkdirSync(join(workspacePath, 'docs', 'plans'), { recursive: true })
    symlinkSync(outsideTarget, join(workspacePath, 'docs', 'plans', 'escape.md'))

    expect(evaluatePlanArtifactWrite({ ...base(), rawPath: 'docs/plans/escape.md' })).toMatchObject({
      allowed: false,
      reason: 'outside_workspace_realpath'
    })
  })
})
