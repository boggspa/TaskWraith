// Settings → Providers icon rail. Purely presentational, like
// SettingsProviderAuthCard: one vertical `role="tablist"` of provider
// brand-logo tabs with a gliding selection pill, in the vocabulary the
// composer's combined model picker already uses. The pane beside it is owned
// by SettingsPanel, which holds the dozens of hooks the per-provider cards
// read; this module only decides which pane is selected.
//
// Every dependency is shared/ or renderer-local, so this adds no
// renderer→main runtime edge, and first paint is declarative (no layout
// effects): the pill is positioned from CSS variables, not measurement.

import type React from 'react'
import { Fragment, useRef } from 'react'
import type { ProviderId } from '../../../main/store/types'
import { ProviderBrandLogoIcon } from './icons/ProviderBrandLogo'
import { ApiKeyRequiredIcon } from './icons/ApiKeyRequiredIcon'
import type { ProviderAuthSummary, ProviderAuthVariant } from '../lib/providerAuthSummary'

/** Rail entries are providers plus the one cross-provider API-usage pane. */
export type SettingsProviderRailId = ProviderId | 'api-usage'

/**
 * Provider Hub groups its rail as PROVIDERS / SUBSCRIPTIONS. TaskWraith's
 * reading of the same split: subscription/CLI sign-ins first, then API-key
 * and local runtimes, then the consent-walled conditional provider last.
 */
export type SettingsProviderRailGroup = 'subscription' | 'api' | 'conditional'

export interface SettingsProviderRailEntry {
  id: SettingsProviderRailId
  label: string
  summary: ProviderAuthSummary
  group: SettingsProviderRailGroup
}

/**
 * Canonical rail order. The existing Providers-tab pin ("buries the
 * AntiGravity risk-consent card after Ollama") stays true because the
 * conditional AntiGravity tab is always last; retired Gemini never appears.
 */
export const SETTINGS_PROVIDER_RAIL_ORDER: readonly {
  id: SettingsProviderRailId
  group: SettingsProviderRailGroup
}[] = [
  { id: 'codex', group: 'subscription' },
  { id: 'claude', group: 'subscription' },
  { id: 'kimi', group: 'subscription' },
  { id: 'cursor', group: 'subscription' },
  { id: 'grok', group: 'subscription' },
  { id: 'muse', group: 'subscription' },
  { id: 'devin', group: 'subscription' },
  { id: 'ollama', group: 'api' },
  { id: 'pi', group: 'api' },
  { id: 'mistral', group: 'api' },
  { id: 'api-usage', group: 'api' },
  { id: 'antigravity', group: 'conditional' }
]

/** Per-viewer convenience only: the last rail tab the user looked at. */
export const SETTINGS_PROVIDER_RAIL_STORAGE_KEY = 'taskwraith-settings-provider-rail'

/**
 * Mirrors SettingsProviderAuthCard's dot rule so the rail dot and the pane dot
 * never disagree: "out-of-usage" borrows the amber partial dot, and the
 * CLI-owned Cursor/Grok auth surfaces read partial as ready.
 */
export function settingsProviderRailDotVariant(
  id: SettingsProviderRailId,
  variant: ProviderAuthVariant
): ProviderAuthVariant {
  if (variant === 'out-of-usage') return 'partial'
  if ((id === 'cursor' || id === 'grok') && variant === 'partial') return 'signed-in'
  return variant
}

/**
 * Keyboard semantics for a vertical tablist that lies flat at the narrow
 * breakpoint: Up/Left and Down/Right step with wrap-around, Home/End jump.
 * Returns null for keys the rail does not own so the event keeps bubbling.
 */
export function resolveSettingsProviderRailKeySelection(
  key: string,
  currentIndex: number,
  count: number
): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (currentIndex + 1) % count
    case 'ArrowUp':
    case 'ArrowLeft':
      return (currentIndex - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** The minimal Storage surface the initial-selection resolver reads. */
export interface SettingsProviderRailStorage {
  getItem(key: string): string | null
}

/**
 * Seed for the selected tab: an explicit preference (tests, deep links) wins,
 * then the per-viewer remembered tab, then the first rail entry. Storage is
 * optional and may throw (private windows, blocked site data), in which case
 * the first entry renders — which is also what SSR renders.
 */
export function resolveInitialSettingsProviderRailSelection(
  ids: readonly SettingsProviderRailId[],
  preferred?: string | null,
  storage?: SettingsProviderRailStorage | null
): SettingsProviderRailId {
  const first = ids[0] ?? 'codex'
  if (preferred && (ids as readonly string[]).includes(preferred)) {
    return preferred as SettingsProviderRailId
  }
  if (!storage) return first
  try {
    const remembered = storage.getItem(SETTINGS_PROVIDER_RAIL_STORAGE_KEY)
    if (remembered && (ids as readonly string[]).includes(remembered)) {
      return remembered as SettingsProviderRailId
    }
  } catch {
    // Per-viewer convenience only; a missing or throwing store means "first".
  }
  return first
}

/** Reads `window.localStorage` only when it exists; never throws. */
export function readSettingsProviderRailBrowserStorage(): SettingsProviderRailStorage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/** Best-effort remember; a blocked or full store is silently ignored. */
export function rememberSettingsProviderRailSelection(id: SettingsProviderRailId): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem(SETTINGS_PROVIDER_RAIL_STORAGE_KEY, id)
  } catch {
    // Per-viewer convenience only.
  }
}

export function settingsProviderRailTabId(idPrefix: string, id: SettingsProviderRailId): string {
  return `${idPrefix}-tab-${id}`
}

export function settingsProviderRailPaneId(idPrefix: string, id: SettingsProviderRailId): string {
  return `${idPrefix}-pane-${id}`
}

export interface SettingsProviderRailProps {
  entries: readonly SettingsProviderRailEntry[]
  selectedId: SettingsProviderRailId
  onSelect: (id: SettingsProviderRailId) => void
  /** Prefix for the tab / pane element ids that aria-controls joins. */
  idPrefix?: string
}

export function SettingsProviderRail({
  entries,
  selectedId,
  onSelect,
  idPrefix = 'settings-provider-rail'
}: SettingsProviderRailProps): React.JSX.Element {
  const tabRefs = useRef(new Map<SettingsProviderRailId, HTMLButtonElement>())
  const selectedIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.id === selectedId)
  )
  const selected = entries[selectedIndex]
  // The pill glides from two declarative counts: tabs above it and group
  // dividers above it. Each divider adds its own height plus one rail gap.
  // A tab that opens a group sits BELOW its own divider, so the slice must
  // include the selected entry (measured 2026-10-07: excluding it left the
  // pill one divider short on the first tab of every group).
  const dividersBeforeSelected = entries
    .slice(0, selectedIndex + 1)
    .filter((entry, index) => index > 0 && entry.group !== entries[index - 1].group).length

  const moveSelection = (nextIndex: number): void => {
    const next = entries[nextIndex]
    if (!next) return
    onSelect(next.id)
    tabRefs.current.get(next.id)?.focus()
  }

  return (
    <div
      className="settings-provider-rail"
      role="tablist"
      aria-label="Providers"
      aria-orientation="vertical"
      style={
        {
          '--settings-provider-rail-active-index': selectedIndex,
          '--settings-provider-rail-active-dividers': dividersBeforeSelected
        } as React.CSSProperties
      }
      onKeyDown={(event) => {
        const nextIndex = resolveSettingsProviderRailKeySelection(
          event.key,
          selectedIndex,
          entries.length
        )
        if (nextIndex === null) return
        event.preventDefault()
        moveSelection(nextIndex)
      }}
    >
      <span
        className="settings-provider-rail-indicator"
        aria-hidden
        style={
          {
            '--settings-provider-rail-indicator-accent': selected
              ? `var(--provider-${selected.id}-color, var(--accent))`
              : 'var(--accent)'
          } as React.CSSProperties
        }
      />
      {entries.map((entry, index) => {
        const active = entry.id === selectedId
        const dotVariant = settingsProviderRailDotVariant(entry.id, entry.summary.variant)
        const name = `${entry.label} · ${entry.summary.statusText}`
        const startsGroup = index > 0 && entry.group !== entries[index - 1].group
        return (
          <Fragment key={entry.id}>
            {startsGroup && (
              <span
                className="settings-provider-rail-divider"
                role="presentation"
                aria-hidden
                data-rail-group={entry.group}
              />
            )}
            <button
              type="button"
              role="tab"
              id={settingsProviderRailTabId(idPrefix, entry.id)}
              ref={(node) => {
                if (node) tabRefs.current.set(entry.id, node)
                else tabRefs.current.delete(entry.id)
              }}
              className={['settings-provider-rail-tab', active ? 'is-active' : '']
                .filter(Boolean)
                .join(' ')}
              data-provider={entry.id}
              data-rail-group={entry.group}
              style={
                {
                  '--settings-provider-rail-tab-accent': `var(--provider-${entry.id}-color, var(--accent))`
                } as React.CSSProperties
              }
              aria-selected={active}
              aria-controls={settingsProviderRailPaneId(idPrefix, entry.id)}
              aria-label={name}
              title={name}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(entry.id)}
            >
              {entry.id === 'api-usage' ? (
                <span
                  className="sidebar-provider-icon settings-provider-rail-generic-icon"
                  aria-hidden="true"
                >
                  <ApiKeyRequiredIcon />
                </span>
              ) : (
                <ProviderBrandLogoIcon provider={entry.id} />
              )}
              <span
                className={`settings-provider-auth-status-dot settings-provider-auth-status-dot-${dotVariant} settings-provider-rail-dot`}
                aria-hidden
              />
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
