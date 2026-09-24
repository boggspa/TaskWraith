import type { ChatRecord } from './types'

/**
 * Stage 1a — runtime fence against page-shaped transcript saves.
 *
 * `ChatRecord.messages` means the COMPLETE canonical transcript. Both save
 * paths (`saveChatAdmitted` and `saveChatThroughHost`) historically rejected
 * only `summaryOnly` records, so an unmarked bounded page reaching `saveChat`
 * would silently overwrite the durable prefix. Type branding cannot enforce
 * this across the IPC structured-clone boundary, so the check is a structural
 * comparison of message-id sequences against the durable record.
 *
 * A payload is rejected only when it PROVABLY begins mid-transcript and then
 * tracks the durable order: the first incoming id anchors at index > 0 of the
 * durable array and every overlapping id matches contiguously. That shape is
 * a windowed page (pure tail/middle slice, or a page with newer appends) and
 * persisting it would drop messages the payload never carried.
 *
 * Deliberately admitted (each is a real, in-tree flow):
 * - create (no durable record), full id match, prefix+append, in-place
 *   update, and mid-record delete-by-ID (the remainder is head-anchored or
 *   non-contiguous);
 * - rewind / tail truncation (head-anchored: keeps `messages[0]`);
 * - `/clear` full truncation (empty incoming array);
 * - full replacements whose first id does not occur in the durable array;
 * - any save carrying an authored ID-op mutation (`authoredTranscript`), which
 *   `mutate-chat-transcript` attaches after reconstructing the FULL array from
 *   the canonical record — including a deliberate contiguous prefix delete,
 *   which is id-sequence-identical to a tail page and only distinguishable by
 *   that provenance.
 *
 * Known limit: with duplicate message ids the anchor is the first occurrence,
 * so a duplicated boundary id can mask a page. Transcript ids are unique on
 * every path that pages today; the transport already tracks
 * `transcriptIdsUnique` for the same reason.
 */
export function assertAuthoritativeChatForSave(
  incoming: ChatRecord,
  previous: ChatRecord | null | undefined,
  options?: { authoredTranscript?: unknown }
): void {
  if (!previous) return
  if (options?.authoredTranscript) return
  const previousMessages = Array.isArray(previous.messages) ? previous.messages : []
  const nextMessages = Array.isArray(incoming.messages) ? incoming.messages : []
  if (previousMessages.length === 0 || nextMessages.length === 0) return

  const firstId = nextMessages[0]?.id
  if (typeof firstId !== 'string' || firstId.length === 0) return
  const anchor = previousMessages.findIndex((message) => message?.id === firstId)
  if (anchor <= 0) return

  const overlap = Math.min(nextMessages.length, previousMessages.length - anchor)
  for (let offset = 0; offset < overlap; offset += 1) {
    if (nextMessages[offset]?.id !== previousMessages[anchor + offset]?.id) return
  }
  throw new Error(
    `Refusing to persist a windowed transcript page for chat ${incoming.appChatId}: ` +
      `the payload begins at durable message index ${anchor} of ` +
      `${previousMessages.length} and tracks the durable order from there, so saving ` +
      'it would silently drop the unloaded prefix. Hydrate the full transcript ' +
      '(or mutate by ID) before saving.'
  )
}
