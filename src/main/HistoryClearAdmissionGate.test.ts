import { describe, expect, it } from 'vitest'
import {
  HistoryClearAdmissionGate,
  resolveHistoryClearWorkspaceAuthority
} from './HistoryClearAdmissionGate'

describe('HistoryClearAdmissionGate', () => {
  it('blocks every workspace for the full nested global transaction', () => {
    const gate = new HistoryClearAdmissionGate()
    gate.begin()
    gate.begin()
    expect(gate.isGlobalBlocked()).toBe(true)
    expect(gate.isBlocked('workspace-a')).toBe(true)
    expect(gate.isBlocked('workspace-b')).toBe(true)
    gate.end()
    expect(gate.isBlocked('workspace-a')).toBe(true)
    gate.end()
    expect(gate.isBlocked('workspace-a')).toBe(false)
  })

  it('blocks only the matching workspace and preserves unrelated admission', () => {
    const gate = new HistoryClearAdmissionGate()
    gate.begin('workspace-a')
    expect(gate.isGlobalBlocked()).toBe(false)
    expect(gate.isBlocked('workspace-a')).toBe(true)
    expect(gate.isBlocked('workspace-b')).toBe(false)
    expect(gate.isBlocked()).toBe(false)
    gate.end('workspace-a')
    expect(gate.isBlocked('workspace-a')).toBe(false)
  })

  it('blocks a deleting or truncating chat without fencing sibling chats', () => {
    const gate = new HistoryClearAdmissionGate()
    gate.beginChat('chat-a')
    expect(gate.isChatBlocked('chat-a')).toBe(true)
    expect(gate.isChatBlocked('chat-b')).toBe(false)
    gate.endChat('chat-a')
    expect(gate.isChatBlocked('chat-a')).toBe(false)
  })

  it('uses canonical chat ownership when a worktree path has no registered workspace id', () => {
    const gate = new HistoryClearAdmissionGate()
    gate.begin('workspace-a')

    expect(resolveHistoryClearWorkspaceAuthority('workspace-a', null)).toBe('workspace-a')
    expect(
      gate.isAuthorityBlocked({
        chatId: 'chat-a',
        chatWorkspaceId: 'workspace-a',
        pathWorkspaceId: null
      })
    ).toBe(true)
    expect(
      gate.isAuthorityBlocked({
        chatId: 'chat-b',
        chatWorkspaceId: 'workspace-b',
        pathWorkspaceId: null
      })
    ).toBe(false)
  })

  it('authorizes the exact chat incarnation across ordinary persistence revisions', () => {
    const gate = new HistoryClearAdmissionGate()
    const authority = {
      appChatId: 'chat-a',
      workspaceId: 'workspace-a',
      persistenceRevision: 7
    }
    const reservation = gate.reserveDispatch(authority)

    expect(gate.authorizeDispatch(reservation, authority)).toBe(true)
    expect(gate.authorizeDispatch(reservation, { ...authority, persistenceRevision: 8 })).toBe(true)
    expect(gate.authorizeDispatch(reservation, { ...authority, workspaceId: 'workspace-b' })).toBe(
      false
    )
    expect(gate.authorizeDispatch(reservation, { ...authority, appChatId: 'chat-b' })).toBe(false)
    gate.releaseDispatch(reservation)
    expect(gate.authorizeDispatch(reservation, authority)).toBe(false)
  })

  it('invalidates a pending dispatch when its chat or workspace clear begins', () => {
    const authority = {
      appChatId: 'chat-a',
      workspaceId: 'workspace-a',
      persistenceRevision: 7
    }
    const chatGate = new HistoryClearAdmissionGate()
    const chatReservation = chatGate.reserveDispatch(authority)
    chatGate.beginChat('chat-a')
    chatGate.endChat('chat-a')
    expect(chatGate.authorizeDispatch(chatReservation, authority)).toBe(false)

    const workspaceGate = new HistoryClearAdmissionGate()
    const workspaceReservation = workspaceGate.reserveDispatch(authority)
    workspaceGate.begin('workspace-a')
    workspaceGate.end('workspace-a')
    expect(workspaceGate.authorizeDispatch(workspaceReservation, authority)).toBe(false)
  })

  it('does not invalidate a pending dispatch for an unrelated scoped clear', () => {
    const gate = new HistoryClearAdmissionGate()
    const authority = {
      appChatId: 'chat-a',
      workspaceId: 'workspace-a',
      persistenceRevision: 7
    }
    const reservation = gate.reserveDispatch(authority)
    gate.beginChat('chat-b')
    gate.begin('workspace-b')
    expect(gate.authorizeDispatch(reservation, authority)).toBe(true)
  })

  it('keeps concurrent same-chat preflights valid across sibling transcript saves', () => {
    const gate = new HistoryClearAdmissionGate()
    const first = {
      appChatId: 'ensemble-chat',
      workspaceId: 'workspace-a',
      persistenceRevision: 20
    }
    const second = { ...first, persistenceRevision: 21 }
    const firstReservation = gate.reserveDispatch(first)
    const secondReservation = gate.reserveDispatch(second)

    expect(
      gate.authorizeDispatch(firstReservation, { ...first, persistenceRevision: 22 })
    ).toBe(true)
    expect(
      gate.authorizeDispatch(secondReservation, { ...second, persistenceRevision: 23 })
    ).toBe(true)
  })

  it('invalidates every pending dispatch when a global clear begins', () => {
    const gate = new HistoryClearAdmissionGate()
    const authority = {
      appChatId: 'chat-a',
      workspaceId: null,
      persistenceRevision: 0
    }
    const reservation = gate.reserveDispatch(authority)
    gate.begin()
    gate.end()
    expect(gate.authorizeDispatch(reservation, authority)).toBe(false)
  })

  it('keeps promoted run output authorized across ordinary transcript revisions', () => {
    const gate = new HistoryClearAdmissionGate()
    const dispatchAuthority = {
      appChatId: 'chat-a',
      workspaceId: 'workspace-a',
      persistenceRevision: 7
    }
    const reservation = gate.reserveDispatch(dispatchAuthority)
    const outputAuthority = gate.promoteDispatch(reservation, dispatchAuthority)
    expect(outputAuthority).not.toBeNull()

    // Transcript/title/ensemble saves can advance the chat persistence revision
    // between chunks. Output authority is an incarnation fence, not a save CAS.
    expect(
      gate.authorizeRunPersistence(outputAuthority!, {
        appChatId: 'chat-a',
        workspaceId: 'workspace-a'
      })
    ).toBe(true)
    expect(
      gate.authorizeRunPersistence(outputAuthority!, {
        appChatId: 'chat-a',
        workspaceId: 'workspace-a'
      })
    ).toBe(true)
  })

  it('invalidates promoted output for matching destructive lifecycle only', () => {
    const authority = {
      appChatId: 'chat-a',
      workspaceId: 'workspace-a',
      persistenceRevision: 7
    }
    const gate = new HistoryClearAdmissionGate()
    const reservation = gate.reserveDispatch(authority)
    const outputAuthority = gate.promoteDispatch(reservation, authority)!

    gate.beginChat('chat-b')
    gate.endChat('chat-b')
    expect(
      gate.authorizeRunPersistence(outputAuthority, {
        appChatId: 'chat-a',
        workspaceId: 'workspace-a'
      })
    ).toBe(true)

    gate.beginChat('chat-a')
    gate.endChat('chat-a')
    expect(
      gate.authorizeRunPersistence(outputAuthority, {
        appChatId: 'chat-a',
        workspaceId: 'workspace-a'
      })
    ).toBe(false)
    gate.releaseRunPersistence(outputAuthority)
  })

  it('authorizes concurrent participant lanes in one chat until a destructive clear', () => {
    const gate = new HistoryClearAdmissionGate()
    const firstDispatch = {
      appChatId: 'ensemble-chat',
      workspaceId: 'workspace-a',
      persistenceRevision: 11
    }
    const secondDispatch = { ...firstDispatch, persistenceRevision: 12 }
    const firstReservation = gate.reserveDispatch(firstDispatch)
    const secondReservation = gate.reserveDispatch(secondDispatch)
    const firstOutput = gate.promoteDispatch(firstReservation, firstDispatch)!
    const secondOutput = gate.promoteDispatch(secondReservation, secondDispatch)!
    const current = { appChatId: 'ensemble-chat', workspaceId: 'workspace-a' }

    expect(gate.authorizeRunPersistence(firstOutput, current)).toBe(true)
    expect(gate.authorizeRunPersistence(secondOutput, current)).toBe(true)
    gate.beginChat('ensemble-chat')
    gate.endChat('ensemble-chat')
    expect(gate.authorizeRunPersistence(firstOutput, current)).toBe(false)
    expect(gate.authorizeRunPersistence(secondOutput, current)).toBe(false)
  })

  it('refuses reservations during a hold and malformed durable revisions', () => {
    const gate = new HistoryClearAdmissionGate()
    gate.beginChat('chat-a')
    expect(() =>
      gate.reserveDispatch({ appChatId: 'chat-a', workspaceId: null, persistenceRevision: 1 })
    ).toThrow('already in progress')
    expect(() =>
      new HistoryClearAdmissionGate().reserveDispatch({
        appChatId: 'chat-a',
        workspaceId: null,
        persistenceRevision: Number.NaN
      })
    ).toThrow('persistence revision')
  })
})
