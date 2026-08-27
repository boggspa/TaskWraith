/**
 * Standalone (pure-Node Host / TUI) provider support matrix.
 *
 * Inventory and boundary only: this module does not admit providers, mint
 * credentials, or implement a second consent wall. The production Node Host
 * still composes exactly `LIVE_SELECTABLE_PROVIDER_IDS`. AntiGravity remains
 * desktop-conditional (`isAntigravityOptInEnabled` + configured key in Electron
 * settings). The standalone Host must not duplicate or substitute that consent.
 */

import { LIVE_SELECTABLE_PROVIDER_IDS } from '../shared/retiredProviders'
import { PI_UPSTREAM_KEY_ENV } from './pi/PiModelPolicy'

export type HostStandaloneProviderKind = 'live' | 'conditional'
export type HostStandaloneHostAvailability = 'composed' | 'unavailable'
export type HostStandaloneRunAvailability = 'available' | 'setup-only' | 'unavailable'

export interface HostStandaloneProviderMatrixRow {
  readonly providerId: string
  readonly displayProvider: string
  readonly kind: HostStandaloneProviderKind
  readonly standaloneHost: HostStandaloneHostAvailability
  readonly run: HostStandaloneRunAvailability
  readonly catalogManualFlow: boolean
  readonly envKeys: readonly string[]
  readonly detail: string
}

export interface HostStandaloneAntigravityStatus {
  readonly providerId: 'antigravity'
  readonly kind: 'conditional'
  readonly standaloneHost: 'unavailable'
  readonly run: 'unavailable'
  readonly detail: string
}

const GROK_ENV_KEYS = ['XAI_API_KEY', 'GROK_API_KEY'] as const

const ANTIGRAVITY_DETAIL =
  'Desktop-conditional only (Electron opt-in + configured key). Standalone Node Host does not compose or admit AntiGravity.'

interface LiveStandaloneFacts {
  readonly displayProvider: string
  readonly run: HostStandaloneRunAvailability
  readonly catalogManualFlow: boolean
  readonly envKeys: readonly string[]
  readonly detail: string
}

const LIVE_STANDALONE: Readonly<Record<string, LiveStandaloneFacts>> = {
  codex: {
    displayProvider: 'Codex',
    run: 'available',
    catalogManualFlow: true,
    envKeys: [],
    detail: 'Interactive `codex login` when a TTY launcher is present.'
  },
  claude: {
    displayProvider: 'Claude',
    run: 'available',
    catalogManualFlow: true,
    envKeys: [],
    detail: 'Interactive `claude auth login` when a TTY launcher is present.'
  },
  kimi: {
    displayProvider: 'Kimi',
    run: 'available',
    catalogManualFlow: true,
    envKeys: [],
    detail: 'Interactive `kimi login` when a TTY launcher is present.'
  },
  cursor: {
    displayProvider: 'Cursor',
    run: 'setup-only',
    catalogManualFlow: true,
    envKeys: [],
    detail:
      'Setup and `cursor-agent login` only. Runs stay hard-stopped: the Node Host cannot produce the MCP deny-list containment attestation a write-capable Cursor argv requires.'
  },
  grok: {
    displayProvider: 'Grok',
    run: 'available',
    catalogManualFlow: true,
    envKeys: GROK_ENV_KEYS,
    detail:
      'Interactive `grok login` when a TTY launcher is present, or set XAI_API_KEY / GROK_API_KEY on the Host environment.'
  },
  ollama: {
    displayProvider: 'Ollama',
    run: 'available',
    catalogManualFlow: false,
    envKeys: [],
    detail:
      'Local Ollama daemon. No terminal login and no begin-able catalog flow; Host uses daemon reachability as auth evidence.'
  },
  pi: {
    displayProvider: 'Pi',
    run: 'available',
    catalogManualFlow: false,
    envKeys: Object.values(PI_UPSTREAM_KEY_ENV),
    detail:
      'No terminal login and no begin-able catalog flow. Configure allowed upstream API keys on the Host environment.'
  },
  mistral: {
    displayProvider: 'Mistral',
    run: 'available',
    catalogManualFlow: true,
    envKeys: [],
    detail: 'Interactive `vibe` login when a TTY launcher is present.'
  },
  muse: {
    displayProvider: 'Muse',
    run: 'available',
    catalogManualFlow: true,
    envKeys: [],
    detail:
      'Interactive `muse login` via the dedicated Muse terminal handoff when a TTY is present.'
  }
}

const ANTIGRAVITY_ROW: HostStandaloneProviderMatrixRow = {
  providerId: 'antigravity',
  displayProvider: 'AntiGravity',
  kind: 'conditional',
  standaloneHost: 'unavailable',
  run: 'unavailable',
  catalogManualFlow: false,
  envKeys: [],
  detail: ANTIGRAVITY_DETAIL
}

function liveRow(providerId: string): HostStandaloneProviderMatrixRow {
  const facts = LIVE_STANDALONE[providerId]
  if (!facts) {
    throw new Error(`HostStandaloneProviderMatrix missing live row: ${providerId}`)
  }
  return {
    providerId,
    kind: 'live',
    standaloneHost: 'composed',
    ...facts
  }
}

/** Every standalone-relevant provider row: the nine composed live ids, then AntiGravity. */
export function hostStandaloneProviderMatrix(): readonly HostStandaloneProviderMatrixRow[] {
  return [...LIVE_SELECTABLE_PROVIDER_IDS.map(liveRow), ANTIGRAVITY_ROW]
}

/** Provider ids the production Node Host actually composes. */
export function hostStandaloneComposedProviderIds(): readonly string[] {
  return [...LIVE_SELECTABLE_PROVIDER_IDS]
}

/** Explicit AntiGravity projection: conditional on desktop, unavailable standalone. */
export function hostStandaloneAntigravityStatus(): HostStandaloneAntigravityStatus {
  return {
    providerId: 'antigravity',
    kind: 'conditional',
    standaloneHost: 'unavailable',
    run: 'unavailable',
    detail: ANTIGRAVITY_DETAIL
  }
}
