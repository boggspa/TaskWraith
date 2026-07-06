import { describe, expect, it } from 'vitest'
import { TrustedSessionGrantStore } from './TrustedSessionGrants'

describe('TrustedSessionGrantStore', () => {
  it('grants and revokes host trust for one solo chat/provider scope', () => {
    const store = new TrustedSessionGrantStore(() => '2026-07-06T09:00:00.000Z')

    expect(
      store.grant({
        chatId: 'chat-1',
        provider: 'codex',
        workspacePath: '/repo/'
      })
    ).toMatchObject({
      enabled: true,
      grant: {
        chatId: 'chat-1',
        provider: 'codex',
        workspacePath: '/repo',
        grantedAt: '2026-07-06T09:00:00.000Z'
      }
    })
    expect(
      store.isGranted({
        chatId: 'chat-1',
        provider: 'codex',
        workspacePath: '/repo'
      })
    ).toBe(true)
    expect(
      store.isGranted({
        chatId: 'chat-1',
        provider: 'claude',
        workspacePath: '/repo'
      })
    ).toBe(false)

    store.revoke({ chatId: 'chat-1', provider: 'codex', workspacePath: '/repo' })
    expect(
      store.isGranted({
        chatId: 'chat-1',
        provider: 'codex',
        workspacePath: '/repo'
      })
    ).toBe(false)
  })

  it('keeps ensemble participant grants scoped to that participant', () => {
    const store = new TrustedSessionGrantStore(() => '2026-07-06T09:00:00.000Z')
    store.grant({
      chatId: 'ensemble-1',
      provider: 'codex',
      workspacePath: '/repo',
      ensembleParticipantId: 'writer'
    })

    expect(
      store.isGranted({
        chatId: 'ensemble-1',
        provider: 'codex',
        workspacePath: '/repo',
        ensembleParticipantId: 'writer',
        ensembleLaneId: 'lane-a'
      })
    ).toBe(true)
    expect(
      store.isGranted({
        chatId: 'ensemble-1',
        provider: 'codex',
        workspacePath: '/repo',
        ensembleParticipantId: 'reviewer'
      })
    ).toBe(false)
  })

  it('can bind a grant to a specific runtime profile and lane', () => {
    const store = new TrustedSessionGrantStore(() => '2026-07-06T09:00:00.000Z')
    store.grant({
      chatId: 'ensemble-1',
      provider: 'claude',
      workspacePath: '/repo',
      ensembleParticipantId: 'worker',
      ensembleLaneId: 'lane-1',
      runtimeProfileId: 'profile-1'
    })

    expect(
      store.isGranted({
        chatId: 'ensemble-1',
        provider: 'claude',
        workspacePath: '/repo',
        ensembleParticipantId: 'worker',
        ensembleLaneId: 'lane-1',
        runtimeProfileId: 'profile-1'
      })
    ).toBe(true)
    expect(
      store.isGranted({
        chatId: 'ensemble-1',
        provider: 'claude',
        workspacePath: '/repo',
        ensembleParticipantId: 'worker',
        ensembleLaneId: 'lane-2',
        runtimeProfileId: 'profile-1'
      })
    ).toBe(false)
    expect(
      store.isGranted({
        chatId: 'ensemble-1',
        provider: 'claude',
        workspacePath: '/repo',
        ensembleParticipantId: 'worker',
        ensembleLaneId: 'lane-1',
        runtimeProfileId: 'profile-2'
      })
    ).toBe(false)
  })
})
