import type { ComposerInput } from './services/ComposerService'
import type { ChatRecord, ScheduledTask } from './store/types'
import type { WorkspacePopoutAuthority } from './WorkspacePopoutAuthority'
import { assertScheduledRunAuthority } from './ScheduledRunAuthority'

export interface ComposerRunAuthorityInput {
  input: ComposerInput
  chat: ChatRecord
  isMainRenderer: boolean
  owner?: WorkspacePopoutAuthority
  scheduledTask?: ScheduledTask | null
  canonicalizePath: (value: string) => string
}

export interface ComposerRunAuthorityResult {
  input: ComposerInput
  mainOwnedAttachments?: boolean
}

const COMPOSER_AUTHORITY_ERROR = 'Renderer compose authority is stale or unavailable.'

function assertFrozenChatOwner(
  chat: ChatRecord,
  owner: WorkspacePopoutAuthority | undefined,
  canonicalizePath: (value: string) => string
): void {
  if (owner?.kind !== 'chat' || owner.chatId !== chat.appChatId) {
    throw new Error(COMPOSER_AUTHORITY_ERROR)
  }
  const ownerWorkspacePath = owner.workspacePath?.trim()
  const chatWorkspacePath = chat.workspacePath?.trim()
  if (chat.scope === 'global') {
    if (ownerWorkspacePath) throw new Error(COMPOSER_AUTHORITY_ERROR)
    return
  }
  if (!ownerWorkspacePath || !chatWorkspacePath) throw new Error(COMPOSER_AUTHORITY_ERROR)
  try {
    if (canonicalizePath(ownerWorkspacePath) !== canonicalizePath(chatWorkspacePath)) {
      throw new Error(COMPOSER_AUTHORITY_ERROR)
    }
  } catch {
    throw new Error(COMPOSER_AUTHORITY_ERROR)
  }
}

function scheduledComposerInput(chat: ChatRecord, task: ScheduledTask): ComposerInput {
  return {
    chatId: chat.appChatId,
    appRunId: task.runId,
    scheduledTaskId: task.id,
    provider: task.provider,
    scope: 'workspace',
    workspace: chat.workspacePath,
    userInput: task.prompt,
    selectedModelType: task.selectedModelType,
    customModel: task.customModel,
    approvalMode: task.approvalMode,
    permissionPresetId: task.permissionPresetId,
    workflowMode: task.workflowMode,
    sessionTrust: task.sessionTrust,
    imageAttachments: task.imageAttachments.map((attachment) => ({
      id: attachment.id,
      path: attachment.path,
      name: attachment.name
    })),
    externalPathGrants: task.externalPathGrants,
    geminiWorktree: task.geminiWorktree,
    codexReasoningEffort: task.codexReasoningEffort,
    codexServiceTier: task.codexServiceTier,
    claudeReasoningEffort: task.claudeReasoningEffort,
    claudeFastMode: task.claudeFastMode,
    kimiFastMode: task.kimiFastMode,
    kimiReasoningEffort: task.kimiReasoningEffort,
    kimiThinkingEnabled: task.kimiThinkingEnabled,
    grokReasoningEffort: task.grokReasoningEffort,
    cursorReasoningEffort: task.cursorReasoningEffort,
    cursorFastMode: task.cursorFastMode,
    runtimeProfileId: task.runtimeProfileId,
    geminiAuthProfileId: task.geminiAuthProfileId,
    handoffSourceRunId: task.handoffSourceRunId,
    // Preserve no renderer-authored scheduled controls beyond the occurrence's
    // display-neutral routing identity. Prompt, posture, provider, model,
    // workspace, session source, grants, and attachments all come from main.
    chatSnapshot: chat
  }
}

/**
 * Replace renderer-authored compose authority with the durable chat (and, for
 * unattended work, the exact current ScheduledTask occurrence).
 */
export function resolveComposerRunAuthority(
  input: ComposerRunAuthorityInput
): ComposerRunAuthorityResult {
  const { chat } = input
  if (chat.appChatId !== input.input.chatId) throw new Error(COMPOSER_AUTHORITY_ERROR)
  if (!input.isMainRenderer) {
    assertFrozenChatOwner(chat, input.owner, input.canonicalizePath)
    if (input.input.scheduledTaskId) {
      throw new Error('Scheduled occurrences may only be dispatched by the main renderer.')
    }
  }

  if (input.input.scheduledTaskId) {
    const task = assertScheduledRunAuthority({
      task: input.scheduledTask,
      chat,
      expectedKind: 'single',
      appRunId: input.input.appRunId,
      canonicalizePath: input.canonicalizePath
    })
    return {
      input: scheduledComposerInput(chat, task),
      mainOwnedAttachments: true
    }
  }

  const authoritativeInput: ComposerInput = {
    ...input.input,
    chatId: chat.appChatId,
    chatSnapshot: chat,
    scope: chat.scope === 'global' ? 'global' : 'workspace'
  }
  if (chat.scope === 'global') {
    delete authoritativeInput.workspace
  } else {
    authoritativeInput.workspace = chat.workspacePath
  }
  return { input: authoritativeInput }
}
