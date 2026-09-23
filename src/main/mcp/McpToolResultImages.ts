import type { McpToolContentBlock } from './McpBridgeRuntime'

export type McpToolResultImage = Extract<McpToolContentBlock, { type: 'image' }>

/** Keep tool-produced pixels separate from text summaries and durable run memory. */
export function mcpToolResultImages(content: unknown): McpToolResultImage[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is McpToolResultImage =>
      block !== null &&
      typeof block === 'object' &&
      block.type === 'image' &&
      typeof block.mimeType === 'string' &&
      typeof block.data === 'string'
  )
}
