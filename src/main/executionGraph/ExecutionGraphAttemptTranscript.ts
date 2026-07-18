import { createHash } from 'node:crypto'
import type {
  ChatMessage,
  ChatRecord,
  ChatRun,
  ChatWorkflowMode,
  RunPermissionPostureSnapshot,
  ToolActivity,
  TranscriptMediaRef
} from '../store/types'
import { stableExecutionGraphStringify } from './ExecutionGraphCompiler'
import type {
  ExecutionGraphAttemptResultBinding,
  ExecutionGraphAttemptTerminalReceipt
} from './ExecutionGraphAttemptResult'

export interface ExecutionGraphTranscriptPart {
  readonly id: string
  readonly kind: 'text' | 'tools'
  readonly content: string
  readonly mediaRefs?: readonly TranscriptMediaRef[]
  readonly activities: readonly ToolActivity[]
}

export interface SeedExecutionGraphAttemptTranscriptInput {
  readonly chat: ChatRecord
  readonly binding: ExecutionGraphAttemptResultBinding
  readonly prompt: string
  readonly startedAt: string
  readonly requestedModel?: string
  readonly approvalMode?: string
  readonly workflowMode?: ChatWorkflowMode
  readonly permissionPosture?: RunPermissionPostureSnapshot
  readonly runtimeProfileId?: string
}

export interface SeededExecutionGraphAttemptTranscript {
  readonly chat: ChatRecord
  readonly promptMessageId: string
  readonly assistantMessageId: string
  readonly toolMessageId: string
}

export interface ProjectExecutionGraphAttemptTranscriptInput {
  readonly chat: ChatRecord
  readonly binding: ExecutionGraphAttemptResultBinding
  readonly promptMessageId: string
  readonly startedAt: string
  readonly parts: readonly ExecutionGraphTranscriptPart[]
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly timestamp: string
  readonly actualModel?: string
  readonly providerSessionId?: string | null
  readonly stats?: Record<string, unknown>
  readonly errorMessage?: string
}

function bindingMetadata(binding: ExecutionGraphAttemptResultBinding): Record<string, unknown> {
  return {
    schemaVersion: 1,
    executionId: binding.executionId,
    activationId: binding.activationId,
    attemptId: binding.attemptId,
    providerRunRef: binding.providerRunRef,
    workspaceId: binding.workspaceId,
    rootChatId: binding.rootChatId,
    provider: binding.provider
  }
}

function exactChatForBinding(
  chat: ChatRecord,
  binding: ExecutionGraphAttemptResultBinding
): void {
  if (
    chat.appChatId !== binding.rootChatId ||
    chat.workspaceId !== binding.workspaceId ||
    chat.archived ||
    chat.parentChatId ||
    chat.chatKind === 'ensemble'
  ) {
    throw new Error('Execution graph transcript chat no longer matches its durable root.')
  }
}

function promptMessageId(runId: string): string {
  return `execution-graph-prompt-${runId}`
}

function assistantMessageId(runId: string): string {
  return `execution-graph-assistant-${runId}`
}

function toolMessageId(runId: string): string {
  return `execution-graph-tools-${runId}`
}

export function seedExecutionGraphAttemptTranscript(
  input: SeedExecutionGraphAttemptTranscriptInput
): SeededExecutionGraphAttemptTranscript {
  exactChatForBinding(input.chat, input.binding)
  const runId = input.binding.providerRunRef
  const existingRuns = (input.chat.runs ?? []).filter((run) => run.runId === runId)
  if (existingRuns.length > 1) {
    throw new Error('Execution graph transcript run identity is duplicated in the root chat.')
  }
  const existing = existingRuns[0]
  if (existing?.providerMetadata?.executionGraphAttempt) {
    if (
      stableExecutionGraphStringify(existing.providerMetadata.executionGraphAttempt) !==
      stableExecutionGraphStringify(bindingMetadata(input.binding))
    ) {
      throw new Error('Execution graph transcript run identity was previously rebound.')
    }
  }
  const promptId = promptMessageId(runId)
  const prompt: ChatMessage = {
    id: promptId,
    role: 'user',
    content: input.prompt,
    timestamp: input.startedAt,
    runId,
    metadata: {
      kind: 'executionGraphAttempt',
      ...bindingMetadata(input.binding)
    }
  }
  const messages = input.chat.messages.some((message) => message.id === promptId)
    ? input.chat.messages
    : [...input.chat.messages, prompt]
  const run: ChatRun = {
    ...(existing || {
      runId,
      provider: input.binding.provider,
      startedAt: input.startedAt,
      promptMessageId: promptId
    }),
    provider: input.binding.provider,
    status: 'running',
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
    ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
    ...(input.workflowMode ? { workflowMode: input.workflowMode } : {}),
    ...(input.permissionPosture ? { permissionPosture: input.permissionPosture } : {}),
    ...(input.runtimeProfileId ? { runtimeProfileId: input.runtimeProfileId } : {}),
    providerMetadata: {
      ...(existing?.providerMetadata || {}),
      executionGraphAttempt: bindingMetadata(input.binding)
    }
  }
  const runs = [...(input.chat.runs ?? [])]
  const runIndex = runs.findIndex((candidate) => candidate.runId === runId)
  if (runIndex >= 0) runs[runIndex] = run
  else runs.push(run)
  return {
    chat: { ...input.chat, messages, runs, updatedAt: Date.now() },
    promptMessageId: promptId,
    assistantMessageId: assistantMessageId(runId),
    toolMessageId: toolMessageId(runId)
  }
}

export function projectExecutionGraphAttemptTranscript(
  input: ProjectExecutionGraphAttemptTranscriptInput
): { readonly chat: ChatRecord; readonly evidenceRefs: readonly string[] } {
  exactChatForBinding(input.chat, input.binding)
  const runId = input.binding.providerRunRef
  const runs = [...(input.chat.runs ?? [])]
  const runIndex = runs.findIndex((run) => run.runId === runId)
  if (runIndex < 0 || runs.some((run, index) => index !== runIndex && run.runId === runId)) {
    throw new Error('Execution graph transcript cannot project without one exact seeded run.')
  }
  const existingRun = runs[runIndex]
  if (
    stableExecutionGraphStringify(existingRun.providerMetadata?.executionGraphAttempt) !==
    stableExecutionGraphStringify(bindingMetadata(input.binding))
  ) {
    throw new Error('Execution graph transcript projection lost its exact run binding.')
  }

  let messages = [...input.chat.messages]
  let insertAfter = messages.findIndex((message) => message.id === input.promptMessageId)
  if (insertAfter < 0) {
    throw new Error('Execution graph transcript prompt is missing from the root chat.')
  }
  const evidenceRefs: string[] = []
  for (const part of input.parts) {
    if (
      part.kind === 'text' &&
      part.content.trim().length === 0 &&
      (!part.mediaRefs || part.mediaRefs.length === 0)
    ) {
      continue
    }
    const message: ChatMessage =
      part.kind === 'text'
        ? {
            id: part.id,
            role: 'assistant',
            content: part.content,
            timestamp: input.timestamp,
            runId,
            metadata: {
              kind: 'executionGraphAttemptOutput',
              ...bindingMetadata(input.binding),
              ...(part.mediaRefs?.length ? { mediaRefs: [...part.mediaRefs] } : {})
            }
          }
        : {
            id: part.id,
            role: 'tool',
            content: '',
            timestamp: input.timestamp,
            runId,
            toolActivities: part.activities.map((activity) => ({ ...activity })),
            metadata: {
              kind: 'executionGraphAttemptOutput',
              ...bindingMetadata(input.binding)
            }
          }
    const existingIndex = messages.findIndex((candidate) => candidate.id === part.id)
    if (existingIndex >= 0) {
      messages[existingIndex] = { ...messages[existingIndex], ...message }
      insertAfter = existingIndex
    } else {
      messages = [
        ...messages.slice(0, insertAfter + 1),
        message,
        ...messages.slice(insertAfter + 1)
      ]
      insertAfter += 1
    }
    evidenceRefs.push(part.id)
  }

  if (input.status !== 'running' && input.errorMessage) {
    const id = `execution-graph-error-${runId}`
    const errorMessage: ChatMessage = {
      id,
      role: 'error',
      content: input.errorMessage,
      timestamp: input.timestamp,
      runId,
      metadata: {
        kind: 'executionGraphAttemptOutput',
        ...bindingMetadata(input.binding)
      }
    }
    const existingIndex = messages.findIndex((message) => message.id === id)
    if (existingIndex >= 0) messages[existingIndex] = errorMessage
    else messages = [...messages, errorMessage]
    evidenceRefs.push(id)
  }

  const terminal = input.status !== 'running'
  runs[runIndex] = {
    ...existingRun,
    actualModel: input.actualModel || existingRun.actualModel,
    providerThreadId: input.providerSessionId || existingRun.providerThreadId,
    stats: input.stats || existingRun.stats,
    status: input.status,
    endedAt: terminal ? input.timestamp : existingRun.endedAt,
    exitCode:
      input.status === 'failed'
        ? 1
        : input.status === 'cancelled'
          ? 130
          : terminal
            ? 0
            : existingRun.exitCode,
    cancelled: input.status === 'cancelled' ? true : existingRun.cancelled
  }
  return {
    chat: { ...input.chat, messages, runs, updatedAt: Date.now() },
    evidenceRefs: Object.freeze([...new Set(evidenceRefs)])
  }
}

export function attachExecutionGraphAttemptReceipt(
  chat: ChatRecord,
  receipt: ExecutionGraphAttemptTerminalReceipt
): ChatRecord {
  exactChatForBinding(chat, receipt.binding)
  const runs = [...(chat.runs ?? [])]
  const runIndex = runs.findIndex((run) => run.runId === receipt.binding.providerRunRef)
  if (runIndex < 0) throw new Error('Execution graph result receipt has no exact ChatRun owner.')
  const run = runs[runIndex]
  if (
    stableExecutionGraphStringify(run.providerMetadata?.executionGraphAttempt) !==
    stableExecutionGraphStringify(bindingMetadata(receipt.binding)) ||
    run.status !== receipt.status ||
    !run.endedAt
  ) {
    throw new Error('Execution graph result receipt does not match the terminal ChatRun.')
  }
  runs[runIndex] = {
    ...run,
    providerMetadata: {
      ...(run.providerMetadata || {}),
      executionGraphResultReceipt: receipt
    }
  }
  return { ...chat, runs, updatedAt: Date.now() }
}

export function verifyExecutionGraphAttemptReceiptOnChat(
  chat: ChatRecord,
  receipt: ExecutionGraphAttemptTerminalReceipt
): boolean {
  try {
    exactChatForBinding(chat, receipt.binding)
    const runs = (chat.runs ?? []).filter(
      (run) => run.runId === receipt.binding.providerRunRef
    )
    if (runs.length !== 1) return false
    const run = runs[0]
    if (
      run.status !== receipt.status ||
      !run.endedAt ||
      stableExecutionGraphStringify(run.providerMetadata?.executionGraphAttempt) !==
        stableExecutionGraphStringify(bindingMetadata(receipt.binding)) ||
      stableExecutionGraphStringify(run.providerMetadata?.executionGraphResultReceipt) !==
        stableExecutionGraphStringify(receipt)
    ) {
      return false
    }
    const evidence = executionGraphAttemptEvidenceContent(
      chat,
      receipt.binding,
      receipt.evidenceRefs
    )
    if (!evidence) return false
    if (
      createHash('sha256').update(evidence.assistantContent).digest('hex') !==
      receipt.contentDigest
    ) {
      return false
    }
    return receipt.status !== 'completed' || evidence.assistantContent.trim().length > 0
  } catch {
    return false
  }
}

export function executionGraphAttemptEvidenceContent(
  chat: ChatRecord,
  binding: ExecutionGraphAttemptResultBinding,
  evidenceRefs: readonly string[]
): { readonly assistantContent: string } | undefined {
  exactChatForBinding(chat, binding)
  const expectedBinding = stableExecutionGraphStringify(bindingMetadata(binding))
  const seen = new Set<string>()
  const assistantParts: string[] = []
  for (const messageId of evidenceRefs) {
    if (seen.has(messageId)) return undefined
    seen.add(messageId)
    const matches = chat.messages.filter((message) => message.id === messageId)
    if (matches.length !== 1) return undefined
    const message = matches[0]
    if (
      message.runId !== binding.providerRunRef ||
      (message.role !== 'assistant' && message.role !== 'tool' && message.role !== 'error') ||
      message.metadata?.kind !== 'executionGraphAttemptOutput' ||
      stableExecutionGraphStringify({
        schemaVersion: message.metadata.schemaVersion,
        executionId: message.metadata.executionId,
        activationId: message.metadata.activationId,
        attemptId: message.metadata.attemptId,
        providerRunRef: message.metadata.providerRunRef,
        workspaceId: message.metadata.workspaceId,
        rootChatId: message.metadata.rootChatId,
        provider: message.metadata.provider
      }) !== expectedBinding
    ) {
      return undefined
    }
    if (message.role === 'assistant') assistantParts.push(message.content)
  }
  return { assistantContent: assistantParts.join('') }
}
