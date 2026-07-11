import type { ChatRecord } from '../../../main/store/types'

/**
 * Chat-identity-keyed memo for expensive per-pane "walks" (O(messages) /
 * O(runs) derivations) in the multiview grid.
 *
 * During a stream, App re-renders ~60fps and `renderMultiviewPaneCell` runs
 * for every NON-focused pane each frame. A non-streaming pane's `ChatRecord`
 * keeps a STABLE object identity across those frames (flushCoalescedChats
 * only replaces the chat object whose content actually changed, and
 * applyAssistantDelta slice-preserves every non-streaming message), so keying
 * on the chat object lets each walk run once per identity instead of every
 * frame. The streaming pane's chat identity changes each frame → recompute,
 * which is correct.
 *
 * `depsEqual` guards secondary inputs (attachments, run state, provider rates)
 * so a discrete change to them still recomputes even when the chat object is
 * unchanged.
 *
 * The backing store is a WeakMap, so entries for superseded chat objects are
 * collected automatically — no unbounded growth.
 */
export function createChatWalkCache<TResult, TDeps>(
  compute: (chat: ChatRecord, deps: TDeps) => TResult,
  depsEqual: (a: TDeps, b: TDeps) => boolean
): (chat: ChatRecord, deps: TDeps) => TResult {
  const cache = new WeakMap<ChatRecord, { deps: TDeps; value: TResult }>()
  return (chat, deps) => {
    const hit = cache.get(chat)
    if (hit && depsEqual(hit.deps, deps)) return hit.value
    const value = compute(chat, deps)
    cache.set(chat, { deps, value })
    return value
  }
}

/** No secondary deps — the walk is a pure function of the chat object. */
export const NO_WALK_DEPS: Readonly<Record<string, never>> = Object.freeze({})
export const noWalkDepsEqual = (): boolean => true
