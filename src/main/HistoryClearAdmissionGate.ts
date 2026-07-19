/**
 * Synchronous admission fence spanning the full prepare/commit history-clear
 * transaction. Global clears block every scope; workspace clears block only
 * the matching opaque workspace id. Counts make nested/re-entrant clear flows
 * safe and require the matching number of finishes before reopening admission.
 */
export interface HistoryClearDispatchAuthority {
  appChatId: string
  workspaceId: string | null
  persistenceRevision: number
}

declare const historyClearDispatchReservationBrand: unique symbol
declare const historyClearRunPersistenceAuthorityBrand: unique symbol

/** Opaque one-dispatch lease. Callers cannot construct a valid reservation. */
export type HistoryClearDispatchReservation = Readonly<{
  appChatId: string
  workspaceId: string | null
  persistenceRevision: number
  [historyClearDispatchReservationBrand]: true
}>

/** Opaque authority for output produced after adapter admission. Unlike the
 * dispatch reservation, it deliberately ignores ordinary chat saves and is
 * invalidated only by destructive chat/workspace/global lifecycle generations. */
export type HistoryClearRunPersistenceAuthority = Readonly<{
  appChatId: string
  workspaceId: string | null
  [historyClearRunPersistenceAuthorityBrand]: true
}>

interface ReservedDispatch {
  authority: HistoryClearDispatchAuthority
  globalGeneration: number
  workspaceGeneration: number
  chatGeneration: number
}

export class HistoryClearAdmissionGate {
  private globalHolds = 0
  private readonly workspaceHolds = new Map<string, number>()
  private readonly chatHolds = new Map<string, number>()
  private globalGeneration = 0
  private readonly workspaceGenerations = new Map<string, number>()
  private readonly chatGenerations = new Map<string, number>()
  private readonly dispatchReservations = new Map<
    HistoryClearDispatchReservation,
    ReservedDispatch
  >()
  private readonly runPersistenceAuthorities = new Map<
    HistoryClearRunPersistenceAuthority,
    ReservedDispatch
  >()

  begin(workspaceId?: string): void {
    const scope = normalizeWorkspaceId(workspaceId)
    if (!scope) {
      this.globalGeneration += 1
      this.globalHolds += 1
      return
    }
    this.workspaceGenerations.set(scope, (this.workspaceGenerations.get(scope) ?? 0) + 1)
    this.workspaceHolds.set(scope, (this.workspaceHolds.get(scope) ?? 0) + 1)
  }

  end(workspaceId?: string): void {
    const scope = normalizeWorkspaceId(workspaceId)
    if (!scope) {
      if (this.globalHolds > 0) this.globalHolds -= 1
      return
    }
    const holds = this.workspaceHolds.get(scope) ?? 0
    if (holds <= 1) this.workspaceHolds.delete(scope)
    else this.workspaceHolds.set(scope, holds - 1)
  }

  isBlocked(workspaceId?: string | null): boolean {
    if (this.globalHolds > 0) return true
    const scope = normalizeWorkspaceId(workspaceId ?? undefined)
    return Boolean(scope && (this.workspaceHolds.get(scope) ?? 0) > 0)
  }

  isGlobalBlocked(): boolean {
    return this.globalHolds > 0
  }

  beginChat(chatId: string): void {
    const scope = normalizeWorkspaceId(chatId)
    if (!scope) return
    this.chatGenerations.set(scope, (this.chatGenerations.get(scope) ?? 0) + 1)
    this.chatHolds.set(scope, (this.chatHolds.get(scope) ?? 0) + 1)
  }

  endChat(chatId: string): void {
    const scope = normalizeWorkspaceId(chatId)
    if (!scope) return
    const holds = this.chatHolds.get(scope) ?? 0
    if (holds <= 1) this.chatHolds.delete(scope)
    else this.chatHolds.set(scope, holds - 1)
  }

  isChatBlocked(chatId?: string | null): boolean {
    if (this.globalHolds > 0) return true
    const scope = normalizeWorkspaceId(chatId ?? undefined)
    return Boolean(scope && (this.chatHolds.get(scope) ?? 0) > 0)
  }

  isAuthorityBlocked(input: {
    chatId?: string | null
    chatWorkspaceId?: string | null
    pathWorkspaceId?: string | null
  }): boolean {
    if (this.isGlobalBlocked() || this.isChatBlocked(input.chatId)) return true
    return this.isBlocked(
      resolveHistoryClearWorkspaceAuthority(input.chatWorkspaceId, input.pathWorkspaceId)
    )
  }

  /**
   * Freeze the exact durable chat authority before preflight can await user or
   * provider work. A matching clear that begins later invalidates this lease
   * even if the hold ends before preflight returns.
   */
  reserveDispatch(input: HistoryClearDispatchAuthority): HistoryClearDispatchReservation {
    const authority = normalizeDispatchAuthority(input)
    if (
      this.isAuthorityBlocked({
        chatId: authority.appChatId,
        chatWorkspaceId: authority.workspaceId,
        pathWorkspaceId: authority.workspaceId
      })
    ) {
      throw new Error('History clear is already in progress for this dispatch authority.')
    }
    const reservation = Object.freeze({
      ...authority
    }) as HistoryClearDispatchReservation
    this.dispatchReservations.set(reservation, {
      authority,
      globalGeneration: this.globalGeneration,
      workspaceGeneration: authority.workspaceId
        ? (this.workspaceGenerations.get(authority.workspaceId) ?? 0)
        : 0,
      chatGeneration: this.chatGenerations.get(authority.appChatId) ?? 0
    })
    return reservation
  }

  /** Last synchronous check before an adapter can observe the payload. */
  authorizeDispatch(
    reservation: HistoryClearDispatchReservation,
    current: HistoryClearDispatchAuthority
  ): boolean {
    const reserved = this.dispatchReservations.get(reservation)
    if (!reserved) return false
    let authority: HistoryClearDispatchAuthority
    try {
      authority = normalizeDispatchAuthority(current)
    } catch {
      return false
    }
    return (
      authority.appChatId === reserved.authority.appChatId &&
      authority.workspaceId === reserved.authority.workspaceId &&
      this.globalGeneration === reserved.globalGeneration &&
      (authority.workspaceId
        ? (this.workspaceGenerations.get(authority.workspaceId) ?? 0) ===
          reserved.workspaceGeneration
        : reserved.workspaceGeneration === 0) &&
      (this.chatGenerations.get(authority.appChatId) ?? 0) === reserved.chatGeneration &&
      !this.isAuthorityBlocked({
        chatId: authority.appChatId,
        chatWorkspaceId: authority.workspaceId,
        pathWorkspaceId: authority.workspaceId
      })
    )
  }

  releaseDispatch(reservation: HistoryClearDispatchReservation): void {
    this.dispatchReservations.delete(reservation)
  }

  /** Promote a successfully revalidated preflight reservation into an output
   * authority. Normal transcript saves may advance persistenceRevision after
   * this point; only a destructive lifecycle generation invalidates output. */
  promoteDispatch(
    reservation: HistoryClearDispatchReservation,
    current: HistoryClearDispatchAuthority
  ): HistoryClearRunPersistenceAuthority | null {
    if (!this.authorizeDispatch(reservation, current)) return null
    const reserved = this.dispatchReservations.get(reservation)
    if (!reserved) return null
    const authority = Object.freeze({
      appChatId: reserved.authority.appChatId,
      workspaceId: reserved.authority.workspaceId
    }) as HistoryClearRunPersistenceAuthority
    this.runPersistenceAuthorities.set(authority, reserved)
    return authority
  }

  authorizeRunPersistence(
    authority: HistoryClearRunPersistenceAuthority,
    current: Pick<HistoryClearDispatchAuthority, 'appChatId' | 'workspaceId'>
  ): boolean {
    const reserved = this.runPersistenceAuthorities.get(authority)
    if (!reserved) return false
    const appChatId = normalizeWorkspaceId(current?.appChatId)
    const workspaceId = normalizeWorkspaceId(current?.workspaceId ?? undefined)
    if (!appChatId) return false
    return (
      appChatId === reserved.authority.appChatId &&
      workspaceId === reserved.authority.workspaceId &&
      this.globalGeneration === reserved.globalGeneration &&
      (workspaceId
        ? (this.workspaceGenerations.get(workspaceId) ?? 0) === reserved.workspaceGeneration
        : reserved.workspaceGeneration === 0) &&
      (this.chatGenerations.get(appChatId) ?? 0) === reserved.chatGeneration &&
      !this.isAuthorityBlocked({
        chatId: appChatId,
        chatWorkspaceId: workspaceId,
        pathWorkspaceId: workspaceId
      })
    )
  }

  releaseRunPersistence(authority: HistoryClearRunPersistenceAuthority): void {
    this.runPersistenceAuthorities.delete(authority)
  }
}

/** Canonical chat ownership wins when an effective worktree path is unregistered. */
export function resolveHistoryClearWorkspaceAuthority(
  chatWorkspaceId?: string | null,
  pathWorkspaceId?: string | null
): string | null {
  return (
    normalizeWorkspaceId(chatWorkspaceId ?? undefined) ||
    normalizeWorkspaceId(pathWorkspaceId ?? undefined)
  )
}

function normalizeWorkspaceId(workspaceId?: string): string | null {
  if (typeof workspaceId !== 'string') return null
  const normalized = workspaceId.trim()
  return normalized || null
}

function normalizeDispatchAuthority(
  input: HistoryClearDispatchAuthority
): HistoryClearDispatchAuthority {
  const appChatId = normalizeWorkspaceId(input?.appChatId)
  if (!appChatId) throw new Error('Dispatch reservation requires an exact chat id.')
  if (!Number.isSafeInteger(input.persistenceRevision) || input.persistenceRevision < 0) {
    throw new Error('Dispatch reservation requires a non-negative persistence revision.')
  }
  return {
    appChatId,
    workspaceId: normalizeWorkspaceId(input.workspaceId ?? undefined),
    persistenceRevision: input.persistenceRevision
  }
}
