import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { ChatRecord } from '../../../main/store/types'
import {
  buildTranscriptParticipantFilterItems,
  type TranscriptParticipantFilterItem
} from '../lib/transcriptParticipantFilter'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { getProviderLabel } from '../lib/providerLabels'
import { ProviderBrandLogo } from './icons/ProviderBrandLogo'

interface TranscriptParticipantFilterRailProps {
  currentChat?: ChatRecord | null
  items?: readonly TranscriptParticipantFilterItem[]
  activeFilterKeys: ReadonlySet<string>
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onToggleFilter: (key: string) => void
}

/** Hard cap per dock row — a full 50-seat roster is exactly two rows. */
export const TRANSCRIPT_PARTICIPANT_FILTER_ITEMS_PER_ROW = 25

/**
 * Pane-scoped CSS var the dock writes onto its own `.app-transcript`: the
 * vertical space the composer (and the transcript's bottom reserve) must give
 * up so the dock fits under the composer timecode row. Consumed with a 0px
 * fallback by `.composer-area`'s bottom calcs (03-composer-welcome-activity.css)
 * and `--composer-scroll-under-padding` / the composer fade anchors
 * (02-transcript-messages-fx.css).
 */
export const TRANSCRIPT_PARTICIPANT_FILTER_DOCK_RESERVE_VAR = '--participant-filter-dock-reserve'

/** Fallback when `--participant-filter-dock-bottom-gap` fails to resolve. */
const DOCK_BOTTOM_GAP_FALLBACK_PX = 10

function BossmanCrownIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M4.7 17.8h14.6l1.2-9.1-4.8 3.4-3.7-6-3.7 6-4.8-3.4 1.2 9.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M5.4 20h13.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CaptainHatIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden focusable="false">
      <path
        d="M5.2 15.8c2.3 1.2 11.3 1.2 13.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M6.8 14.8 8 9.7c.3-1.1 1.2-1.8 2.3-1.8h3.4c1.1 0 2 .7 2.3 1.8l1.2 5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M9 7.8 12 4l3 3.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function SystemFilterIcon(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
      <path
        d="M5.2 6.4h13.6v11.2H5.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="m8.1 10 2.1 2-2.1 2M12.2 14h3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FilterItemIcon({ item }: { item: TranscriptParticipantFilterItem }): ReactElement {
  if (item.kind === 'system') return <SystemFilterIcon />
  const accentProvider = resolveProviderHueClass(item.provider, item.participant?.model)
  return (
    <ProviderBrandLogo
      provider={item.provider}
      accentProvider={accentProvider}
      className="transcript-participant-filter-provider-icon"
    />
  )
}

function itemAccessibleLabel(item: TranscriptParticipantFilterItem, active: boolean): string {
  const action = active ? 'Remove transcript filter for' : 'Show only transcript messages from'
  if (item.kind === 'system') return `${action} system messages`
  const provider = item.provider ? getProviderLabel(item.provider) : 'Provider'
  const authority = item.isBossman ? 'Boss ' : item.isCaptain ? 'Captain ' : ''
  return `${action} ${authority}${item.role} (${provider}, ${item.ordinal})`
}

/**
 * Balanced row chunks: capped at `TRANSCRIPT_PARTICIPANT_FILTER_ITEMS_PER_ROW`,
 * but an over-cap roster splits EVENLY (26 → 13 + 13, never 25 + 1) so the
 * dock reads as a deliberate block instead of a full row with a stray tail.
 */
function chunkIntoBalancedRows(
  items: readonly TranscriptParticipantFilterItem[]
): TranscriptParticipantFilterItem[][] {
  const rowCount = Math.max(
    1,
    Math.ceil(items.length / TRANSCRIPT_PARTICIPANT_FILTER_ITEMS_PER_ROW)
  )
  const perRow = Math.ceil(items.length / rowCount)
  const rows: TranscriptParticipantFilterItem[][] = []
  for (let start = 0; start < items.length; start += perRow) {
    rows.push(items.slice(start, start + perRow))
  }
  return rows
}

/**
 * Filter-by-participant dock. One (or two, for over-25 rosters) centred rows
 * of provider chips glued to the BOTTOM of the chat pane — under the
 * composer's timecode bar, above the workspace terminal when it is open
 * (`.workspace-terminal-open .transcript-participant-filter-rail` re-anchors
 * the dock the same way the composer itself lifts).
 *
 * The dock is portaled into its own `.app-transcript` and anchored purely in
 * CSS, so unlike its former life as a measured right-flank rail it needs no
 * frame math and no `useRailFrameRemeasure` belt. Its one JS layout duty is
 * writing `--participant-filter-dock-reserve` (own height + the dock's bottom
 * gap) onto the pane so the composer and the transcript's bottom reserve rise
 * to make room; a ResizeObserver keeps that honest when narrow panes wrap the
 * rows. While the dock is hidden by an overlay/sheet (`display: none`,
 * offsetHeight 0) the last reserve is kept, so the composer never jumps
 * behind a backdrop.
 */
export function TranscriptParticipantFilterRail({
  currentChat,
  items: providedItems,
  activeFilterKeys,
  scrollRef,
  onToggleFilter
}: TranscriptParticipantFilterRailProps): ReactElement | null {
  const items = useMemo(
    () => providedItems || buildTranscriptParticipantFilterItems(currentChat),
    [currentChat, providedItems]
  )
  const participantItems = useMemo(
    () => items.filter((item) => item.kind === 'participant'),
    [items]
  )
  const systemItem = useMemo(() => items.find((item) => item.kind === 'system') || null, [items])
  const rows = useMemo(() => chunkIntoBalancedRows(participantItems), [participantItems])
  const dockRef = useRef<HTMLDivElement | null>(null)
  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null)

  const visible =
    !!currentChat && currentChat.chatKind === 'ensemble' && participantItems.length > 0

  useLayoutEffect(() => {
    const pane = scrollRef.current?.closest('.app-transcript')
    setPaneEl(pane instanceof HTMLElement ? pane : null)
  }, [scrollRef])

  useLayoutEffect(() => {
    const pane = paneEl
    const dock = dockRef.current
    if (!pane || !dock || !visible) return undefined
    const apply = (): void => {
      const height = dock.offsetHeight
      // Hidden (overlay/sheet hide list): keep the last written reserve so the
      // composer holds its place behind the backdrop.
      if (height <= 0) return
      const gapRaw = window
        .getComputedStyle(pane)
        .getPropertyValue('--participant-filter-dock-bottom-gap')
      const gap = Number.parseFloat(gapRaw)
      pane.style.setProperty(
        TRANSCRIPT_PARTICIPANT_FILTER_DOCK_RESERVE_VAR,
        `${Math.round(height + (Number.isFinite(gap) ? gap : DOCK_BOTTOM_GAP_FALLBACK_PX))}px`
      )
    }
    apply()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(apply)
      observer.observe(dock)
    }
    return () => {
      observer?.disconnect()
      pane.style.removeProperty(TRANSCRIPT_PARTICIPANT_FILTER_DOCK_RESERVE_VAR)
    }
  }, [paneEl, visible, rows.length, participantItems.length])

  if (!visible) return null

  const renderFilterButton = (item: TranscriptParticipantFilterItem): ReactElement => {
    const active = activeFilterKeys.has(item.key)
    const providerHueClass = item.provider
      ? resolveProviderHueClass(item.provider, item.participant?.model)
      : null
    const buttonStyle = providerHueClass
      ? ({
          '--participant-filter-accent': `var(--provider-${providerHueClass}-color, var(--accent))`
        } as CSSProperties)
      : undefined
    return (
      <button
        key={item.key}
        type="button"
        className={`transcript-participant-filter-button${
          active ? ' is-active' : ''
        }${item.kind === 'system' ? ' is-system' : ''}${
          providerHueClass ? ` provider-${providerHueClass}` : ''
        }`}
        data-provider-hue={providerHueClass || undefined}
        data-filter-ordinal={item.ordinal}
        aria-pressed={active}
        aria-label={itemAccessibleLabel(item, active)}
        title={item.title}
        style={buttonStyle}
        onClick={() => onToggleFilter(item.key)}
      >
        {item.kind === 'participant' && (
          <span className="transcript-participant-filter-side-stack">
            <span className="transcript-participant-filter-index">{item.ordinal}</span>
            {item.isBossman && (
              <span className="transcript-participant-filter-authority is-boss" title="Boss">
                <BossmanCrownIcon />
              </span>
            )}
            {item.isCaptain && (
              <span className="transcript-participant-filter-authority is-captain" title="Captain">
                <CaptainHatIcon />
              </span>
            )}
          </span>
        )}
        <span className="transcript-participant-filter-icon">
          <FilterItemIcon item={item} />
        </span>
      </button>
    )
  }

  const rail = (
    <div
      ref={dockRef}
      className={`transcript-participant-filter-rail${
        activeFilterKeys.size > 0 ? ' has-active-filter' : ''
      }`}
      data-row-count={rows.length}
      role="navigation"
      aria-label="Transcript participant filters"
    >
      {rows.map((row, rowIndex) => (
        <div className="transcript-participant-filter-row" key={rowIndex}>
          {row.map((item) => renderFilterButton(item))}
          {systemItem && rowIndex === rows.length - 1 && renderFilterButton(systemItem)}
        </div>
      ))}
    </div>
  )

  if (typeof document === 'undefined') return rail
  if (!paneEl) return null
  return createPortal(rail, paneEl)
}
