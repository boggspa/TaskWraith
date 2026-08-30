/**
 * Standalone (pure-Node Host / TUI) provider support matrix.
 *
 * Inventory and boundary only: this module does not admit providers, mint
 * credentials, or implement a second consent wall. The production Node Host
 * composes the static `LIVE_SELECTABLE_PROVIDER_IDS` plus one explicitly guarded
 * AntiGravity adapter. That adapter reads the existing profile consent and
 * requires a current nonempty `agy models` proof before it exposes any model.
 */

import { LIVE_SELECTABLE_PROVIDER_IDS } from '../shared/retiredProviders'
import { PI_UPSTREAM_KEY_ENV } from './pi/PiModelPolicy'

export type HostStandaloneProviderKind = 'live' | 'conditional'
export type HostStandaloneHostAvailability = 'composed' | 'unavailable'
export type HostStandaloneRunAvailability =
  | 'available'
  | 'conditional'
  | 'setup-only'
  | 'unavailable'

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
  readonly standaloneHost: 'composed'
  readonly run: 'conditional'
  readonly detail: string
}

const GROK_ENV_KEYS = ['XAI_API_KEY', 'GROK_API_KEY'] as const

const ANTIGRAVITY_DETAIL =
  'Conditionally composed. Standalone runs require the existing two-part profile consent plus a current nonempty authenticated `agy models` proof.'

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
    catalogManualFlow: true,
    envKeys: [],
    detail:
      'Local models need no account. Cloud models require a proven daemon sign-in or OLLAMA_API_KEY; an interactive `ollama signin` handoff is offered when the Host has a terminal launcher.'
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
  standaloneHost: 'composed',
  run: 'conditional',
  catalogManualFlow: true,
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

/** Every standalone-relevant provider row: the static live ids, then guarded AntiGravity. */
export function hostStandaloneProviderMatrix(): readonly HostStandaloneProviderMatrixRow[] {
  return [...LIVE_SELECTABLE_PROVIDER_IDS.map(liveRow), ANTIGRAVITY_ROW]
}

/** Provider ids the production Node Host actually composes. */
export function hostStandaloneComposedProviderIds(): readonly string[] {
  return [...LIVE_SELECTABLE_PROVIDER_IDS, 'antigravity']
}

/** Explicit AntiGravity projection: composed, but never admitted without live proof. */
export function hostStandaloneAntigravityStatus(): HostStandaloneAntigravityStatus {
  return {
    providerId: 'antigravity',
    kind: 'conditional',
    standaloneHost: 'composed',
    run: 'conditional',
    detail: ANTIGRAVITY_DETAIL
  }
}
