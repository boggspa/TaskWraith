// Fan-out worktree candidates — adjudication IPC.
//
// The renderer's candidates surface (compare N isolated fan-out lanes, pick
// a winner) lists candidates, previews one candidate's patch, and resolves
// candidates by promoting (apply onto the base workspace working tree,
// uncommitted) or discarding. All destructive git targets come from the
// MAIN-OWNED candidate records — the renderer only names a chat + candidate
// id, never a path — and the service re-verifies worktree linkage before
// removing anything.

import { ipcMain } from 'electron'
import type {
  CandidateResolution,
  FanoutCandidateService
} from '../services/FanoutCandidateService'
import type { ChatRecord, DiffFileSummary, FanoutWorktreeCandidate } from '../store/types'

export interface FanoutCandidateWorkspaceDiff {
  type: string
  text?: string
  statusText?: string
  diffText?: string
  summaries?: DiffFileSummary[]
}

export interface FanoutCandidateHandlerDeps {
  /** Null only while durable workspace-lock startup recovery is unavailable. */
  service: FanoutCandidateService | null
  unavailableReason?: () => string | null | undefined
  getChat: (chatId: string) => ChatRecord | null
  /** DiffService.getWorkspaceDiff — pointed at the candidate's worktree so
   * the renderer gets the exact per-file summary shape Diff Studio uses. */
  getWorkspaceDiff: (workspace: string) => Promise<FanoutCandidateWorkspaceDiff>
}

export function registerFanoutCandidateHandlers(deps: FanoutCandidateHandlerDeps): void {
  const requireService = (): FanoutCandidateService => {
    if (deps.service) return deps.service
    const reason = deps.unavailableReason?.()?.trim()
    throw new Error(
      reason
        ? `Fan-out candidates are unavailable: ${reason}`
        : 'Fan-out candidates are unavailable while workspace-lock recovery is required.'
    )
  }
  const requireChatId = (chatId: unknown): string => {
    const id = typeof chatId === 'string' ? chatId.trim() : ''
    if (!id || !deps.getChat(id)) {
      throw new Error('Fan-out candidates need a saved chat.')
    }
    return id
  }
  const requireCandidateId = (candidateId: unknown): string => {
    const id = typeof candidateId === 'string' ? candidateId.trim() : ''
    if (!id) throw new Error('Fan-out candidate id is required.')
    return id
  }

  ipcMain.handle(
    'fanout-candidates:list',
    async (_event, chatId: unknown): Promise<FanoutWorktreeCandidate[]> =>
      requireService().list(requireChatId(chatId))
  )

  ipcMain.handle(
    'fanout-candidates:diff',
    async (
      _event,
      chatId: unknown,
      candidateId: unknown
    ): Promise<FanoutCandidateWorkspaceDiff> => {
      const chat = requireChatId(chatId)
      const id = requireCandidateId(candidateId)
      const candidates = await requireService().list(chat)
      const candidate = candidates.find((entry) => entry.candidateId === id)
      if (!candidate) throw new Error('Unknown fan-out candidate for this chat.')
      if (candidate.status === 'promoted' || candidate.status === 'discarded') {
        throw new Error('This candidate was already resolved; its worktree is gone.')
      }
      // The candidate record is main-owned: the renderer names ids, never
      // paths, so this worktree path cannot be renderer-forged.
      return deps.getWorkspaceDiff(candidate.worktreePath)
    }
  )

  ipcMain.handle(
    'fanout-candidates:promote',
    async (_event, chatId: unknown, candidateId: unknown): Promise<CandidateResolution> =>
      requireService().promote(requireChatId(chatId), requireCandidateId(candidateId))
  )

  ipcMain.handle(
    'fanout-candidates:discard',
    async (_event, chatId: unknown, candidateId: unknown): Promise<CandidateResolution> =>
      requireService().discard(requireChatId(chatId), requireCandidateId(candidateId))
  )
}
