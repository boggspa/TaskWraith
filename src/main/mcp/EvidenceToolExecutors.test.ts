import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { projectCapabilityLedgerFromEvidencePacks } from '../EvidencePackModel'
import { TASKWRAITH_TOOL_ACTIONS } from '../../shared/providerActionTaxonomy'
import type { ChatRecord, EvidencePackRecord, RepoConventionIndexSnapshot } from '../store/types'
import {
  executeEvidenceMcpTool,
  isEvidenceMcpToolName,
  type EvidenceToolStore
} from './EvidenceToolExecutors'
import type { WorkspaceToolContext } from './WorkspaceToolExecutors'

function workspaceChat(id: string, workspaceId: string, workspacePath: string): ChatRecord {
  return {
    appChatId: id,
    title: id,
    provider: 'codex',
    scope: 'workspace',
    workspaceId,
    workspacePath,
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    archived: false
  } as ChatRecord
}

function context(chatId: string): WorkspaceToolContext {
  return {
    scope: 'workspace',
    cwd: '/repo',
    workspacePath: '/repo',
    appChatId: chatId
  }
}

function contextForPath(chatId: string, workspacePath: string): WorkspaceToolContext {
  return {
    scope: 'workspace',
    cwd: workspacePath,
    workspacePath,
    appChatId: chatId
  }
}

function createStore(): EvidenceToolStore & { __addChat(chat: ChatRecord): void } {
  const chats = new Map<string, ChatRecord>()
  const packs: EvidencePackRecord[] = []
  const conventionIndexes: RepoConventionIndexSnapshot[] = []
  const now = '2026-07-02T18:00:00.000Z'

  return {
    getChat(chatId) {
      return chats.get(chatId)
    },
    getEvidencePacks(workspaceId) {
      return packs.filter((pack) => !workspaceId || pack.workspaceId === workspaceId)
    },
    saveEvidencePack(pack) {
      const saved: EvidencePackRecord = {
        schemaVersion: 1,
        id: pack.id || `pack-${packs.length + 1}`,
        workspaceId: pack.workspaceId || 'ws-1',
        workspacePath: pack.workspacePath,
        chatId: pack.chatId,
        runId: pack.runId,
        provider: pack.provider,
        title: pack.title,
        mapEntries: pack.mapEntries || [],
        capabilityCells: pack.capabilityCells || [],
        completionClaims: pack.completionClaims || [],
        diffTouchedFiles: pack.diffTouchedFiles,
        createdAt: pack.createdAt || now,
        updatedAt: pack.updatedAt || now
      }
      packs.push(saved)
      return saved
    },
    getCapabilityLedgerSnapshot(workspaceId) {
      return projectCapabilityLedgerFromEvidencePacks(
        packs.filter((pack) => !workspaceId || pack.workspaceId === workspaceId),
        { workspaceId, now: new Date(now) }
      )
    },
    getRepoConventionIndexes(workspaceId) {
      return conventionIndexes.filter((snapshot) => !workspaceId || snapshot.workspaceId === workspaceId)
    },
    saveRepoConventionIndex(snapshot) {
      const saved: RepoConventionIndexSnapshot = {
        schemaVersion: 1,
        workspaceId: snapshot.workspaceId || 'ws-1',
        workspacePath: snapshot.workspacePath,
        generatedAt: snapshot.generatedAt || now,
        entries: snapshot.entries || [],
        staleReason: snapshot.staleReason
      }
      conventionIndexes.push(saved)
      return saved
    },
    __addChat(chat) {
      chats.set(chat.appChatId, chat)
    }
  }
}

describe('EvidenceToolExecutors', () => {
  it('recognizes Evidence Pack MCP tools', () => {
    expect(isEvidenceMcpToolName('prompt_task_normalize')).toBe(true)
    expect(isEvidenceMcpToolName('scope_radar')).toBe(true)
    expect(isEvidenceMcpToolName('repo_convention_scan')).toBe(true)
    expect(isEvidenceMcpToolName('coherence_gate_check')).toBe(true)
    expect(isEvidenceMcpToolName('evidence_pack_write')).toBe(true)
    expect(isEvidenceMcpToolName('completion_claim_check')).toBe(true)
    expect(isEvidenceMcpToolName('workspace_search')).toBe(false)
  })

  it('records a Scope Radar map as an Evidence Pack for the active run', async () => {
    const store = createStore()
    store.__addChat(workspaceChat('chat-1', 'ws-1', '/repo'))

    const result = await executeEvidenceMcpTool(
      store,
      'scope_radar',
      { prompt: 'Make my app import UI. It should support arbitrary UI.' },
      context('chat-1'),
      { provider: 'codex', runId: 'run-1' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({
      ok: true,
      tool: 'scope_radar',
      recorded: true,
      radar: {
        riskLevel: 'high',
        sliceKinds: {
          'source-format-contract': 'prerequisite',
          'arbitrary-ui-coverage': 'speculative'
        }
      },
      evidencePack: {
        workspaceId: 'ws-1',
        chatId: 'chat-1',
        runId: 'run-1',
        provider: 'codex'
      },
      ledger: {
        capabilityCount: expect.any(Number),
        mapEntryCount: expect.any(Number)
      }
    })
    expect(store.getEvidencePacks('ws-1')).toHaveLength(1)
    expect(TASKWRAITH_TOOL_ACTIONS.scope_radar).toMatchObject({
      operation: 'control.mutate',
      mutation: 'host-state',
      lock: 'host-resource'
    })
    expect(store.getEvidencePacks('ws-1')[0]?.capabilityCells[0]?.status).toBe('unverified')
  })

  it('normalizes messy prompt intent with repo convention context', async () => {
    const store = createStore()
    store.__addChat(workspaceChat('chat-1', 'ws-1', '/repo'))
    store.saveRepoConventionIndex({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      generatedAt: '2026-07-02T18:00:00.000Z',
      entries: [
        {
          id: 'component-family-react',
          kind: 'component_family',
          title: 'React component files are part of the UI surface',
          paths: ['src/renderer/src/components/Button.tsx'],
          provenance: 'scan',
          updatedAt: '2026-07-02T18:00:00.000Z'
        }
      ]
    })

    const result = await executeEvidenceMcpTool(
      store,
      'prompt_task_normalize',
      {
        prompt: 'Make my app import UI. It should support arbitrary UI.',
        currentState: 'The visual editor can place components.'
      },
      context('chat-1'),
      { provider: 'codex', runId: 'run-1' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({
      ok: true,
      tool: 'prompt_task_normalize',
      workspaceId: 'ws-1',
      contract: {
        riskLevel: 'high',
        inferredMode: 'explore',
        firstSliceKey: 'source-format-contract',
        conventionIndexGeneratedAt: '2026-07-02T18:00:00.000Z'
      }
    })
    expect((result.result as any).contract.allowedSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'React component files are part of the UI surface',
          source: 'repo_convention'
        })
      ])
    )
  })

  it('can preview Scope Radar without recording evidence', async () => {
    const store = createStore()
    store.__addChat(workspaceChat('chat-1', 'ws-1', '/repo'))

    const result = await executeEvidenceMcpTool(
      store,
      'scope_radar',
      { prompt: 'Add retry button to failed upload card.', record: false },
      context('chat-1'),
      { provider: 'codex', runId: 'run-1' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({
      ok: true,
      tool: 'scope_radar',
      recorded: false,
      radar: { riskLevel: 'low' }
    })
    expect(store.getEvidencePacks('ws-1')).toHaveLength(0)
  })

  it('scans and records a Repo Convention Index for the active workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-conventions-'))
    try {
      await fs.mkdir(path.join(root, 'src', 'renderer', 'src', 'components'), { recursive: true })
      await fs.mkdir(path.join(root, 'src', 'renderer', 'src', 'assets', 'css'), { recursive: true })
      await fs.mkdir(path.join(root, 'src', 'main'), { recursive: true })
      await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
      await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"vitest"}}')
      await fs.writeFile(path.join(root, 'src', 'renderer', 'src', 'components', 'Button.tsx'), 'export function Button() { return null }')
      await fs.writeFile(path.join(root, 'src', 'renderer', 'src', 'assets', 'css', 'theme.css'), ':root {}')
      await fs.writeFile(path.join(root, 'src', 'main', 'Button.test.ts'), 'test("x", () => {})')

      const store = createStore()
      store.__addChat(workspaceChat('chat-1', 'ws-1', root))

      const result = await executeEvidenceMcpTool(
        store,
        'repo_convention_scan',
        {},
        contextForPath('chat-1', root),
        { provider: 'codex', runId: 'run-1' }
      )

      expect(result.isError).toBe(false)
      expect(result.result).toMatchObject({
        ok: true,
        tool: 'repo_convention_scan',
        recorded: true,
        summary: {
          entryCount: expect.any(Number),
          truncated: false
        },
        snapshot: {
          workspaceId: 'ws-1',
          workspacePath: root
        }
      })
      const entries = (result.result as any).snapshot.entries.map((entry: any) => entry.id)
      expect(entries).toContain('package-manager-node')
      expect(entries).toContain('component-family-react')
      expect(entries).toContain('style-system-existing-assets')
      expect(entries).toContain('test-convention-nearby')
      expect(entries).toContain('generated-paths-avoid-editing')
      expect(TASKWRAITH_TOOL_ACTIONS.repo_convention_scan).toMatchObject({
        operation: 'control.mutate',
        mutation: 'host-state',
        lock: 'host-resource'
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('checks coherence against the latest stored convention index', async () => {
    const store = createStore()
    store.__addChat(workspaceChat('chat-1', 'ws-1', '/repo'))
    store.saveRepoConventionIndex({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      generatedAt: '2026-07-02T18:00:00.000Z',
      entries: [
        {
          id: 'generated-paths-avoid-editing',
          kind: 'generated_path',
          title: 'Generated paths are not source edits',
          paths: ['dist'],
          provenance: 'scan',
          updatedAt: '2026-07-02T18:00:00.000Z'
        }
      ]
    })

    const result = await executeEvidenceMcpTool(
      store,
      'coherence_gate_check',
      {
        prompt: 'Make my app import UI. It should support arbitrary UI.',
        changedFiles: ['dist/bundle.js', 'src/importer/PlaceholderAdapter.ts'],
        newFiles: ['src/importer/PlaceholderAdapter.ts'],
        placeholderFiles: ['src/importer/PlaceholderAdapter.ts']
      },
      context('chat-1'),
      { provider: 'codex', runId: 'run-1' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({
      ok: true,
      tool: 'coherence_gate_check',
      workspaceId: 'ws-1',
      canProceed: false,
      shouldReview: true,
      gate: {
        status: 'block',
        conventionIndexGeneratedAt: '2026-07-02T18:00:00.000Z',
        scopeRiskLevel: 'high'
      }
    })
    const kinds = (result.result as any).gate.findings.map((finding: any) => finding.kind)
    expect(kinds).toContain('generated_path_edit')
    expect(kinds).toContain('placeholder_only_work')
    expect(kinds).toContain('missing_validation_evidence')
  })

  it('writes an agent-stamped Evidence Pack and checks the planned final answer', async () => {
    const store = createStore()
    store.__addChat(workspaceChat('chat-1', 'ws-1', '/repo'))

    const result = await executeEvidenceMcpTool(
      store,
      'evidence_pack_write',
      {
        title: 'Import buttons',
        cells: [
          {
            capabilityKey: 'ui-import-buttons',
            title: 'UI import buttons',
            status: 'verified',
            evidenceRefs: [{ path: 'src/import.test.ts', line: 12 }]
          }
        ],
        claims: [
          {
            claim: 'Button UI import works.',
            supported: true,
            evidenceRefs: [{ path: 'src/import.test.ts', line: 12 }]
          }
        ],
        changedFiles: ['src/import.ts'],
        finalAnswer: 'Implemented and ready for review.'
      },
      context('chat-1'),
      { provider: 'codex', runId: 'run-1' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({
      ok: true,
      evidencePack: {
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        chatId: 'chat-1',
        runId: 'run-1',
        provider: 'codex',
        diffTouchedFiles: ['src/import.ts']
      },
      ledger: {
        capabilityCount: 1,
        totalCompletionClaims: 1,
        unsupportedCompletionClaims: 0
      },
      assessment: {
        status: 'supported',
        hasCompletionLanguage: true
      },
      canClaimComplete: true,
      shouldRevise: false
    })
  })

  it('checks completion claims against the active run evidence only', async () => {
    const store = createStore()
    store.__addChat(workspaceChat('chat-1', 'ws-1', '/repo'))
    store.saveEvidencePack({
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      runId: 'run-other',
      completionClaims: [
        {
          claim: 'Prior run was supported.',
          supported: true,
          evidenceRefs: [{ path: 'prior.test.ts' }]
        }
      ],
      mapEntries: [],
      capabilityCells: []
    })

    const result = await executeEvidenceMcpTool(
      store,
      'completion_claim_check',
      { finalText: 'Done.' },
      context('chat-1'),
      { provider: 'codex', runId: 'run-current' }
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatchObject({
      ok: true,
      runId: 'run-current',
      assessment: {
        status: 'unsupported',
        evidencePackIds: []
      },
      canClaimComplete: false,
      shouldRevise: true
    })
  })

  it('rejects global contexts', async () => {
    const result = await executeEvidenceMcpTool(
      createStore(),
      'completion_claim_check',
      { finalText: 'Done.' },
      { scope: 'global', cwd: '/tmp' },
      { provider: 'codex', runId: 'run-1' }
    )

    expect(result).toMatchObject({
      isError: true,
      result: { ok: false, error: 'Evidence Pack tools require an active workspace chat.' }
    })
  })
})
