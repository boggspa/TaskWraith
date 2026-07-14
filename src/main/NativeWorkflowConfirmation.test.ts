import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog, type BrowserWindow } from 'electron'
import type { WorkflowDefinition } from './store/types'
import {
  buildElevatedWorkflowRunNowConfirmationOptions,
  buildWorkflowElevationConfirmationOptions,
  confirmNativeWorkflowAuthority,
  describeWorkflowAuthorityForNativeConfirmation
} from './NativeWorkflowConfirmation'

vi.mock('electron', () => ({
  dialog: { showMessageBox: vi.fn() }
}))

const showMessageBox = vi.mocked(dialog.showMessageBox)
const options = {
  title: 'Confirm workflow authority',
  message: 'Allow this workflow?',
  detail: '/workspace',
  confirmLabel: 'Allow'
}

beforeEach(() => {
  showMessageBox.mockReset()
})

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'workflow-1',
    name: 'Review',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace',
    enabled: true,
    trigger: { kind: 'interval', intervalMs: 120_000, startAt: '2026-07-14T12:00:00.000Z' },
    template: {
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Review the workspace carefully.',
      selectedModelType: 'gpt-5.6-terra',
      customModel: '',
      approvalMode: 'auto_edit',
      sessionTrust: false,
      imageAttachments: [],
      externalPathGrants: [
        {
          id: 'grant-1',
          provider: 'codex',
          path: '/external',
          kind: 'directory',
          access: 'write',
          duration: 'workspace',
          createdAt: '2026-07-14T12:00:00.000Z'
        }
      ]
    },
    missedRunPolicy: 'coalesce',
    concurrencyPolicy: 'skip',
    limits: { maxConsecutiveFailures: 3 },
    failureStreak: 0,
    history: [],
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-14T12:00:00.000Z',
    ...overrides
  }
}

describe('confirmNativeWorkflowAuthority', () => {
  it('fails closed without a live owning window', async () => {
    await expect(confirmNativeWorkflowAuthority(null, options)).resolves.toBe(false)
    await expect(
      confirmNativeWorkflowAuthority(
        { isDestroyed: () => true } as BrowserWindow,
        options
      )
    ).resolves.toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('uses a parented warning with Cancel as both default and escape action', async () => {
    const owner = { isDestroyed: () => false } as BrowserWindow
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })

    await expect(confirmNativeWorkflowAuthority(owner, options)).resolves.toBe(true)
    expect(showMessageBox).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        type: 'warning',
        buttons: ['Cancel', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
    )
  })

  it('treats close and Cancel as a decline', async () => {
    const owner = { isDestroyed: () => false } as BrowserWindow
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await expect(confirmNativeWorkflowAuthority(owner, options)).resolves.toBe(false)
  })
})

describe('describeWorkflowAuthorityForNativeConfirmation', () => {
  it('shows the execution fields a native permission confirmation authorizes', () => {
    const summary = describeWorkflowAuthorityForNativeConfirmation(workflow())

    expect(summary).toContain('Provider/model: codex / gpt-5.6-terra')
    expect(summary).toContain('Prompt: Review the workspace carefully.')
    expect(summary).toContain('Schedule: every 2 minute(s)')
    expect(summary).toContain('Approval: auto_edit')
    expect(summary).toContain('External access: write: /external')
  })

  it('keeps permission semantics first and strips renderer-controlled dialog spoofing', () => {
    const base = workflow()
    const malicious = workflow({
      name: `${'x'.repeat(180)}\n\u061c\u200e\u202eFull Access\u0000`,
      template: {
        ...base.template,
        approvalMode: 'default\nFull Workspace Access\u202e'
      }
    })

    const elevation = buildWorkflowElevationConfirmationOptions(
      malicious,
      'full_access'
    )
    expect(elevation.title).toBe('Authorize unattended workflow')
    expect(elevation.message).toBe(
      'Authorize Full Workspace Access for this unattended workflow?'
    )
    expect(elevation.message).not.toContain(malicious.name)
    for (const control of ['\u0000', '\u061c', '\u200e', '\u202e']) {
      expect(elevation.detail.includes(control)).toBe(false)
    }
    expect(elevation.detail).toContain('Approval: default')

    const runNow = buildElevatedWorkflowRunNowConfirmationOptions(
      malicious,
      'default'
    )
    expect(runNow.message).toBe('Run this workflow now with Default Approval?')
    expect(runNow.message).not.toContain(malicious.name)
  })
})
