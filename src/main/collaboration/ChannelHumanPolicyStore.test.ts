import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { contributionRulesForPreset } from './HumanContributionRules'
import {
  ChannelHumanPolicyError,
  ChannelHumanPolicyStore,
  channelHumanPolicyPath,
  ordinaryChannelHumanPolicy,
  type ChannelHumanMigrationPolicyInput
} from './ChannelHumanPolicyStore'

const PLAN_ID = 'a'.repeat(64)
const TERMINAL_PLAN_ID = 'c'.repeat(64)
const SOURCE_DIGEST = 'b'.repeat(64)

function policy(
  overrides: Partial<ChannelHumanMigrationPolicyInput> = {}
): ChannelHumanMigrationPolicyInput {
  return {
    channelId: 'channel_one',
    memberId: 'member_one',
    sourceShareId: 'share_one',
    sourceCollaboratorId: 'collaborator_one',
    sourceDigest: SOURCE_DIGEST,
    rules: contributionRulesForPreset('comments'),
    requiresHostApproval: false,
    fullHistory: false,
    ...overrides
  }
}

function withStore(
  run: (store: ChannelHumanPolicyStore, path: string, root: string) => void
): void {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-channel-human-policy-'))
  const path = channelHumanPolicyPath(root)
  try {
    run(new ChannelHumanPolicyStore(path), path, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('ChannelHumanPolicyStore', () => {
  it('persists a migration batch atomically and replays it idempotently', () => {
    withStore((store, path) => {
      const inputs = [
        policy(),
        policy({
          memberId: 'member_two',
          sourceCollaboratorId: 'collaborator_two',
          rules: contributionRulesForPreset('readOnly'),
          requiresHostApproval: true,
          fullHistory: true
        })
      ]
      const applied = store.applyMigrationPolicies({
        migrationPlanId: PLAN_ID,
        policies: inputs,
        now: 1_000
      })

      expect(applied).toHaveLength(2)
      expect(applied[0]).toMatchObject({
        migrationPlanId: PLAN_ID,
        channelId: 'channel_one',
        memberId: 'member_one',
        createdAt: 1_000,
        updatedAt: 1_000
      })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(new ChannelHumanPolicyStore(path).list()).toEqual(applied)

      const before = readFileSync(path)
      expect(
        store.applyMigrationPolicies({
          migrationPlanId: PLAN_ID,
          policies: inputs,
          now: 2_000
        })
      ).toEqual(applied)
      expect(readFileSync(path)).toEqual(before)
    })
  })

  it('preserves ordinary Channel behavior when no migration policy exists', () => {
    const store = new ChannelHumanPolicyStore()
    expect(
      store.evaluate({
        channelId: 'ordinary_channel',
        memberId: 'ordinary_member',
        intent: 'comment',
        contentBytes: 10
      })
    ).toEqual({ outcome: 'append', policy: null })
    expect(
      store.evaluate({
        channelId: 'ordinary_channel',
        memberId: 'ordinary_member',
        intent: 'comment',
        contentBytes: 8_001
      })
    ).toMatchObject({ outcome: 'deny', code: 'quota_exceeded', policy: null })
    expect(ordinaryChannelHumanPolicy()).toEqual(contributionRulesForPreset('comments'))
  })

  it('evaluates read-only, size, allow-list, and host-review constraints fail closed', () => {
    const store = new ChannelHumanPolicyStore()
    store.applyMigrationPolicies({
      migrationPlanId: PLAN_ID,
      now: 1_000,
      policies: [
        policy({ memberId: 'read_only', rules: contributionRulesForPreset('readOnly') }),
        policy({
          memberId: 'limited',
          rules: {
            ...contributionRulesForPreset('comments'),
            maxContributionBytes: 500
          }
        }),
        policy({
          memberId: 'excluded',
          rules: {
            ...contributionRulesForPreset('comments'),
            allowedCollaboratorIds: ['somebody_else']
          }
        }),
        policy({ memberId: 'reviewed', requiresHostApproval: true })
      ]
    })

    expect(
      store.evaluate({
        channelId: 'channel_one',
        memberId: 'read_only',
        intent: 'comment',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'deny', code: 'read_only' })
    expect(
      store.evaluate({
        channelId: 'channel_one',
        memberId: 'limited',
        intent: 'comment',
        contentBytes: 501
      })
    ).toMatchObject({ outcome: 'deny', code: 'quota_exceeded' })
    expect(
      store.evaluate({
        channelId: 'channel_one',
        memberId: 'excluded',
        intent: 'comment',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'deny', code: 'rule_denied' })
    expect(
      store.evaluate({
        channelId: 'channel_one',
        memberId: 'reviewed',
        intent: 'comment',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'host_review' })
  })

  it('routes host-action tiers without ever granting provider dispatch', () => {
    const store = new ChannelHumanPolicyStore()
    store.applyMigrationPolicies({
      migrationPlanId: PLAN_ID,
      now: 1_000,
      policies: [
        policy({ memberId: 'comments' }),
        policy({ memberId: 'request', rules: contributionRulesForPreset('requestHostAction') }),
        policy({ memberId: 'draft', rules: contributionRulesForPreset('autoDraft') })
      ]
    })

    expect(
      store.evaluate({
        channelId: 'channel_one',
        memberId: 'comments',
        intent: 'requestHostAction',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'deny', code: 'rule_denied' })
    expect(
      store.evaluate({
        channelId: 'channel_one',
        memberId: 'request',
        intent: 'requestHostAction',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'host_review' })
    expect(
      store.evaluate({
        channelId: 'channel_one',
        memberId: 'draft',
        intent: 'requestHostAction',
        contentBytes: 10
      })
    ).toMatchObject({ outcome: 'auto_draft' })
    expect(store.list().every((entry) => entry.rules.providerDispatch === 'never')).toBe(true)
  })

  it('rejects widened rules, duplicate batches, and conflicting reruns before mutation', () => {
    withStore((store, path) => {
      const direct = policy({
        rules: {
          ...contributionRulesForPreset('comments'),
          preset: 'directLimited',
          providerDispatch: 'direct-limited'
        }
      })
      expect(() =>
        store.applyMigrationPolicies({
          migrationPlanId: PLAN_ID,
          policies: [direct],
          now: 1_000
        })
      ).toThrow(ChannelHumanPolicyError)

      expect(() =>
        store.applyMigrationPolicies({
          migrationPlanId: PLAN_ID,
          policies: [policy(), policy()],
          now: 1_000
        })
      ).toThrow(/duplicates/)

      store.applyMigrationPolicies({ migrationPlanId: PLAN_ID, policies: [policy()], now: 1_000 })
      const before = readFileSync(path)
      expect(() =>
        store.applyMigrationPolicies({
          migrationPlanId: PLAN_ID,
          policies: [policy({ requiresHostApproval: true })],
          now: 2_000
        })
      ).toThrow(/conflicts/)
      expect(readFileSync(path)).toEqual(before)
    })
  })

  it('reconciles a terminal policy only for the same durable member/source binding', () => {
    withStore((store, path) => {
      const initial = store.applyMigrationPolicies({
        migrationPlanId: PLAN_ID,
        policies: [policy()],
        now: 1_000
      })[0]
      const terminal = policy({
        sourceDigest: 'd'.repeat(64),
        rules: contributionRulesForPreset('readOnly'),
        requiresHostApproval: true,
        fullHistory: true
      })

      const reconciled = store.reconcileMigrationPolicies({
        initialMigrationPlanId: PLAN_ID,
        migrationPlanId: TERMINAL_PLAN_ID,
        policies: [terminal],
        now: 2_000
      })
      expect(reconciled).toEqual([
        expect.objectContaining({
          migrationPlanId: TERMINAL_PLAN_ID,
          sourceDigest: terminal.sourceDigest,
          rules: terminal.rules,
          requiresHostApproval: true,
          fullHistory: true,
          createdAt: initial.createdAt,
          updatedAt: 2_000
        })
      ])
      expect(
        store.evaluate({
          channelId: terminal.channelId,
          memberId: terminal.memberId,
          intent: 'comment',
          contentBytes: 10
        })
      ).toMatchObject({ outcome: 'deny', code: 'read_only' })

      const beforeRerun = readFileSync(path)
      expect(
        store.reconcileMigrationPolicies({
          initialMigrationPlanId: PLAN_ID,
          migrationPlanId: TERMINAL_PLAN_ID,
          policies: [terminal],
          now: 3_000
        })
      ).toEqual(reconciled)
      expect(readFileSync(path)).toEqual(beforeRerun)

      const beforeConflict = readFileSync(path)
      expect(() =>
        store.reconcileMigrationPolicies({
          initialMigrationPlanId: PLAN_ID,
          migrationPlanId: 'e'.repeat(64),
          policies: [terminal],
          now: 4_000
        })
      ).toThrow(/conflicts/)
      expect(() =>
        store.reconcileMigrationPolicies({
          initialMigrationPlanId: PLAN_ID,
          migrationPlanId: TERMINAL_PLAN_ID,
          policies: [policy({ sourceCollaboratorId: 'different_collaborator' })],
          now: 4_000
        })
      ).toThrow(/conflicts/)
      expect(readFileSync(path)).toEqual(beforeConflict)
    })
  })

  it('fails recovery closed on corrupt state and purges only the requested Channels', () => {
    withStore((store, path) => {
      store.applyMigrationPolicies({
        migrationPlanId: PLAN_ID,
        now: 1_000,
        policies: [policy(), policy({ channelId: 'channel_two', memberId: 'member_two' })]
      })
      expect(store.purgeChannels(['channel_one'])).toBe(1)
      expect(store.list().map((entry) => entry.channelId)).toEqual(['channel_two'])
      expect(store.purgeChannels(['channel_one'])).toBe(0)

      writeFileSync(path, '{not-json')
      const corrupt = readFileSync(path)
      const restarted = new ChannelHumanPolicyStore(path)
      expect(() => restarted.list()).toThrow(/recovery-blocked/)
      expect(() =>
        restarted.applyMigrationPolicies({
          migrationPlanId: PLAN_ID,
          policies: [policy()],
          now: 2_000
        })
      ).toThrow(/recovery-blocked/)
      expect(readFileSync(path)).toEqual(corrupt)
    })
  })
})
