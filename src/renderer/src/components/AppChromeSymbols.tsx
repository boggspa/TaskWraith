import taskwraithGhostMonolineSvg from '../assets/taskwraith-ghost-monoline.svg?raw'

export function SidebarCornerIcon({
  direction,
  isOpen
}: {
  direction: 'left' | 'right'
  isOpen: boolean
}) {
  const symbolColor = 'var(--text-primary)'
  const panelFill = 'transparent'
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke={symbolColor}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {direction === 'left' ? (
          <>
            <rect x="2.4" y="2.2" width="8.8" height="11.4" rx="1.2" fill={panelFill} />
            <path d="M5 4.5h4.4M5 8h4.4M5 11.5h4.4" />
            {isOpen ? (
              <>
                <path d="M10.4 7.7 8.9 9.2M10.4 7.7 11.9 9.2M10.4 7.7h-3.3" />
              </>
            ) : (
              <>
                <path d="M7.3 7.7 8.8 9.2M7.3 7.7 5.8 9.2M7.3 7.7h3.3" />
              </>
            )}
          </>
        ) : (
          <>
            <rect x="4.9" y="2.2" width="8.8" height="11.4" rx="1.2" fill={panelFill} />
            <path d="M11 4.5H6.6M11 8H6.6M11 11.5H6.6" />
            {isOpen ? (
              <>
                <path d="M5.6 7.7 7.1 9.2M5.6 7.7 4.1 9.2M5.6 7.7h3.3" />
              </>
            ) : (
              <>
                <path d="M8.7 7.7 7.2 9.2M8.7 7.7 10.2 9.2M8.7 7.7h-3.3" />
              </>
            )}
          </>
        )}
      </svg>
    </span>
  )
}

export function FileMenuSelectionIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 2.4h5.4l2.8 2.8v8.4H3z" />
        <path d="M8.4 2.4v3h2.8" />
        <path d="M5 7.3h6" />
        <path d="M5 9.6h3.8" />
        <path d="M5 11.9h2.8" />
        <path d="M10.4 10.2l2.3 2.3" />
        <path d="M12.7 10.2l-2.3 2.3" />
      </svg>
    </span>
  )
}

export function AppleTerminalIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.2" y="3" width="11.6" height="10" rx="1.4" />
        <path d="M4.4 6.2 6.3 8 4.4 9.8" />
        <path d="M7.4 10h3.5" />
      </svg>
    </span>
  )
}

export function ChatMediaIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.4" y="3" width="11.2" height="10" rx="1.5" />
        <path d="M4.4 10.9 6.6 8.7l1.7 1.5 1.7-2.2 1.7 2.9" />
        <circle cx="5.7" cy="5.8" r="0.85" />
      </svg>
    </span>
  )
}

export function GoalSymbolIcon() {
  return (
    <span className="composer-control-icon">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="5.2" />
        <circle cx="8" cy="8" r="2.4" />
        <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" />
      </svg>
    </span>
  )
}

export function PlanSymbolIcon() {
  return (
    <span className="composer-control-icon">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.6 4.2h6.6" />
        <path d="M5.6 8h6.6" />
        <path d="M5.6 11.8h6.6" />
        <path d="m2.5 4.1.8.8 1.4-1.6" />
        <circle cx="3.6" cy="8" r="0.85" />
        <circle cx="3.6" cy="11.8" r="0.85" />
      </svg>
    </span>
  )
}

export function ChatPopoutIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.4" y="3.1" width="8.3" height="9.8" rx="1.4" />
        <path d="M4.4 5.8h4.2" />
        <path d="M4.4 8h3.4" />
        <path d="M4.4 10.2h2.6" />
        <path d="M9.6 2.7h3.7v3.7" />
        <path d="M8.9 7.1 13 3" />
      </svg>
    </span>
  )
}

export function SplitChatIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.3" y="2.8" width="11.4" height="10.4" rx="1.45" />
        <path d="M8 3v10" />
        <path d="M4.4 5.6h2.1M4.4 8h2.1M4.4 10.4h1.5" />
        <path d="M9.7 5.6h1.9M9.7 8h1.5M9.7 10.4h1.9" />
      </svg>
    </span>
  )
}

export function MultiviewSymbolIcon() {
  return (
    <span className="composer-control-icon">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.9" />
        <path d="M8 2.6v10.8M2.6 8h10.8" />
      </svg>
    </span>
  )
}

export function BackToParentIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7.1 4.1 3.2 8l3.9 3.9" />
        <path d="M3.6 8h6.5a2.9 2.9 0 0 1 2.9 2.9v1" />
      </svg>
    </span>
  )
}

export function DockDrawerIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.4" y="3" width="11.2" height="10" rx="1.4" />
        <path d="M10.2 3v10" />
        <path d="M11.7 5.5h.7M11.7 8h.7M11.7 10.5h.7" />
        <path d="M5.2 8h3" />
        <path d="M6.9 6.2 5.1 8l1.8 1.8" />
      </svg>
    </span>
  )
}

export function EndSideChatIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.4 4.1V3.2h5.2v.9" />
        <path d="M4 5h8" />
        <path d="M5.1 6.3 5.6 13h4.8l.5-6.7" />
        <path d="M7.1 7.7v3.8M8.9 7.7v3.8" />
      </svg>
    </span>
  )
}

export function PinnedMessagesIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.2 2.4h5.6l-.8 4 2.1 2.1v1.3H8.7L8 13.6l-.7-3.8H3.9V8.5L6 6.4z" />
      </svg>
    </span>
  )
}

export function GhostCompanionIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3.2 13.2V6.5a4.8 4.8 0 0 1 9.6 0v6.7l-1.7-1.1-1.6 1.1-1.5-1.1-1.5 1.1-1.6-1.1-1.7 1.1z" />
        <path d="M5.8 6.4h.1M10.1 6.4h.1" />
        <path d="M6.5 9.2c.8.5 2.2.5 3 0" />
      </svg>
    </span>
  )
}

/**
 * Standalone brand-ghost glyph for empty states — same silhouette as
 * GhostCompanionIcon but without the corner-symbol wrapper, so it can be
 * sized via the `size` prop and tinted by the parent's `color`
 * (currentColor stroke). Used by the friendlier sidebar / settings
 * empty states.
 */
export function MascotGhost({ size = 32 }: { size?: number }) {
  return (
    <svg
      className="mascot-ghost"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3.2 13.2V6.5a4.8 4.8 0 0 1 9.6 0v6.7l-1.7-1.1-1.6 1.1-1.5-1.1-1.5 1.1-1.6-1.1-1.7 1.1z" />
      <path d="M5.8 6.4h.1M10.1 6.4h.1" />
      <path d="M6.5 9.2c.8.5 2.2.5 3 0" />
    </svg>
  )
}

// A running thread's indicator: the monoline "ghost guy" (the same mark as the
// masthead and the transcript "Working…" bubble) pulsing slowly. It is the sole
// running cue on a sidebar row — the accent rim is reserved for selection — so a
// live run is never confused with the open thread. Decorative; the row's own
// aria-label / aria-busy carries the running state to assistive tech.
export function SidebarRunningGhost() {
  return (
    <span
      className="sidebar-chat-running"
      title="Running"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: taskwraithGhostMonolineSvg }}
    />
  )
}

export function SkyWeatherIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.2 5.1a3.2 3.2 0 1 1 5.6 2.1" />
        <path d="M8.4 1.7v1.2M8.4 10.6v1.2M3.2 6.7H2M14.8 6.7h-1.2M4.8 3.1l-.8-.8M12.8 3.1l.8-.8" />
        <path d="M4.3 12.5h6.8a2.2 2.2 0 0 0 0-4.4 3.2 3.2 0 0 0-6.1-.8 2.6 2.6 0 0 0-.7 5.2z" />
      </svg>
    </span>
  )
}

export function InfoCircleIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="5.45" />
        <path d="M8 7.4v3.6" />
        <circle cx="8" cy="5.1" r="0.45" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

export function QuestionCircleIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="5.45" />
        <path d="M6.35 6.4a1.75 1.75 0 1 1 2.95 1.3c-.75.55-1.2 1-1.2 1.75" />
        <circle cx="8.1" cy="11.15" r="0.45" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

export function ExclamationShieldIcon() {
  return (
    <span className="chat-corner-symbol">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2.25 12.35 4v3.25c0 2.8-1.65 5.1-4.35 6.5-2.7-1.4-4.35-3.7-4.35-6.5V4z" />
        <path d="M8 5.35v3.7" />
        <circle cx="8" cy="11.15" r="0.45" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

export function CopyResponseIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4.9" y="2.1" width="7.5" height="11.1" rx="1.2" />
        <path d="M5.8 4h5.7" />
        <path d="M5.8 5.7h5.7" />
        <path d="M5.8 7.5h4.2" />
        <rect x="2.7" y="4.2" width="7.2" height="9.7" rx="0.8" />
        <path d="M4 2.8h2.3a0.8 0.8 0 0 1 0.8 0.8V4.2" />
        <path d="M6.7 2.2h3.1" />
      </svg>
    </span>
  )
}

export function RunSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.1 4v8l4.8-4-4.8-4z" />
      </svg>
    </span>
  )
}

export function PreviewSymbolIcon() {
  return (
    <span className="chat-corner-symbol" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.8 3.7v8.6L11 8 5.8 3.7z" />
      </svg>
    </span>
  )
}

export function RunRailSymbolIcon() {
  return (
    <span className="chat-corner-symbol" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8.8 1.9 4.5 8.2h3.1l-0.8 5.9 4.7-7H8.1l0.7-5.2z" />
        <path d="M12.2 2.5 13.4 1" />
        <path d="M12.8 5h1.9" />
        <path d="M11.8 7.2 13.2 8.4" />
      </svg>
    </span>
  )
}

// Workflow glyph — the monoline automation route (trigger → decision → run →
// return), from design-assets/workflows/workflow-monoline.svg. Marks workflow
// chats on their welcome/identity surfaces. currentColor so the caller tints it.
export function WorkflowGlyphIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3.7" y="4.9" width="8" height="4.8" rx="1.4" />
        <path d="m16.4 4.6 3.35 3.35-3.35 3.35-3.35-3.35Z" />
        <rect x="5.9" y="14.3" width="11.8" height="4.95" rx="1.45" />
        <path d="M11.7 7.3h1.35" />
        <path d="M16.4 11.3v.95c0 1.25-.72 1.9-2.05 2.05" />
        <path d="M5.9 16.75H4.5c-1.2 0-2.05-.85-2.05-2.05V9.65" />
        <path d="M17.75 16.75h1.75c1.2 0 2.05-.85 2.05-2.05V9.45" />
      </svg>
    </span>
  )
}

// Claude-style send: the native Claude composer uses a "return" arrow glyph
// (↵) inside the send button instead of a play triangle. Used when
// appearance.composerStyle === 'claude' so the send/stop pair reads native.
export function ClaudeReturnSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12.5 4v2.5a2 2 0 0 1-2 2H4" />
        <path d="M6.5 6.5 4 8.5l2.5 2" />
      </svg>
    </span>
  )
}

// Up-arrow send glyph — used by Codex/Gemini/Kimi composers whose native
// send buttons all feature a filled circular `↑`. The button background +
// shape come from each composer-style's CSS; this just supplies the glyph.
export function ArrowUpSendIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 12.5V3.5" />
        <path d="M4 7l4-3.5 4 3.5" />
      </svg>
    </span>
  )
}

export function StopSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4.3" y="4.3" width="7.4" height="7.4" rx="1" />
      </svg>
    </span>
  )
}

export function QueueSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.6" y="1.6" width="4.8" height="12.8" rx="0.8" />
        <path d="M9.2 4.2h4.3M11.3 2.4v3.6M11.3 9.8v3.6" />
      </svg>
    </span>
  )
}

// Steer glyph: a forward-pointing arrow piercing a small circle (the
// active turn), conveying "redirect / pierce-through". Used by the
// composer's Steer button — sibling of Queue (passive wait) and Stop
// (interrupt only). Visible while the current chat has an in-flight
// run.
export function SteerSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="5.4" cy="8" r="2.6" />
        <path d="M8.4 8h5.2" />
        <path d="M11.6 5.6 13.6 8l-2 2.4" />
      </svg>
    </span>
  )
}

export function ThinkingIndicator() {
  // Participant name + model badge live in TranscriptPanel's `.message-meta`.
  // This bubble mirrors iOS LiveActivityAnchor: ghost + glow + "Working" + dots.
  return (
    <div className="message-bubble assistant message-working" aria-label="Working">
      <span className="message-working-ghost" aria-hidden>
        <span className="message-working-ghost-glow" />
        <span className="message-working-ghost-mark">
          <svg
            className="message-working-ghost-mark-svg"
            viewBox="32 24 72 88"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
            aria-hidden
          >
            <path d="M56 30H80L92 36L98 48V84H92L86 90L80 84L74 96L68 84L56 96L50 84H38V48L44 36Z" />
            <path d="M50 84V104" />
            <path d="M68 84V104" />
            <path d="M86 90V104" />
            <rect x="51" y="54" width="10" height="14" />
            <rect x="75" y="54" width="10" height="14" />
          </svg>
        </span>
      </span>
      <span className="message-working-text">
        <span className="message-working-label">Working</span>
        <span className="thinking-dots" aria-hidden>
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-dot" />
        </span>
      </span>
    </div>
  )
}

export function PlusSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 3.5v9M3.5 8h9" />
      </svg>
    </span>
  )
}

// Composer-unification (Phase J1): ChartBarSymbolIcon was only used by
// the retired Gemini-only `/stats` button.
// The dead icon component is removed; if a future surface needs a
// chart-bar glyph we can re-add it then.

/**
 * Small bar-chart glyph used as the Overview-tab icon on the welcome
 * dashboard. Lives inline with the other inline SymbolIcon components
 * to keep the icon shape consistent (stroked, 16-viewbox, rounded
 * caps). Welcome L9 — added when we swapped the dashboard tabs from
 * the Claude-style pill segmented control to icon + underline tabs.
 */
export function OverviewSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 13.5h11" />
        <rect x="3.6" y="8" width="2.2" height="4.4" rx="0.5" />
        <rect x="6.9" y="5.5" width="2.2" height="6.9" rx="0.5" />
        <rect x="10.2" y="3" width="2.2" height="9.4" rx="0.5" />
      </svg>
    </span>
  )
}

export function CommandSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.8" y="2.2" width="10.4" height="11.6" rx="2" />
        <path d="M4.9 4.5h6.2" />
        <path d="M4.9 7.5h4.6" />
        <path d="M4.9 10.5h5.2" />
        <circle cx="4.2" cy="4.5" r="0.8" />
        <circle cx="4.2" cy="7.5" r="0.8" />
        <circle cx="4.2" cy="10.5" r="0.8" />
      </svg>
    </span>
  )
}

export function ReviewSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="2.1" width="8" height="10.4" rx="1.2" />
        <path d="M4.2 4.8h5.6" />
        <path d="M4.2 7h5" />
        <path d="M4.2 9.2h3.2" />
        <circle cx="11" cy="11.2" r="2.2" />
        <path d="M12.8 13 14.3 14.5" />
      </svg>
    </span>
  )
}

export function ClockSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="5.7" />
        <path d="M8 4.8V8l2.2 1.4" />
      </svg>
    </span>
  )
}

/**
 * 1.0.4-AS3 — Screen Watch (Appwatch/Appshots) themed icon.
 *
 * An eye-on-screen glyph: rounded screen frame containing a small
 * pupil. Reads as "watching what's on screen" — pairs with the
 * Appwatch/Appshots feature's "the AI can see this window"
 * function. Sits in the composer telemetry row at 16x16, styled
 * to the same stroke weight as the clock symbol beside it.
 */
export function ScreenWatchSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Display frame (rounded rectangle representing the
         * watched window's chrome). */}
        <rect x="2.1" y="3" width="11.8" height="8.2" rx="1.4" />
        {/* Stand — tiny baseline under the screen. */}
        <path d="M6.3 13h3.4" />
        {/* Eye/pupil inside the screen: this is the "watch"
         * semantic. The outer arc evokes a closed eyelid; the inner
         * circle is the iris. */}
        <path d="M4.5 7.2 Q8 4.6 11.5 7.2" />
        <circle cx="8" cy="7.4" r="1.05" />
      </svg>
    </span>
  )
}

export function ModelSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4.1" y="4.1" width="7.8" height="7.8" rx="1.4" />
        <path d="M6.1 1.9v2.2M8 1.9v2.2M9.9 1.9v2.2M6.1 11.9v2.2M8 11.9v2.2M9.9 11.9v2.2M1.9 6.1h2.2M1.9 8h2.2M1.9 9.9h2.2M11.9 6.1h2.2M11.9 8h2.2M11.9 9.9h2.2" />
        <path d="M6.5 8h3" />
      </svg>
    </span>
  )
}

export function PermissionSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.1 7.8V4.2a.8.8 0 0 1 1.6 0v3" />
        <path d="M6.7 7.2V3.5a.8.8 0 0 1 1.6 0v3.7" />
        <path d="M8.3 7.2V4a.8.8 0 0 1 1.6 0v4" />
        <path d="M9.9 8V5.3a.8.8 0 0 1 1.6 0v4.4c0 2.1-1.4 3.7-3.4 3.7H7.3c-1.2 0-2.1-.5-2.8-1.4L3 9.9a.9.9 0 0 1 1.4-1.1l1 1.1" />
      </svg>
    </span>
  )
}

export function TrustSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2.2 12.2 4v3.3c0 2.7-1.6 5-4.2 6.5-2.6-1.5-4.2-3.8-4.2-6.5V4z" />
        <path d="m5.8 7.8 1.4 1.4 3-3" />
      </svg>
    </span>
  )
}

export function LinkCircleSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="8" cy="8" r="5.7" />
        <path d="M6.9 9.1 9.1 6.9" />
        <path d="M6.2 7.5 5.6 8.1a1.6 1.6 0 0 0 2.3 2.3l.6-.6" />
        <path d="m9.8 8.5.6-.6a1.6 1.6 0 0 0-2.3-2.3l-.6.6" />
      </svg>
    </span>
  )
}

// 1.0.5-AR12 — Workspace glyph used by the composer's workspace
// switch button (data-composer-control="workspace"). Matches the
// stroked, 16-viewbox, rounded-cap shape of the other inline
// composer SymbolIcons so it reads as a peer-token across all 9
// composer shells (default / codex / claude / gemini / kimi /
// modular / terminal / stub / satellite).
export function FolderSymbolIcon() {
  return (
    <span className="sf-symbol-icon composer-control-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.8 4.4h4.1L7.3 5.6h6.5c.6 0 1.1.4 1.1 1v6.2c0 .6-.5 1-1.1 1H2.8C2.2 13.8 1.7 13.4 1.7 12.8V5.5c0-.6.5-1.1 1.1-1.1z" />
      </svg>
    </span>
  )
}

// Composer-unification (Phase J1): CheckpointSymbolIcon was only used
// by the retired Gemini-only Checkpoints toggle button. Dead icon removed.

// Composer-unification (Phase J1): the previous WorktreeSymbolIcon was
// consumed only by the Gemini-only worktree button in the top-toggles
// row. That control now lives inside WorkspaceAccessControls, which
// renders its own scoped worktree glyph. Dead icon removed.

export function XSymbolIcon() {
  return (
    <span className="sf-symbol-icon" aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </span>
  )
}

export function ContextWheel({
  percent,
  label,
  codexShell = false,
  claudeShell = false,
  cursorShell = false,
  severity = 'ok'
}: {
  percent: number
  label: string
  /** Codex composer shell — 10% smaller ring, +1px rendered stroke weight. */
  codexShell?: boolean
  /** Claude composer shell — hairline ~1px ring matching real Claude. */
  claudeShell?: boolean
  /** Cursor composer shell — 10% smaller ring with a thicker stroke. */
  cursorShell?: boolean
  /** Context pressure (shared contextPressureSeverity thresholds) — tints the
   * ring amber at warn (≥80%) and red at critical (≥95%). */
  severity?: 'ok' | 'warn' | 'critical'
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  const radius = 5.5
  const strokeWidth = codexShell ? 2.7 : claudeShell ? 1 : cursorShell ? 2.5 : 1.7
  const circumference = 2 * Math.PI * radius
  const dash = (clamped / 100) * circumference
  const remainingDash = circumference - dash
  return (
    <span
      className={`context-wheel${severity !== 'ok' ? ` context-wheel--${severity}` : ''}`}
      title={label}
      aria-label={`Context ${Math.round(clamped)}% used (${label})`}
    >
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          opacity="0.22"
        />
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${remainingDash}`}
          // Circle strokes begin at 3 o'clock by default; rotate the ring once
          // so the progress arc starts from 12 o'clock across every composer.
          transform="rotate(-90 7 7)"
        />
      </svg>
    </span>
  )
}
