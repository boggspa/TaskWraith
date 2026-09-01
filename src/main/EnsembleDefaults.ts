import type {
  EnsembleConfig,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from './store/types'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../shared/ensembleLimits'
import { DEVIN_DEFAULT_MODEL_ID } from '../shared/devinModelCatalog'

/*
 * F2 (1.0.3) — the per-provider MODEL defaults below MUST stay in
 * lockstep with `getDefaultEnsembleParticipantConfig` in
 * `src/renderer/src/lib/ensembleProviderDefaults.ts`, which is the
 * renderer-side single source-of-truth for the same values (model,
 * plus the reasoning/fast/thinking fallbacks the composer pickers read
 * at runtime). The two modules can't share a file because the renderer
 * module imports renderer-only types from `CombinedModelPicker` and
 * bundling main → renderer would tangle the electron-vite build graph.
 * Treat the renderer module as canonical; if you change a model default
 * here, change it there too (the `ensembleProviderDefaults.test.ts`
 * fixtures pin the values, and `EnsembleDefaults.test.ts` asserts the
 * model parity).
 *
 * permissionPresetId seeds uniformly with 'default' (Accept Edits) —
 * owner directive 2026-08-12, matching what chip-strip / roster-editor
 * adds already seed via `getDefaultEnsembleParticipantConfig`. The old
 * curated writer/reader split (codex lone writer, read-only recon
 * seats) is retired: read-only recon is a per-seat picker choice the
 * user makes, never a seeded posture. Seats on providers that are
 * toolless at dispatch (grok until G5 tool mediation) carry the preset
 * inertly until the row becomes tool-capable.
 */
const DEFAULT_ENSEMBLE_ROLES: Array<{
  provider: ProviderId
  role: string
  instructions: string
  permissionPresetId: PermissionPresetId
}> = [
  {
    provider: 'claude',
    role: 'Claude',
    instructions: 'Explore the request, identify constraints, and propose the safest path forward.',
    permissionPresetId: 'default'
  },
  {
    provider: 'codex',
    role: 'Codex',
    instructions: 'Implement concrete code or workflow changes when the round calls for action.',
    permissionPresetId: 'default'
  },
  {
    provider: 'kimi',
    role: 'Kimi',
    instructions: 'Review prior responses for gaps, edge cases, and test coverage.',
    permissionPresetId: 'default'
  },
  {
    provider: 'grok',
    role: 'Grok',
    instructions:
      'Stress-test the proposed approach: surface risky assumptions, failure modes, and simpler alternatives.',
    permissionPresetId: 'default'
  },
  {
    provider: 'ollama',
    role: 'Local',
    instructions:
      'Provide a local, privacy-preserving second opinion for summaries, triage, and small reasoning tasks.',
    permissionPresetId: 'default'
  }
]

const DEFAULT_SMALL_PANEL_SIZE = 4

const SMALL_PANEL_ROLES = [
  {
    role: 'Boss',
    brief:
      'Own the outcome, keep the panel scoped, and synthesize a clear decision from the other seats.'
  },
  {
    role: 'Captain',
    brief:
      'Act as second-in-command: challenge the plan, track unresolved risks, and keep the work moving.'
  },
  {
    role: 'Specialist',
    brief: 'Contribute concrete domain work and evidence for the task in front of the panel.'
  },
  {
    role: 'Outsider',
    brief:
      'Take an independent view, stress-test the emerging consensus, and surface missed alternatives.'
  }
] as const

// Prefer a local seat as the independent fourth voice when it is available,
// then fall back to providers whose default briefs are explicitly adversarial.
const OUTSIDER_PROVIDER_PRIORITY: ProviderId[] = ['ollama', 'grok', 'kimi']

function selectSmallPanelRoles(
  roles: typeof DEFAULT_ENSEMBLE_ROLES,
  activeProvider?: ProviderId
): typeof DEFAULT_ENSEMBLE_ROLES {
  const orderedProviders = rotateProviderFirst(
    roles.map((entry) => entry.provider),
    activeProvider
  )
  if (orderedProviders.length <= DEFAULT_SMALL_PANEL_SIZE) {
    return orderedProviders.map((provider) => roles.find((entry) => entry.provider === provider)!)
  }

  const primaryProviders = orderedProviders.slice(0, DEFAULT_SMALL_PANEL_SIZE - 1)
  const outsider = OUTSIDER_PROVIDER_PRIORITY.find(
    (provider) => orderedProviders.includes(provider) && !primaryProviders.includes(provider)
  )
  const selectedProviders = [
    ...primaryProviders,
    ...(outsider
      ? [outsider]
      : orderedProviders.slice(DEFAULT_SMALL_PANEL_SIZE - 1, DEFAULT_SMALL_PANEL_SIZE))
  ]
  return selectedProviders.map((provider) => roles.find((entry) => entry.provider === provider)!)
}

/**
 * A live Ensemble is a PANEL — two or more seats that can disagree. One seat
 * is just a solo chat wearing ensemble chrome (roster strip, round cards,
 * orchestration row) for no benefit, so `AppStore.setChatKind` tops a
 * solo→Ensemble conversion up to this floor and the renderer's chip strip
 * collapses the thread back to solo rather than persisting a one-seat roster.
 *
 * Deliberately NOT enforced on the rosters an Agent states explicitly — the
 * MCP roster edit (`EnsembleRosterMutation`, which allows removal down to 1)
 * and roster-preset import (`MIN_ROSTER_PRESET_PARTICIPANTS` is 1). Neither
 * routes through `setChatKind`, so this floor cannot reach them.
 */
export const MIN_LIVE_ENSEMBLE_PARTICIPANTS = 2

/**
 * Top a seeded roster up to `MIN_LIVE_ENSEMBLE_PARTICIPANTS`. The companion
 * seat prefers a provider the seed does NOT already use (a panel of two
 * different agents is the point); when the curated registry offers nothing
 * else it falls back to a second seat on the same provider in a different
 * role, which is a supported shape (e.g. two Claudes, one reviewing).
 *
 * Returns the input array unchanged when it already meets the floor, so
 * callers can apply it unconditionally.
 */
export function withMinimumEnsembleRoster(
  participants: EnsembleParticipant[]
): EnsembleParticipant[] {
  if (participants.length >= MIN_LIVE_ENSEMBLE_PARTICIPANTS) return participants
  const seated = new Set(participants.map((participant) => participant.provider))
  const takenIds = new Set(participants.map((participant) => participant.id))
  const next = [...participants]
  while (next.length < MIN_LIVE_ENSEMBLE_PARTICIPANTS) {
    const entry =
      DEFAULT_ENSEMBLE_ROLES.find((candidate) => !seated.has(candidate.provider)) ||
      DEFAULT_ENSEMBLE_ROLES.find(
        (candidate) => candidate.provider === next[next.length - 1]?.provider
      ) ||
      DEFAULT_ENSEMBLE_ROLES[0]
    seated.add(entry.provider)
    let id = `ensemble-companion-${entry.provider}`
    for (let suffix = 2; takenIds.has(id); suffix += 1) {
      id = `ensemble-companion-${entry.provider}-${suffix}`
    }
    takenIds.add(id)
    next.push({
      id,
      provider: entry.provider,
      enabled: true,
      role: entry.role,
      instructions: entry.instructions,
      order: next.length + 1,
      model: getDefaultEnsembleModel(entry.provider),
      permissionPresetId: entry.permissionPresetId
    })
  }
  return next
}

export function createDefaultEnsembleConfig(
  activeProvider?: ProviderId,
  configuredProviders?: Set<ProviderId>
): EnsembleConfig {
  // E — seed only providers the user has actually configured (one of each) when
  // a set is supplied. The active provider is always included (current context).
  // Fall back to the recommended panel if fewer than 2 would remain, so a
  // fresh or barely configured install still gets a usable panel rather than
  // a single-participant one.
  let roles = DEFAULT_ENSEMBLE_ROLES
  if (configuredProviders) {
    const allowed = new Set(configuredProviders)
    if (activeProvider) allowed.add(activeProvider)
    const filtered = DEFAULT_ENSEMBLE_ROLES.filter((entry) => allowed.has(entry.provider))
    if (filtered.length >= 2) roles = filtered
  }
  // A fresh panel should be small enough for each contribution to remain
  // inspectable. Users can still add seats up to the global ceiling, but the
  // default is Boss + Captain + Specialist + an independent Outsider.
  roles = selectSmallPanelRoles(roles, activeProvider)
  const orderedProviders = roles.map((entry) => entry.provider)
  const orderByProvider = new Map(orderedProviders.map((provider, index) => [provider, index + 1]))
  // Slice F (1.0.3) — every selected provider is enabled by default now that
  // the in-composer chip strip + flyout let the user disable them
  // inline with one click. Previously we only enabled `activeProvider`
  // + claude + codex, which left Gemini / Kimi feeling like
  // second-class members of the ensemble surface.
  const participants: EnsembleParticipant[] = roles
    .map((entry) => {
      const order = orderByProvider.get(entry.provider) || 99
      const panelRole = SMALL_PANEL_ROLES[order - 1] || SMALL_PANEL_ROLES[2]
      return {
        id: `ensemble-${entry.provider}`,
        provider: entry.provider,
        enabled: true,
        role: panelRole.role,
        instructions: `${panelRole.brief} ${entry.instructions}`,
        order,
        model: getDefaultEnsembleModel(entry.provider),
        permissionPresetId: entry.permissionPresetId
      }
    })
    .sort((a, b) => a.order - b.order)

  return {
    enabled: true,
    // 1.0.4-AR2 — track the global ceiling (was 6).
    // 1.0.5-EW1 — ceiling raised 8 → 12. The DEFAULT_ENSEMBLE_ROLES
    // 1.0.5-EW46 — ceiling raised 12 → 18 while keeping six chips per
    // wrapped row, so a full panel occupies three rows.
    // The registry covers all currently runnable providers (claude / codex /
    // kimi / grok / ollama), while the selector seeds at most four
    // so the user starts with a panel well under the cap and has plenty
    // of headroom to add specialists / extra Claudes / etc. before
    // hitting the cap. The chip strip wraps at 6+ into balanced rows
    // of at most 5, so even a fully-loaded participant panel
    // stays navigable in balanced rows. Hard min on the remove path is 2.
    maxParticipants: MAX_ENSEMBLE_PARTICIPANTS,
    orchestrationMode: 'continuous',
    maxContinuationHops: 6,
    participants,
    bossmanParticipantId: participants[0]?.id,
    captainParticipantIds: participants[1]?.id ? [participants[1].id] : [],
    secondInCommandParticipantId: participants[1]?.id,
    updatedAt: new Date().toISOString()
  }
}

function getDefaultEnsembleModel(provider: ProviderId): string {
  if (provider === 'codex') return 'gpt-5.5'
  if (provider === 'claude') return 'claude-sonnet-5'
  if (provider === 'kimi') return 'kimi-k2.7-code'
  if (provider === 'grok') return 'grok-4.6'
  if (provider === 'cursor') return 'composer-2.5-fast'
  if (provider === 'ollama') return 'qwen3.5:9b'
  if (provider === 'mistral') return 'devstral-small'
  if (provider === 'muse') return 'muse-spark-1.2'
  if (provider === 'devin') return DEVIN_DEFAULT_MODEL_ID
  return 'flash-lite'
}

function rotateProviderFirst(providers: ProviderId[], activeProvider?: ProviderId): ProviderId[] {
  if (!activeProvider || !providers.includes(activeProvider)) return providers
  return [activeProvider, ...providers.filter((provider) => provider !== activeProvider)]
}
