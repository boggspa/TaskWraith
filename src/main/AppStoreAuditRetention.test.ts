import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { dirname, join } from 'path'
import { AppStore } from './store'
import {
  createApprovalLedgerRecord,
  resolveApprovalLedgerRecord
} from './ApprovalLedger'
import type { AgentApprovalAction } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-audit-retention-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath,
    getVersion: () => '1.0.0'
  }
}))

const nowIso = '2026-07-03T00:00:00.000Z'
const oldIso = '2026-06-01T00:00:00.000Z'
const freshIso = '2026-07-02T12:00:00.000Z'

function writeJson(path: string, value: unknown): void {
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, JSON.stringify(value), 'utf8')
}

function seedApprovalLedger(): void {
  const base = {
    provider: 'codex' as const,
    service: 'shellCommands' as const,
    method: 'codex-mcp/run_shell_command',
    title: 'Approve',
    body: 'Run command',
    actions: ['accept', 'acceptForWorkspace', 'decline'] as AgentApprovalAction[],
    workspaceId: 'ws-1',
    workspacePath: '/repo'
  }
  const expired = resolveApprovalLedgerRecord(
    createApprovalLedgerRecord({ ...base, approvalId: 'old-approval' }, oldIso),
    'accept',
    oldIso
  )
  const fresh = resolveApprovalLedgerRecord(
    createApprovalLedgerRecord({ ...base, approvalId: 'fresh-approval' }, freshIso),
    'accept',
    freshIso
  )
  const liveWorkspaceGrant = resolveApprovalLedgerRecord(
    createApprovalLedgerRecord({ ...base, approvalId: 'live-workspace-grant' }, oldIso),
    'acceptForWorkspace',
    oldIso
  )
  writeJson(join(userDataPath, 'approval-ledger.json'), [expired, fresh, liveWorkspaceGrant])
}

function seedWorkspaceChanges(): void {
  writeJson(join(userDataPath, 'workspace-changes.json'), [
    {
      schemaVersion: 1,
      id: 'old-change',
      source: 'provider_run',
      status: 'captured',
      title: 'Old',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      createdAt: oldIso,
      updatedAt: oldIso,
      files: [],
      artifacts: [],
      stats: { filesChanged: 0, additions: 0, deletions: 0 }
    },
    {
      schemaVersion: 1,
      id: 'fresh-change',
      source: 'provider_run',
      status: 'captured',
      title: 'Fresh',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      createdAt: freshIso,
      updatedAt: freshIso,
      files: [],
      artifacts: [],
      stats: { filesChanged: 0, additions: 0, deletions: 0 }
    }
  ])
}

function seedAuditRuns(): void {
  writeJson(join(userDataPath, 'audit-runs.json'), [
    {
      schemaVersion: 1,
      id: 'old-audit',
      mode: 'quick',
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      status: 'completed',
      phases: [],
      dimensions: [],
      participants: [],
      findings: [],
      verdicts: [],
      gates: [],
      budget: { maxAgents: 1, spentAgents: 1, spentTokens: 0, truncated: false },
      createdAt: oldIso,
      updatedAt: oldIso,
      endedAt: oldIso
    },
    {
      schemaVersion: 1,
      id: 'fresh-audit',
      mode: 'quick',
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      status: 'completed',
      phases: [],
      dimensions: [],
      participants: [],
      findings: [],
      verdicts: [],
      gates: [],
      budget: { maxAgents: 1, spentAgents: 1, spentTokens: 0, truncated: false },
      createdAt: freshIso,
      updatedAt: freshIso,
      endedAt: freshIso
    }
  ])
}

function seedFeedbackAndCrashes(): void {
  writeJson(join(userDataPath, 'thumbs-ledger.json'), [
    {
      schemaVersion: 1,
      id: 'old-feedback',
      source: 'message_metadata',
      action: 'set',
      chatId: 'chat-1',
      messageId: 'msg-old',
      vote: 'down',
      at: Date.parse(oldIso),
      recordedAt: Date.parse(oldIso)
    },
    {
      schemaVersion: 1,
      id: 'fresh-feedback',
      source: 'message_metadata',
      action: 'set',
      chatId: 'chat-1',
      messageId: 'msg-fresh',
      vote: 'up',
      at: Date.parse(freshIso),
      recordedAt: Date.parse(freshIso)
    }
  ])
  writeJson(join(userDataPath, 'product-crashes.json'), [
    {
      schemaVersion: 1,
      id: 'old-crash',
      source: 'main',
      severity: 'warning',
      occurredAt: oldIso,
      appVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      message: 'old'
    },
    {
      schemaVersion: 1,
      id: 'fresh-crash',
      source: 'main',
      severity: 'warning',
      occurredAt: freshIso,
      appVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      message: 'fresh'
    }
  ])
}

function seedRunEvents(): void {
  AppStore.appendRunEvent({
    runId: 'old-run',
    provider: 'codex',
    kind: 'lifecycle',
    phase: 'control',
    source: 'main',
    summary: 'old'
  })
  AppStore.appendRunEvent({
    runId: 'fresh-run',
    provider: 'codex',
    kind: 'lifecycle',
    phase: 'control',
    source: 'main',
    summary: 'fresh'
  })
  const oldRunPath = join(userDataPath, 'run-events', 'old-run.jsonl')
  const oldDate = new Date(oldIso)
  fs.utimesSync(oldRunPath, oldDate, oldDate)
}

describe('AppStore audit retention purge', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
    seedApprovalLedger()
    seedWorkspaceChanges()
    seedAuditRuns()
    seedFeedbackAndCrashes()
    seedRunEvents()
  })

  it('purges expired audit evidence and records a redacted purge receipt', () => {
    const result = AppStore.purgeAuditRetentionEvidence({
      dryRun: false,
      now: nowIso,
      policy: {
        enabled: true,
        maxAgeDays: {
          approvalLedger: 1,
          runEvents: 1,
          workspaceChanges: 1,
          auditRuns: 1,
          messageFeedback: 1,
          productCrashes: 1
        }
      }
    })

    expect(result.ok).toBe(true)
    expect(result.receipt?.dryRun).toBe(false)
    expect(result.receipt?.counts.approvalLedger).toMatchObject({
      scanned: 3,
      deleted: 1,
      retained: 2
    })
    expect(result.receipt?.counts.runEvents).toMatchObject({
      scanned: 2,
      deleted: 1,
      retained: 1
    })
    expect(AppStore.getApprovalLedger().map((record) => record.approvalId).sort()).toEqual([
      'fresh-approval',
      'live-workspace-grant'
    ])
    expect(AppStore.getWorkspaceChangeSets().map((record) => record.id)).toEqual(['fresh-change'])
    expect(AppStore.getAuditRuns().map((record) => record.id)).toEqual(['fresh-audit'])
    expect(AppStore.getMessageFeedbackReceipts().map((record) => record.id)).toEqual([
      'fresh-feedback'
    ])
    expect(AppStore.getProductCrashes().map((record) => record.id)).toEqual(['fresh-crash'])
    expect(fs.existsSync(join(userDataPath, 'run-events', 'old-run.jsonl'))).toBe(false)
    expect(fs.existsSync(join(userDataPath, 'run-events', 'fresh-run.jsonl'))).toBe(true)
    expect(AppStore.getAuditRetentionPurgeReceipts()).toHaveLength(1)
  })

  it('dry-runs without deleting evidence while still reporting candidates', () => {
    const result = AppStore.purgeAuditRetentionEvidence({
      dryRun: true,
      now: nowIso,
      policy: { enabled: true, maxAgeDays: { runEvents: 1, approvalLedger: 1 } }
    })

    expect(result.ok).toBe(true)
    expect(result.receipt?.dryRun).toBe(true)
    expect(result.receipt?.counts.runEvents.deleted).toBe(1)
    expect(fs.existsSync(join(userDataPath, 'run-events', 'old-run.jsonl'))).toBe(true)
    expect(AppStore.getApprovalLedger().map((record) => record.approvalId).sort()).toEqual([
      'fresh-approval',
      'live-workspace-grant',
      'old-approval'
    ])
  })
})
