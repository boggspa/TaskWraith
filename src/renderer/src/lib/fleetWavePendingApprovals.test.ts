import { describe, expect, it } from 'vitest'
import { canAllowAllPendingApprovals } from '../../../shared/fleetWave'
import type { AgentApprovalRequest } from './agentApprovalTypes'
import {
  approvalIdsForAllowAllSameScope,
  collectFleetWavePendingApprovals,
  fleetWaveApprovalScopeKey,
  toFleetWavePendingApproval
} from './fleetWavePendingApprovals'

function makeApproval(overrides: Partial<AgentApprovalRequest> = {}): AgentApprovalRequest {
  return {
    id: 'approval-1',
    provider: 'codex',
    method: 'write_file',
    title: 'Write types',
    body: 'patch src/types.ts',
    actions: ['accept', 'decline'],
    ...overrides
  }
}

describe('fleetWaveApprovalScopeKey', () => {
  it('fingerprints method, preview kind, toolName, and sorted paths', () => {
    const approval = makeApproval({
      method: 'write_file',
      preview: {
        kind: 'tool',
        toolName: 'write_file',
        paths: ['src/b.ts', 'src/a.ts']
      }
    })
    expect(fleetWaveApprovalScopeKey(approval)).toBe(
      'write_file|tool|write_file|src/a.ts,src/b.ts'
    )
  })

  it('reads preview.path and preview.files when paths is absent', () => {
    expect(
      fleetWaveApprovalScopeKey(
        makeApproval({
          method: 'apply_patch',
          preview: { kind: 'diff', toolName: 'apply_patch', path: 'src/solo.ts' }
        })
      )
    ).toBe('apply_patch|diff|apply_patch|src/solo.ts')

    expect(
      fleetWaveApprovalScopeKey(
        makeApproval({
          method: 'shell',
          preview: { kind: 'command', toolName: 'run_shell_command', files: ['a.sh', 'b.sh'] }
        })
      )
    ).toBe('shell|command|run_shell_command|a.sh,b.sh')
  })

  it('returns __unset__ when the fingerprint is empty', () => {
    expect(
      fleetWaveApprovalScopeKey({
        id: 'x',
        provider: 'codex',
        method: '',
        title: '',
        body: '',
        actions: ['accept']
      })
    ).toBe('__unset__')
  })
})

describe('toFleetWavePendingApproval', () => {
  it('maps id, scopeKey, and title (body fallback)', () => {
    const withTitle = makeApproval({
      id: 'a1',
      title: 'Write types',
      preview: { kind: 'tool', toolName: 'write_file', paths: ['src/types.ts'] }
    })
    expect(toFleetWavePendingApproval(withTitle)).toEqual({
      approvalId: 'a1',
      scopeKey: 'write_file|tool|write_file|src/types.ts',
      summary: 'Write types'
    })

    const bodyOnly = makeApproval({
      id: 'a2',
      title: '   ',
      body: 'short body text that should be used when title is blank'
    })
    expect(toFleetWavePendingApproval(bodyOnly)?.summary).toBe(
      'short body text that should be used when title is blank'
    )
  })

  it('excludes canvas_eval and exact-desktop-review approvals', () => {
    expect(
      toFleetWavePendingApproval(
        makeApproval({
          id: 'canvas-1',
          method: 'canvas_eval',
          preview: { toolName: 'canvas_eval', params: { script: '1+1' } }
        })
      )
    ).toBeNull()

    expect(
      toFleetWavePendingApproval(
        makeApproval({
          id: 'canvas-2',
          method: 'mcp',
          preview: {
            toolName: 'taskwraith__canvas_eval',
            requiresExactDesktopReview: true
          }
        })
      )
    ).toBeNull()
  })
})

describe('collectFleetWavePendingApprovals', () => {
  it('collects head then queue per worker in worker order with real approvalIds', () => {
    const workers = ['worker-b', 'worker-a']
    const byChatId: Record<string, AgentApprovalRequest | null> = {
      'worker-a': makeApproval({
        id: 'head-a',
        method: 'write_file',
        title: 'A head',
        preview: { kind: 'tool', toolName: 'write_file', paths: ['src/types.ts'] }
      }),
      'worker-b': makeApproval({
        id: 'head-b',
        method: 'write_file',
        title: 'B head',
        preview: { kind: 'tool', toolName: 'write_file', paths: ['src/types.ts'] }
      })
    }
    const queueByChatId: Record<string, AgentApprovalRequest[]> = {
      'worker-b': [
        makeApproval({
          id: 'queue-b',
          method: 'shell',
          title: 'B queued',
          preview: { kind: 'command', toolName: 'run_shell_command' }
        })
      ]
    }

    const pending = collectFleetWavePendingApprovals(workers, byChatId, queueByChatId)
    expect(pending.map((row) => row.approvalId)).toEqual(['head-b', 'queue-b', 'head-a'])
    expect(pending[0]?.scopeKey).toBe(pending[2]?.scopeKey)
    expect(canAllowAllPendingApprovals([pending[0]!, pending[2]!])).toBe(true)
  })

  it('skips missing chats, null heads, and excluded canvas_eval rows', () => {
    const pending = collectFleetWavePendingApprovals(
      ['missing', 'has-null', 'has-canvas', 'has-ok'],
      {
        'has-null': null,
        'has-canvas': makeApproval({
          id: 'skip-me',
          preview: { toolName: 'canvas_eval', requiresExactDesktopReview: true }
        }),
        'has-ok': makeApproval({
          id: 'keep-me',
          method: 'shell',
          title: 'ok',
          preview: { kind: 'command', toolName: 'run_shell_command' }
        })
      },
      {}
    )
    expect(pending).toEqual([
      {
        approvalId: 'keep-me',
        scopeKey: 'shell|command|run_shell_command|',
        summary: 'ok'
      }
    ])
  })

  it('makes Allow-all false when toolNames differ', () => {
    const pending = collectFleetWavePendingApprovals(
      ['w1', 'w2'],
      {
        w1: makeApproval({
          id: 'a1',
          method: 'write_file',
          preview: { kind: 'tool', toolName: 'write_file', paths: ['x.ts'] }
        }),
        w2: makeApproval({
          id: 'a2',
          method: 'write_file',
          preview: { kind: 'tool', toolName: 'replace', paths: ['x.ts'] }
        })
      },
      {}
    )
    expect(canAllowAllPendingApprovals(pending)).toBe(false)
  })
})

describe('approvalIdsForAllowAllSameScope', () => {
  it('returns matching approvalIds for sequential respond (never invents ids)', () => {
    const pending = collectFleetWavePendingApprovals(
      ['w1', 'w2', 'w3'],
      {
        w1: makeApproval({
          id: 'a1',
          method: 'write_file',
          preview: { kind: 'tool', toolName: 'write_file', paths: ['src/types.ts'] }
        }),
        w2: makeApproval({
          id: 'a2',
          method: 'shell',
          preview: { kind: 'command', toolName: 'run_shell_command' }
        }),
        w3: makeApproval({
          id: 'a3',
          method: 'write_file',
          preview: { kind: 'tool', toolName: 'write_file', paths: ['src/types.ts'] }
        })
      },
      {}
    )
    const scopeKey = pending[0]!.scopeKey
    expect(approvalIdsForAllowAllSameScope(pending, scopeKey)).toEqual(['a1', 'a3'])
    expect(approvalIdsForAllowAllSameScope(pending, 'no-such-scope')).toEqual([])
  })
})
