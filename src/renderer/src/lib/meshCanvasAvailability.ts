/**
 * Human-facing handling for the small window where the renderer still shows a
 * draft chat after main has reaped or otherwise lost its canonical authority.
 * Mesh scenes must remain main-owned and chat-scoped, so never relax the main
 * check to accommodate this renderer-only state.
 */

export const MESH_CANVAS_NEEDS_SAVED_CHAT =
  'Mesh Canvas needs an active saved chat. Start or select a chat, then open Mesh Canvas.'

export function meshCanvasIssueMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (
    /mesh canvas (chat authority is unavailable|requires an active canonical chat|requires an active chat authority)/i.test(
      message
    )
  ) {
    return MESH_CANVAS_NEEDS_SAVED_CHAT
  }
  return message || fallback
}
