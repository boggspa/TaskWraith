import { describe, expect, it } from 'vitest'
import type { ChatListItem, ChatRecord, EnsembleConfig } from './types'
import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import {
  ENSEMBLE_PANEL_CONFIGURATION_KEYS,
  ENSEMBLE_SEAT_CONFIGURATION_KEYS
} from '../../shared/ensembleAuthoredSlice'
import { isEnsembleRosterParticipantSnapshot } from '../../shared/EnsembleRosterPresetContract'
import { copyThreadCatalogueChrome } from '../../host-shared/thread-catalogue/ThreadCatalogueChrome'
import { copyThreadCatalogueProjection } from '../../host-shared/thread-catalogue/ThreadCatalogueProjection'
import { projectThreadCatalogueChrome } from './ThreadCatalogueChrome'
import { catalogueChatListItem } from './ThreadCatalogueMirror'

/**
 * The user-authored Ensemble slice must survive every catalogue projection.
 *
 * `ENSEMBLE_*_CONFIGURATION_KEYS` is the spec: the fields a user authors in
 * the orchestration row, roster popover, roster panel and composer pickers.
 * Oversized chats open as a catalogue shell (inline shell object when it fits,
 * else `catalogueChatListItem` over the chrome projection), and that shell's
 * ensemble block is what the row renders AND what a roster-preset Save
 * snapshots. Every key below that a projection drops therefore presents as a
 * lost edit — the Turns chip falling back to `?? 6`, empty seat briefs — and,
 * for `instructions`, as a Save the preset validator must refuse, because a
 * dropped key is `undefined` where `isEnsembleRosterPreset` requires a string.
 *
 * Each projection is driven by the key lists themselves, so adding a future
 * authored key without a projection shape fails here instead of shipping as
 * the next "my edit did not stick" report.
 */

const CHAT_ID = 'chat-contract-1'

function brief(prefix: string): string {
  return `${prefix}: `.padEnd(129, 'b')
}

function canonicalEnsemble(): EnsembleConfig {
  return {
    enabled: true,
    activeRosterPresetId: 'preset-contract-1',
    orchestrationMode: 'continuous',
    concurrentModeEnabled: true,
    fanoutPolicy: 'all',
    fanoutIsolation: 'worktree',
    roundMode: 'rebuttal',
    maxContinuationHops: 64,
    ensembleContextChars: 65536,
    selfReflective: true,
    bossmanParticipantId: 'seat-boss',
    captainParticipantIds: ['seat-captain-1', 'seat-captain-2'],
    secondInCommandParticipantId: 'seat-second',
    synthesizerParticipantId: 'seat-synth',
    bossmanAutoApprovals: {
      enabled: true,
      mode: 'permission_preset_once',
      confirmedAt: '2026-09-11T20:00:00.000Z'
    },
    maxParticipants: 5,
    participants: [
      {
        id: 'seat-boss',
        provider: 'gemini',
        enabled: true,
        role: 'Boss',
        instructions: brief('seat-boss'),
        order: 1,
        model: 'gemini-3-pro',
        runtimeProfileId: 'runtime-high',
        geminiAuthProfileId: 'auth-profile-9',
        ollamaRunProfile: 'verify_with_shell',
        permissionPresetId: 'custom',
        permissionOverrides: {
          approvalMode: 'ask',
          agenticServices: { shellCommands: 'ask', fileChanges: 'deny', mcpTools: 'workspace' },
          networkAccess: 'deny',
          externalPathGrants: [
            {
              id: 'grant-1',
              provider: 'gemini',
              bindingVersion: 2,
              workspaceId: 'ws-1',
              chatId: CHAT_ID,
              appRunId: 'run-1',
              path: '/Users/example/project/docs',
              kind: 'directory',
              access: 'read',
              duration: 'thisThread',
              securityScopedBookmark: 'Ym9va21hcms=',
              issuedBy: 'main',
              signature: 'sig-abcdef',
              createdAt: '2026-09-11T19:00:00.000Z',
              order: 2
            }
          ]
        },
        stageRole: 'reviewer',
        reasoningEffort: 'high',
        fastModeEnabled: true,
        thinkingEnabled: false,
        serviceTier: 'priority',
        pooledAgentId: 'pooled-agent-uuid-1',
        pooledAgentIdentity: {
          schemaVersion: 1,
          agentId: 'agent-uuid-1',
          nickname: 'Scout',
          iconKind: 'named',
          hue: 210,
          saturation: 65,
          brightness: 58,
          accent: '#5a94ff'
        }
      },
      {
        id: 'seat-second',
        provider: 'claude',
        enabled: false,
        role: 'Second',
        instructions: brief('seat-second'),
        order: 2,
        model: 'claude-opus-4-1',
        runtimeProfileId: 'runtime-low',
        geminiAuthProfileId: null,
        ollamaRunProfile: 'local_scout',
        permissionPresetId: 'read_only',
        stageRole: 'worker',
        reasoningEffort: 'low',
        fastModeEnabled: false,
        thinkingEnabled: true,
        serviceTier: 'flex'
      }
    ]
  }
}

function canonicalChat(): ChatRecord {
  return {
    appChatId: CHAT_ID,
    title: 'Contract chat',
    provider: 'gemini',
    scope: 'workspace',
    chatKind: 'ensemble',
    createdAt: 1789000000000,
    updatedAt: 1789000001000,
    archived: false,
    messages: [],
    runs: [],
    ensemble: canonicalEnsemble()
  } as unknown as ChatRecord
}

function chromeEnsemble(value: unknown): EnsembleConfig | undefined {
  return (value as { ensemble?: EnsembleConfig } | null | undefined)?.ensemble
}

function leanRowProjection(): ThreadCatalogueProjection {
  const chat = canonicalChat()
  return {
    revision: 7,
    summary: {
      chatId: CHAT_ID,
      title: chat.title,
      provider: chat.provider ?? 'gemini',
      chatKind: 'ensemble',
      scope: 'workspace',
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      archived: false,
      messageCount: 0,
      runCount: 0,
      chrome: projectThreadCatalogueChrome(chat)
    },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

function expectAuthoredSliceSurvives(label: string, projected: EnsembleConfig | undefined): void {
  const canonical = canonicalEnsemble()
  const gaps: string[] = []
  const check = (actual: unknown, expected: unknown, message: string): void => {
    try {
      expect(actual, message).toEqual(expected)
    } catch {
      gaps.push(message)
    }
  }
  if (!projected) {
    gaps.push(`${label}: ensemble block is missing`)
  } else {
    for (const key of ENSEMBLE_PANEL_CONFIGURATION_KEYS) {
      check(projected[key], canonical[key], `${label}: panel key ${key}`)
    }
    check(
      projected.participants.map((seat) => seat.id),
      canonical.participants.map((seat) => seat.id),
      `${label}: seat membership`
    )
    for (const seat of canonical.participants) {
      const out = projected.participants.find((candidate) => candidate.id === seat.id)
      if (!out) {
        gaps.push(`${label}: seat ${seat.id} is missing`)
        continue
      }
      for (const key of ENSEMBLE_SEAT_CONFIGURATION_KEYS) {
        check(out[key], seat[key], `${label}: seat ${seat.id} key ${key}`)
      }
    }
  }
  expect(gaps, `${label}: dropped authored keys`).toEqual([])
}

describe('ensemble authored-slice projection contract', () => {
  it('carries every authored key through copyThreadCatalogueChrome', () => {
    const chrome = copyThreadCatalogueChrome({ ensemble: canonicalEnsemble() })
    expectAuthoredSliceSurvives('chrome', chromeEnsemble(chrome))
  })

  it('carries every authored key through projectThreadCatalogueChrome', () => {
    const chrome = projectThreadCatalogueChrome(canonicalChat())
    expectAuthoredSliceSurvives('store chrome', chromeEnsemble(chrome))
  })

  it('carries every authored key through the lean list row (paged-shell fallback)', () => {
    const row: ChatListItem = catalogueChatListItem(leanRowProjection())
    expectAuthoredSliceSurvives('lean row', row.ensemble)
  })

  it('carries every authored key through the projection decode round trip', () => {
    const wire = JSON.parse(JSON.stringify(leanRowProjection())) as unknown
    const decoded = copyThreadCatalogueProjection(wire, CHAT_ID)
    expect(decoded, 'projection decode rejects the record').not.toBeNull()
    expectAuthoredSliceSurvives('decoded', chromeEnsemble(decoded?.summary.chrome))
  })

  it('keeps projected seats preset-serializable (Save refusal regression)', () => {
    const row: ChatListItem = catalogueChatListItem(leanRowProjection())
    expect(row.ensemble?.participants.length).toBeGreaterThan(0)
    for (const seat of row.ensemble?.participants ?? []) {
      expect(isEnsembleRosterParticipantSnapshot(seat), `seat ${seat.id}`).toBe(true)
    }
  })

  it('bounds chrome output for a maximal roster (sidebar index guard)', () => {
    // instructions carries 4096 chars per seat with up to 50 seats, so an
    // unbounded copy would put ~200 KB of briefs in one catalogue row. The
    // copy budget must cap the whole chrome object instead.
    const seat = canonicalEnsemble().participants[0]
    const maximal = {
      ...canonicalEnsemble(),
      participants: Array.from({ length: 50 }, (_, index) => ({
        ...seat,
        id: `seat-max-${index}`,
        instructions: 'x'.repeat(4096)
      }))
    }
    const maximalBytes = Buffer.byteLength(
      JSON.stringify(copyThreadCatalogueChrome({ ensemble: maximal })),
      'utf8'
    )
    expect(maximalBytes).toBeLessThan(48 * 1024)
    // A realistic 10-seat roster with measured-length briefs stays lean.
    const realistic = {
      ...canonicalEnsemble(),
      participants: Array.from({ length: 10 }, (_, index) => ({
        ...seat,
        id: `seat-real-${index}`
      }))
    }
    const realisticBytes = Buffer.byteLength(
      JSON.stringify(copyThreadCatalogueChrome({ ensemble: realistic })),
      'utf8'
    )
    expect(realisticBytes).toBeLessThan(16 * 1024)
  })
})
