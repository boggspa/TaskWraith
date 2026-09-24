import { AppStore } from '../store'
import type { ChatRecord, ProviderId } from '../store/types'
import type { WirePromptCaptureInput } from '../run/WirePromptEvents'
import {
  continuityCheckpointSourceId,
  continuityDeliveryKey,
  latestSuccessfulContinuityCompaction
} from '../../shared/continuityDelivery'
import { readSeatCheckpoint } from '../../shared/threadContinuity'
import {
  createThreadContinuityToolExecutors,
  type ContinuityCaller,
  type ThreadContinuityContext
} from '../mcp/ThreadContinuityToolExecutors'
export { isThreadContinuityToolName } from '../mcp/ThreadContinuityToolExecutors'
export { buildDelegatedContinuityPrompts, withDelegatedCheckpoint } from './ContinuityPrompt'

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
  const tools = createThreadContinuityToolExecutors({
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
  return {
    ...tools,
    recordSelectedPrompt(inputPrompt: WirePromptCaptureInput): void {
      if (
        !['codex', 'claude', 'kimi'].includes(inputPrompt.provider) ||
        !inputPrompt.appChatId ||
        !inputPrompt.appRunId ||
        input.isIsolatedRun(inputPrompt.appRunId)
      )
        return
      const chat = AppStore.getChat(inputPrompt.appChatId)
      if (!chat || chat.archived) return
      const run = chat.runs.find((candidate) => candidate.runId === inputPrompt.appRunId)
      if (!run || (run.provider || chat.provider) !== inputPrompt.provider) return
      const seatId = run.ensembleParticipantId || '__solo__'
      if (chat.chatKind === 'ensemble' && !run.ensembleParticipantId) return
      const checkpoint = readSeatCheckpoint(chat, seatId)
      if (!checkpoint) return
      const sourceId = continuityCheckpointSourceId(checkpoint)
      const containsCheckpoint =
        inputPrompt.text.includes('<taskwraith_private_continuity_checkpoint>') &&
        inputPrompt.text.includes(`Source: ${sourceId}`) &&
        (checkpoint.cleared
          ? inputPrompt.text.includes('Status: cleared.')
          : inputPrompt.text.includes(JSON.stringify(checkpoint.text)))
      const boundary = latestSuccessfulContinuityCompaction({
        messages: chat.messages,
        seatId,
        provider: inputPrompt.provider
      })
      const delivery = containsCheckpoint
        ? {
            key: continuityDeliveryKey({
              checkpoint,
              seatId,
              provider: inputPrompt.provider,
              providerSessionId: inputPrompt.providerSessionId,
              boundary
            }),
            seatId,
            revision: checkpoint.revision,
            sourceId,
            provider: inputPrompt.provider,
            providerSessionId: inputPrompt.providerSessionId || null,
            boundaryId: boundary?.messageId,
            observedAt: new Date().toISOString()
          }
        : undefined
      const prior = run.continuityCheckpointDelivery
      if (
        !delivery &&
        inputPrompt.promptKind === 'steer' &&
        prior?.sourceId === sourceId &&
        prior.boundaryId === boundary?.messageId &&
        inputPrompt.providerSessionId &&
        prior.providerSessionId === inputPrompt.providerSessionId
      )
        return
      if (
        (!delivery && !prior) ||
        (delivery && prior?.key === delivery.key && prior.sourceId === sourceId)
      )
        return
      input.saveCheckpoint({
        ...chat,
        runs: chat.runs.map((candidate) =>
          candidate.runId === inputPrompt.appRunId
            ? { ...candidate, continuityCheckpointDelivery: delivery }
            : candidate
        )
      })
    }
  }
}
