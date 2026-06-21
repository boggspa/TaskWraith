import type { ProviderId, TranscriptMediaRef } from './store/types'
export type McpToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export type McpToolExecutionResult = {
  text: string
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: McpToolContentBlock[]
}

export type AttachedWindowStreamingSnapshot = {
  fps: number
  bufferSeconds: number
  frameCount: number
  startedAt: string
}
export type AttachedWindowSnapshot = {
  handleID: string
  windowMeta: {
    windowID: number
    title: string
    bundleID: string
    applicationName: string
    pid: number
  }
  attachedAt: string
  streaming?: AttachedWindowStreamingSnapshot
}

export interface BackgroundSubThreadTranscriptState {
  runId: string
  chatId: string
  parentChatId: string
  provider: ProviderId
  parentProvider: ProviderId
  prompt: string
  returnResultToParent: boolean
  promptMessageId: string
  assistantMessageId: string
  startedAt: string
  content: string
  mediaRefs?: TranscriptMediaRef[]
  actualModel?: string
  providerSessionId?: string
  stats?: unknown
  status: 'running' | 'success' | 'failed'
  errorMessage?: string
  flushTimer?: ReturnType<typeof setTimeout>
  flushedOnce?: boolean
  finalized?: boolean
}

export type WorkspacePopoutKind = 'file-editor' | 'diff-studio' | 'chat'
