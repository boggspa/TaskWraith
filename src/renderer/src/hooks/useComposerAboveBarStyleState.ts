import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  applyComposerAboveBarStyleState,
  clearComposerAboveBarStyleState
} from '../lib/ComposerAboveBarStyleState'

// The Settings composer preview is server-rendered in tests, where
// `useLayoutEffect` warns and effects never run anyway. Behaviour in the app is
// unchanged: with a document present this is exactly `useLayoutEffect`.
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect

/**
 * Keep the composer above-bar flag classes in step with the rows actually in the
 * DOM. See `ComposerAboveBarStyleState` for why these flags exist (they replace
 * a `:has()` selector family that invalidated the whole document on every
 * unrelated transcript mutation).
 *
 * Attach the returned ref to the `.composer-above-bar-stack` element. The live
 * composer and the Settings preview both use this hook so the two cannot drift.
 */
export function useComposerAboveBarStyleState<T extends HTMLElement>() {
  const stackRef = useRef<T | null>(null)

  // Runs after every commit of the owning component. React has already written
  // the stack's children by then, and layout effects run before paint, so the
  // flags are never a frame behind the rows they describe.
  useIsomorphicLayoutEffect(() => {
    if (stackRef.current) applyComposerAboveBarStyleState(stackRef.current)
  })

  useIsomorphicLayoutEffect(() => {
    const node = stackRef.current
    if (!node || typeof MutationObserver === 'undefined') return
    // Above-rows are rendered by child components that can mount/unmount from
    // their own state without re-rendering the composer, so the commit-time pass
    // above is not sufficient on its own. MutationObserver callbacks are
    // delivered as microtasks at the end of the task that mutated the DOM —
    // still before paint, so no frame shows stale flags.
    const observer = new MutationObserver(() => {
      if (stackRef.current) applyComposerAboveBarStyleState(stackRef.current)
    })
    observer.observe(node, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      // `.composer-area` outlives the stack, so its flag must be cleared here.
      // Layout-effect cleanup runs before React detaches the node, so `closest`
      // still resolves.
      clearComposerAboveBarStyleState(node)
    }
  }, [])

  return stackRef
}
