import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deriveComposerSuggestion,
  type ComposerSuggestion,
  type ComposerSuggestionLane,
  type ComposerSuggestionModel
} from '../lib/composerSuggestion'
import { recordComposerSuggestionEvent } from '../lib/composerSuggestionLog'

/**
 * Owns the lifecycle of the composer's ghost prefill: which suggestion
 * is live, whether the user has waved it away, and the acceptance log
 * entries that let the trigger table be judged later.
 *
 * The single invariant worth stating loudly: **an unaccepted suggestion
 * never becomes draft text.** `ghostText` is painted by the overlay and
 * exists nowhere else — it is not fed through the textarea's `onChange`,
 * so it never reaches `setChatPromptDraft` and never lands in draft
 * persistence. Only `accept()` returns a string, and only the caller's
 * explicit Tab handler calls it. Without that separation a suggestion
 * the user ignored would be sitting there the next time they opened the
 * chat, indistinguishable from something they typed themselves.
 */

export interface UseComposerSuggestionArgs {
  /** Scopes dismissals, so waving one away in chat A doesn't mute chat B. */
  chatId: string | null | undefined
  draft: string
  busy: boolean
  hasPriorTurn: boolean
  consideredModel: ComposerSuggestionModel | null
  selectedModelKey: string | null
  failedLanes?: readonly ComposerSuggestionLane[]
  uncommittedFileCount: number
  branch: string | null
  /** Escape hatch for users who don't want prefills at all. */
  enabled?: boolean
}

export interface ComposerSuggestionController {
  /** Text for the overlay to paint, or null when there's nothing to offer. */
  ghostText: string | null
  /**
   * Commit the live suggestion. Returns the string the caller should
   * write into the draft, or null when nothing is live — so a stray Tab
   * can never blank or corrupt the composer.
   */
  accept: () => string | null
  /** Wave the live suggestion away; it won't be re-offered in this chat. */
  dismiss: () => void
}

const NO_LANES: readonly ComposerSuggestionLane[] = []
const NO_DISMISSALS: readonly string[] = []

export function useComposerSuggestion(
  args: UseComposerSuggestionArgs
): ComposerSuggestionController {
  const {
    chatId,
    draft,
    busy,
    hasPriorTurn,
    consideredModel,
    selectedModelKey,
    failedLanes = NO_LANES,
    uncommittedFileCount,
    branch,
    enabled = true
  } = args

  const scope = chatId || '__unscoped__'

  /**
   * Dismissals are keyed by chat so waving one away in one conversation
   * doesn't mute another, and held in state rather than a ref so the
   * derive below re-runs when one lands. Deliberately not persisted: a
   * dismissal is a "not now", not a preference, and should not outlive
   * the session.
   */
  const [dismissedByChat, setDismissedByChat] = useState<Record<string, readonly string[]>>({})

  const dismissedForScope = useMemo(
    () => new Set(dismissedByChat[scope] ?? NO_DISMISSALS),
    [dismissedByChat, scope]
  )

  const suggestion = useMemo<ComposerSuggestion | null>(() => {
    if (!enabled) return null
    return deriveComposerSuggestion({
      draft,
      busy,
      hasPriorTurn,
      consideredModel,
      selectedModelKey,
      failedLanes,
      uncommittedFileCount,
      branch,
      dismissedIds: dismissedForScope
    })
  }, [
    enabled,
    draft,
    busy,
    hasPriorTurn,
    consideredModel,
    selectedModelKey,
    failedLanes,
    uncommittedFileCount,
    branch,
    dismissedForScope
  ])

  /**
   * Log `shown` once per suggestion identity, not once per render. The
   * composer re-renders constantly; a shown-count inflated by render
   * churn would make every accept rate look like noise and defeat the
   * point of keeping the log at all.
   */
  const lastShownIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!suggestion) {
      lastShownIdRef.current = null
      return
    }
    if (lastShownIdRef.current === suggestion.id) return
    lastShownIdRef.current = suggestion.id
    recordComposerSuggestionEvent(suggestion.trigger, 'shown')
  }, [suggestion])

  const retire = useCallback(
    (id: string) => {
      setDismissedByChat((prev) => {
        const existing = prev[scope] ?? NO_DISMISSALS
        if (existing.includes(id)) return prev
        return { ...prev, [scope]: [...existing, id] }
      })
    },
    [scope]
  )

  const accept = useCallback((): string | null => {
    if (!suggestion) return null
    recordComposerSuggestionEvent(suggestion.trigger, 'accepted')
    // Retire it as well as logging: once accepted it must not re-offer
    // itself the moment the user clears the composer to start over.
    retire(suggestion.id)
    return suggestion.text
  }, [retire, suggestion])

  const dismiss = useCallback((): void => {
    if (!suggestion) return
    recordComposerSuggestionEvent(suggestion.trigger, 'dismissed')
    retire(suggestion.id)
  }, [retire, suggestion])

  return { ghostText: suggestion?.text ?? null, accept, dismiss }
}
