import type { ProviderId, TranscriptMediaRef } from './store/types'
export type McpToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export type McpToolExecutionResult = {
  text: string
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content?: McpToolContentBlock[]
  // S1b-3: main-built AV media refs that ride a TRUSTED channel — the host injects
  // these straight into run state, bypassing the image-only provider sanitizer (which
  // hard-drops kind!=='image'). Un-forgeable because only main-side executor code can
  // construct a McpToolExecutionResult; provider stdout can never reach this field.
  trustedMediaRefs?: TranscriptMediaRef[]
  // Per-image-block presentation hints for the SANITIZED image lane: `labels[i]` becomes
  // the caption of the ref built from the i-th image block (content order), `groupKind`
  // groups a contiguous run (e.g. `video_frames` → an NLE filmstrip). Mirror of the field
  // on McpBridgeRuntime's McpToolExecutionResult — the two must stay in sync.
  mediaRefHints?: { groupKind?: string; labels?: string[] }
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
