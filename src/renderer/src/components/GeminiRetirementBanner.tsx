import React, { useState } from 'react'

/**
 * One-time dismissable notice that the Gemini provider has been retired (Google
 * ended the Gemini-CLI consumer sign-in on 2026-06-18). Rendered on the welcome /
 * new-chat screen (below the usage dashboard, above the greeting) and at the top
 * of the first-launch onboarding sheet.
 *
 * Dismissal persists in localStorage (renderer-only, matching the existing
 * first-launch flag) so the banner appears at most once per profile — and stays
 * dismissed across BOTH surfaces once closed in either.
 */
const DISMISS_KEY = 'taskwraith.geminiRetirementBannerDismissed.v1'

export function GeminiRetirementBanner(): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  if (dismissed) return null

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Storage may be unavailable (private mode etc.); the banner simply won't
      // persist its dismissal, which is acceptable for a cosmetic notice.
    }
    setDismissed(true)
  }

  return (
    <div className="gemini-retirement-banner" role="status">
      <span className="gemini-retirement-banner-icon" aria-hidden>
        ⓘ
      </span>
      <p className="gemini-retirement-banner-text">
        <strong>Gemini has been retired.</strong> Google ended the Gemini CLI sign-in, so Gemini is
        no longer available for new runs. Your existing Gemini chats, transcripts, and usage history
        are preserved.
      </p>
      <button
        type="button"
        className="gemini-retirement-banner-dismiss"
        onClick={dismiss}
        aria-label="Dismiss Gemini retirement notice"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
