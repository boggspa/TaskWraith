/**
 * Shows why a solo/Ensemble mode switch did not happen.
 *
 * Rendered once for the focused thread rather than inside the Ensemble popover,
 * because the popover is only one of the places the switch is triggered from —
 * the multiview pane composer, the roster chip strip's collapse-to-solo path
 * and the Ensemble-off modal all reach the same handlers, and all three were
 * equally silent. One surface keyed on the chat covers every entry point.
 *
 * The notice is transient renderer state, so nothing here waits on a write.
 */
import { useSyncExternalStore } from 'react'
import type { ChatModeChangeNotices } from '../lib/chatModeChangeNotices'

// Stable identities: `useSyncExternalStore` re-subscribes whenever `subscribe`
// changes and loops whenever a snapshot is a fresh value, so the no-store
// fallbacks cannot be inline literals.
const noSubscription = (): (() => void) => () => {}
const zeroSnapshot = (): number => 0

export function ChatModeChangeNotice({
  chatIds,
  notices
}: {
  /** Every thread on screen: the focused chat plus any multiview pane chats. */
  chatIds: readonly (string | null | undefined)[]
  /** Null only before App's lazy store init has run; there is nothing to say then. */
  notices: ChatModeChangeNotices | null
}): React.JSX.Element | null {
  // The third argument is not optional in practice: ~251 renderer suites render
  // through `renderToStaticMarkup`, and `useSyncExternalStore` throws without a
  // server snapshot there. The store's version counter serves as both.
  useSyncExternalStore(
    notices?.subscribe ?? noSubscription,
    notices?.snapshot ?? zeroSnapshot,
    notices?.snapshot ?? zeroSnapshot
  )
  const notice = notices?.newestFor(chatIds) ?? null
  if (!notice) return null
  return (
    <div
      role="alert"
      className="chat-mode-change-notice"
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        // Above the 10xxx panel layers so an alert cannot be filed behind the
        // surface it is explaining, and below the 12xxx composer popovers so an
        // open picker still wins.
        zIndex: 11000,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 8,
        maxWidth: 420,
        border: '1px solid var(--panel-border, #3a3a3a)',
        // `--surface` is the theme's opaque fill. `--bg-secondary` reads like
        // the right token and is a ~6%-white OVERLAY at runtime, so a notice
        // painted with it renders as text over whatever it lands on.
        background: 'var(--surface, #1c1c20)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.35)',
        color: 'var(--text-primary, #eee)',
        fontSize: 13,
        lineHeight: 1.45
      }}
    >
      <span style={{ flex: 1 }}>{notice.message}</span>
      <button
        type="button"
        className="chat-mode-change-notice-dismiss"
        onClick={() => notices?.clear(notice.chatId)}
        aria-label="Dismiss chat mode message"
        style={{ flex: '0 0 auto' }}
      >
        Dismiss
      </button>
    </div>
  )
}
