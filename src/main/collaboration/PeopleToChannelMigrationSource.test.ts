import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { contributionRulesForPreset } from './HumanContributionRules'
import { inventoryPeopleToChannelMigration } from './PeopleToChannelMigrationInventory'
import {
  PeopleToChannelMigrationSource,
  PeopleToChannelMigrationSourceError
} from './PeopleToChannelMigrationSource'

const MEMBER_KEY = Buffer.alloc(32, 7).toString('base64')

function validSource(): Record<string, unknown> {
  return {
    shares: [
      {
        shareId: 'share_one',
        chatId: 'chat_one',
        mode: 'comments',
        enabled: true,
        createdAt: 100,
        updatedAt: 200,
        nextSequence: 2,
        participants: [
          {
            collaboratorId: 'collaborator_one',
            displayName: 'Alex',
            publicKeyId: MEMBER_KEY,
            status: 'active',
            joinedAt: 120,
            seatOrder: 1,
            colorIndex: 2
          }
        ],
        invites: [
          {
            inviteId: 'invite_one',
            tokenHash: 'legacy-token-hash',
            createdAt: 110,
            expiresAt: 500,
            consumedAt: 120,
            collaboratorId: 'collaborator_one',
            roomId: 'room_one'
          }
        ],
        idempotency: { 'collaborator_one:client_one': 'message_one' },
        contributionRules: contributionRulesForPreset('comments'),
        requiresHostApproval: false,
        fullHistory: false
      }
    ]
  }
}

function withSource(
  value: string | unknown,
  run: (source: PeopleToChannelMigrationSource, path: string) => void
): void {
  const directory = mkdtempSync(join(tmpdir(), 'taskwraith-people-migration-source-'))
  const path = join(directory, 'human-collaboration.json')
  try {
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 })
    run(new PeopleToChannelMigrationSource(path), path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('PeopleToChannelMigrationSource', () => {
  it('treats a genuinely absent donor file as an empty source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-people-migration-source-'))
    try {
      const path = join(directory, 'missing.json')
      const result = new PeopleToChannelMigrationSource(path).read()
      expect(result).toEqual({
        path,
        exists: false,
        bytes: 0,
        fileSha256: null,
        snapshot: { shares: [] }
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('strictly reads a valid source with immutable byte evidence', () => {
    const raw = validSource()
    withSource(raw, (source, path) => {
      const before = readFileSync(path)
      const result = source.read()

      expect(result.exists).toBe(true)
      expect(result.bytes).toBe(before.length)
      expect(result.fileSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.snapshot).toMatchObject({
        shares: [
          {
            shareId: 'share_one',
            chatId: 'chat_one',
            mode: 'comments',
            enabled: true,
            participants: [
              {
                collaboratorId: 'collaborator_one',
                publicKeyId: MEMBER_KEY,
                status: 'active',
                seatOrder: 1,
                colorIndex: 2
              }
            ]
          }
        ]
      })
      expect(result.snapshot.shares[0]).not.toHaveProperty('requiresHostApproval')
      expect(result.snapshot.shares[0]).not.toHaveProperty('fullHistory')
      expect(readFileSync(path)).toEqual(before)
      expect(source.readMigrationSnapshot()).toEqual(result.snapshot)
    })
  })

  it('plugs into the inventory without the legacy store corruption-to-empty path', () => {
    withSource(validSource(), (source) => {
      const plan = inventoryPeopleToChannelMigration({
        hostIdentityPublicKey: Buffer.alloc(32, 8).toString('base64'),
        people: source,
        channels: {
          listChannels: () => [],
          listMembers: () => [],
          listInvites: () => []
        },
        chats: [
          {
            appChatId: 'chat_one',
            title: 'Migration source integration',
            chatKind: 'single',
            messages: []
          }
        ]
      })
      expect(plan.entries[0]).toMatchObject({
        disposition: 'create',
        blockers: [],
        source: { shareId: 'share_one' }
      })
    })
  })

  it('never converts corrupt or unsupported JSON into an empty donor', () => {
    for (const value of [
      '{not json',
      null,
      [],
      {},
      { shares: [], futureSchemaVersion: 2 },
      { shares: 'not-an-array' }
    ]) {
      withSource(value, (source) => {
        expect(() => source.readMigrationSnapshot()).toThrow(PeopleToChannelMigrationSourceError)
      })
    }
  })

  it('blocks malformed identity, timestamps, and participant lifecycle state', () => {
    const cases = [
      (raw: any) => {
        raw.shares[0].participants[0].publicKeyId = 'not-a-public-key'
      },
      (raw: any) => {
        raw.shares[0].createdAt = Date.now() + 0.5
      },
      (raw: any) => {
        delete raw.shares[0].participants[0].joinedAt
      },
      (raw: any) => {
        raw.shares[0].participants[0].status = 'revoked'
      },
      (raw: any) => {
        raw.shares[0].participants[0].displayName = 'Host'
      }
    ]
    for (const mutate of cases) {
      const raw = validSource()
      mutate(raw)
      withSource(raw, (source) => {
        expect(() => source.readMigrationSnapshot()).toThrow(PeopleToChannelMigrationSourceError)
      })
    }
  })

  it('blocks rules that normalize differently or disagree with legacy mode', () => {
    const direct = validSource() as any
    direct.shares[0].contributionRules = {
      ...contributionRulesForPreset('comments'),
      preset: 'directLimited',
      providerDispatch: 'direct-limited'
    }
    withSource(direct, (source) => {
      expect(() => source.readMigrationSnapshot()).toThrow(/rules require repair/)
    })

    const mismatch = validSource() as any
    mismatch.shares[0].mode = 'readOnly'
    withSource(mismatch, (source) => {
      expect(() => source.readMigrationSnapshot()).toThrow(/conflict with the legacy share mode/)
    })
  })

  it('blocks duplicate identities, invite ids, and unsupported nested fields', () => {
    const duplicateIdentity = validSource() as any
    duplicateIdentity.shares[0].participants.push({
      ...duplicateIdentity.shares[0].participants[0],
      collaboratorId: 'collaborator_two'
    })
    withSource(duplicateIdentity, (source) => {
      expect(() => source.readMigrationSnapshot()).toThrow(/identities are duplicated/)
    })

    const duplicateInvite = validSource() as any
    duplicateInvite.shares[0].invites.push({ ...duplicateInvite.shares[0].invites[0] })
    withSource(duplicateInvite, (source) => {
      expect(() => source.readMigrationSnapshot()).toThrow(/invite ids are duplicated/)
    })

    const unsupported = validSource() as any
    unsupported.shares[0].participants[0].futureAuthority = true
    withSource(unsupported, (source) => {
      expect(() => source.readMigrationSnapshot()).toThrow(/unsupported fields/)
    })
  })
})
