import type {
  EnsembleConfig,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from './store/types'

/*
 * F2 (1.0.3) — the per-provider participant defaults below MUST stay in
 * lockstep with `getDefaultEnsembleParticipantConfig` in
 * `src/renderer/src/lib/ensembleProviderDefaults.ts`, which is the
 * renderer-side single source-of-truth for the same values (model,
 * permissionPresetId, plus the reasoning/fast/thinking fallbacks the
 * composer pickers read at runtime). The two modules can't share a
 * file because the renderer module imports renderer-only types from
 * `CombinedModelPicker` and bundling main → renderer would tangle the
 * electron-vite build graph. Treat the renderer module as canonical;
 * if you change a default here, change it there too (the
 * `ensembleProviderDefaults.test.ts` fixtures pin the values).
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
    permissionPresetId: 'read_only'
  },
  {
    provider: 'codex',
    role: 'Codex',
    instructions: 'Implement concrete code or workflow changes when the round calls for action.',
    permissionPresetId: 'workspace_write'
  },
  {
    provider: 'kimi',
    role: 'Kimi',
    instructions: 'Review prior responses for gaps, edge cases, and test coverage.',
    permissionPresetId: 'read_only'
  },
  {
    // Grok is now a first-class provider, so it seeds into the default panel
    // like the others. Read-only until G5 (tool mediation via TaskWraith MCP +
    // approval ledger) lands write-capable runs; `getDefaultEnsembleParticipantConfig`
    // in ensembleProviderDefaults.ts mirrors this preset.
    provider: 'grok',
    role: 'Grok',
    instructions:
      'Stress-test the proposed approach: surface risky assumptions, failure modes, and simpler alternatives.',
    permissionPresetId: 'read_only'
  },
  {
    // Cursor (Composer 2.5) is first-class, so it seeds into the default panel
    // too. Read-only by default like the others (codex is the lone writer); the
    // user can grant write per-participant. `getDefaultEnsembleParticipantConfig`
    // in ensembleProviderDefaults.ts mirrors this preset.
    provider: 'cursor',
    role: 'Cursor',
    instructions:
      'Draft the concrete implementation: propose specific edits, file touches, and integration steps.',
    permissionPresetId: 'read_only'
  },
  {
    provider: 'ollama',
    role: 'Local',
    instructions:
      'Provide a local, privacy-preserving second opinion for summaries, triage, and small read-only reasoning tasks.',
    permissionPresetId: 'read_only'
  }
]

export function createDefaultEnsembleConfig(activeProvider?: ProviderId, configuredProviders?: Set<ProviderId>): EnsembleConfig {
  // E — seed only providers the user has actually configured (one of each) when
  // a set is supplied. The active provider is always included (current context).
  // Fall back to the full roster if fewer than 2 would remain, so a fresh or
  // barely-configured install still gets a usable panel, not a 1-participant one.
  let roles = DEFAULT_ENSEMBLE_ROLES
  if (configuredProviders) {
    const allowed = new Set(configuredProviders)
    if (activeProvider) allowed.add(activeProvider)
    const filtered = DEFAULT_ENSEMBLE_ROLES.filter((entry) => allowed.has(entry.provider))
    if (filtered.length >= 2) roles = filtered
  }
  const orderedProviders = rotateProviderFirst(
    roles.map((entry) => entry.provider),
    activeProvider
  )
  const orderByProvider = new Map(orderedProviders.map((provider, index) => [provider, index + 1]))
  // Slice F (1.0.3) — every provider is enabled by default now that
  // the in-composer chip strip + flyout let the user disable them
  // inline with one click. Previously we only enabled `activeProvider`
  // + claude + codex, which left Gemini / Kimi feeling like
  // second-class members of the ensemble surface.
  const participants: EnsembleParticipant[] = roles.map((entry) => ({
    id: `ensemble-${entry.provider}`,
    provider: entry.provider,
    enabled: true,
    role: entry.role,
    instructions: entry.instructions,
    order: orderByProvider.get(entry.provider) || 99,
    model: getDefaultEnsembleModel(entry.provider),
    permissionPresetId: entry.permissionPresetId
  })).sort((a, b) => a.order - b.order)

  return {
    enabled: true,
    // 1.0.4-AR2 — track the global ceiling (was 6).
    // 1.0.5-EW1 — ceiling raised 8 → 12. The DEFAULT_ENSEMBLE_ROLES
    // seed yields the live providers (claude / codex / kimi / grok /
    // cursor / ollama; gemini retired) so the user starts with a panel
    // well under the cap and has plenty
    // of headroom to add specialists / extra Claudes / etc. before
    // hitting the cap. The chip strip wraps at 7+ to a 6-column
    // second row, so even a fully-loaded 12-participant panel
    // stays navigable. Hard min on the remove path is 2.
    maxParticipants: 12,
    orchestrationMode: 'turn_bound',
    maxContinuationHops: 6,
    participants,
    updatedAt: new Date().toISOString()
  }
}

function getDefaultEnsembleModel(provider: ProviderId): string {
  if (provider === 'codex') return 'gpt-5.5'
  if (provider === 'claude') return 'claude-sonnet-5'
  if (provider === 'kimi') return 'kimi-k2.7-code'
  if (provider === 'grok') return 'grok-build'
  if (provider === 'cursor') return 'composer-2.5-fast'
  if (provider === 'ollama') return 'qwen3:4b-instruct'
  return 'flash-lite'
}

function rotateProviderFirst(providers: ProviderId[], activeProvider?: ProviderId): ProviderId[] {
  if (!activeProvider || !providers.includes(activeProvider)) return providers
  return [activeProvider, ...providers.filter((provider) => provider !== activeProvider)]
}
