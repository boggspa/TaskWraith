import { AppStore } from '../store'
import type { ChatRecord, ProviderId } from '../store/types'
import {
  createThreadContinuityToolExecutors,
  type ContinuityCaller,
  type ThreadContinuityContext
} from '../mcp/ThreadContinuityToolExecutors'
export { isThreadContinuityToolName } from '../mcp/ThreadContinuityToolExecutors'

/** Resolve ownership from a recorded run. Model-supplied identities never enter here. */
export function resolveContinuityCaller(
  chat: ChatRecord | null,
  context: ThreadContinuityContext,
  provider: string,
  isolated: boolean
): ContinuityCaller | null {
  if (
    isolated ||
    !chat ||
    chat.archived ||
    chat.appChatId !== context.appChatId ||
    !context.appRunId
  )
    return null
  const run = chat.runs.find((candidate) => candidate.runId === context.appRunId)
  if (!run || run.endedAt || (run.provider || chat.provider) !== provider) return null
  const seatId = run.ensembleParticipantId || '__solo__'
  const participant = run.ensembleParticipantId
    ? chat.ensemble?.participants.find((candidate) => candidate.id === run.ensembleParticipantId)
    : undefined
  if (run.ensembleParticipantId && !participant) return null
  if (chat.chatKind === 'ensemble' && !participant) return null
  return {
    chatId: chat.appChatId,
    runId: run.runId,
    seatId,
    provider: provider as ProviderId,
    providerSessionId:
      run.providerThreadId || participant?.linkedProviderSessionId || chat.linkedProviderSessionId,
    generationId:
      participant?.seatGeneration?.id || (!participant ? chat.seatGeneration?.id : undefined)
  }
}

export function createThreadContinuityHostTools(input: {
  isIsolatedRun: (runId: string | undefined) => boolean
  saveCheckpoint: (chat: ChatRecord) => void
}) {
  return createThreadContinuityToolExecutors({
    resolveCaller: (context, provider) =>
      resolveContinuityCaller(
        context.appChatId ? AppStore.getChat(context.appChatId) : null,
        context,
        provider,
        input.isIsolatedRun(context.appRunId)
      ),
    getChat: (id) => AppStore.getChat(id),
    readDetail: async (ref) => (await AppStore.getToolActivityDetails([ref]))[0]?.activity || null,
    saveCheckpoint: input.saveCheckpoint,
    now: () => new Date().toISOString()
  })
}
