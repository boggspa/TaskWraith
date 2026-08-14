import type {
  RendererChatUpdateClientCounters,
  RendererDiagnosticClientSample
} from '../../../shared/rendererDiagnostics'

interface PerformanceMemorySnapshot {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

export interface RendererDiagnosticPerformance {
  memory?: PerformanceMemorySnapshot
}

export interface BuildRendererDiagnosticClientSampleInput {
  performance: RendererDiagnosticPerformance
  activeChatId?: string | null
  activeChatMessageCount?: number
  chatUpdates: RendererChatUpdateClientCounters
}

function finiteBytes(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/** Reads Chromium's non-standard V8 heap meter without traversing chat state. */
export function buildRendererDiagnosticClientSample(
  input: BuildRendererDiagnosticClientSampleInput
): RendererDiagnosticClientSample {
  const memory = input.performance.memory
  const v8HeapUsedBytes = finiteBytes(memory?.usedJSHeapSize)
  const v8HeapTotalBytes = finiteBytes(memory?.totalJSHeapSize)
  const v8HeapLimitBytes = finiteBytes(memory?.jsHeapSizeLimit)
  return {
    ...(typeof input.activeChatId === 'string' && input.activeChatId
      ? { activeChatId: input.activeChatId }
      : {}),
    activeChatMessageCount: Math.max(0, Math.floor(input.activeChatMessageCount || 0)),
    ...(v8HeapUsedBytes !== undefined ? { v8HeapUsedBytes } : {}),
    ...(v8HeapTotalBytes !== undefined ? { v8HeapTotalBytes } : {}),
    ...(v8HeapLimitBytes !== undefined ? { v8HeapLimitBytes } : {}),
    chatUpdates: { ...input.chatUpdates }
  }
}
