/**
 * Devin model catalogue — the model families the Devin CLI itself enumerates,
 * each with the CLI's own label, list price, and reasoning variants.
 *
 * Provenance: `devin models list --format json` from Devin CLI 3000.6.7
 * (260a97c8), retrieved 2026-09-01 on a signed-in self-serve seat. Every
 * variant `uid` below is a `model_uid` from that output — the exact value
 * `devin acp --model <uid>` receives — and every label is the CLI's own.
 *
 * TaskWraith offers ONE row per family (the family id) and drives the
 * reasoning level through its ordinary effort control; resolveDevinVariantId
 * folds (family, effort) back into the exact variant uid at dispatch time.
 * A family whose variants differ only by reasoning level therefore coalesces
 * into one picker row; GLM-5.2's 1M-context variants are a second family
 * (`glm-5-2-1m`) because context length is not a reasoning level.
 *
 * Curation rule (apply the same rule when refreshing from a newer CLI):
 *   - Cognition's own families (SWE-1.6 Slow — the seat default, so it leads —
 *     SWE-1.6 Fast / SWE-1.6, SWE-1.7, SWE-1.7 Lightning) and the Adaptive
 *     router are listed in full.
 *   - Every other family is the newest generation per vendor line only; older
 *     generations the CLI still lists (Claude Opus 4.5–4.8, Sonnet 4.5/4.6,
 *     Haiku 4.5, Fable 5, GPT-4.1 / 5.1 / 5.2 / 5.4 / 5.4 Mini / 5.5, Gemini 3
 *     / 3.1 Pro / 3.5 / 3.6, Kimi K2.6 / K2.7) are omitted — several of them
 *     carry opaque `MODEL_PRIVATE_*` uids rather than humanised slugs.
 *   - `-fast` / `-priority` speed-tier variants are omitted: same model,
 *     double the list price. (SWE-1.6 Fast / Slow are distinct families, so
 *     they stay.)
 *   - Variants keep the CLI's own order inside a family; the first one is the
 *     family default the CLI resolves a bare family slug or alias to, and it
 *     sets the family's default reasoning effort.
 *
 * There is deliberately NO `cli-default` sentinel: it was an ambiguous target
 * (whatever `~/.config/devin/config.json` or the enterprise default said), so
 * the seat now always dispatches an explicit variant. Legacy stored
 * selections that still carry the sentinel resolve to DEVIN_DEFAULT_MODEL_ID
 * through normalizeDevinModelId.
 */
export type DevinModelVendor =
  | 'Cognition'
  | 'Anthropic'
  | 'OpenAI'
  | 'Google'
  | 'xAI'
  | 'Moonshot AI'
  | 'Z.ai'
  | 'DeepSeek'
  | 'Thinking Machines'
  | 'NVIDIA'

/** Reasoning levels the CLI encodes as variant suffixes, ladder order. */
export type DevinReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const DEVIN_REASONING_EFFORT_LADDER: readonly DevinReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export const DEVIN_REASONING_EFFORT_LABELS: Readonly<Record<DevinReasoningEffort, string>> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
}

export interface DevinModelPricing {
  /** USD per 1M tokens, as the CLI listed them for this seat. */
  readonly input: number
  readonly cachedInput: number
  readonly output: number
}

export interface DevinModelVariant {
  /** Exact `model_uid` — the value passed to `devin acp --model`. */
  readonly uid: string
  /** Exact CLI `label`. */
  readonly label: string
  /** The reasoning level this variant pins; null for single-variant families. */
  readonly effort: DevinReasoningEffort | null
  readonly pricing: DevinModelPricing
  readonly isNew?: true
  readonly isBeta?: true
}

export interface DevinModelFamily {
  /** TaskWraith's model id for the family (normalised CLI family slug). */
  readonly id: string
  /** CLI `family_label`, e.g. 'Claude Opus 5'. */
  readonly label: string
  /** CLI family `slug`, the fuzzy name `/model` and `--model` also accept. */
  readonly familySlug: string
  /** CLI short aliases (`opus`, `swe`, `gpt`, …) that resolve to this family. */
  readonly aliases: readonly string[]
  readonly vendor: DevinModelVendor
  /** Variants in CLI order; the first is the family default. */
  readonly variants: readonly DevinModelVariant[]
  /** Reasoning level of the family default variant; null when there is no axis. */
  readonly defaultEffort: DevinReasoningEffort | null
  /** List price of the family default variant. */
  readonly pricing: DevinModelPricing
  readonly isNew?: true
  readonly isBeta?: true
}

/**
 * SWE-1.6 Slow — the seat default. It is the model the Devin CLI's own
 * `~/.config/devin/config.json` pins as `agent.model` on a fresh install,
 * Cognition's own coding model at the base SWE list price, and a
 * single-variant family, so the default needs no effort setting. It is always
 * available to a Devin seat, unlike Adaptive, which enterprise admins must
 * enable before the router can be selected.
 */
export const DEVIN_DEFAULT_MODEL_ID = 'swe-1-6-slow'

export const DEVIN_MODEL_CATALOG: readonly DevinModelFamily[] = [
  {
    id: 'swe-1-6-slow',
    label: 'SWE-1.6 Slow',
    familySlug: 'swe-1.6-slow',
    aliases: [],
    vendor: 'Cognition',
    variants: [
      {
        uid: 'swe-1-6-slow',
        label: 'SWE-1.6 Slow',
        effort: null,
        pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
      }
    ],
    defaultEffort: null,
    pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
  },
  {
    id: 'swe-1-7',
    label: 'SWE-1.7',
    familySlug: 'swe-1.7',
    aliases: [],
    vendor: 'Cognition',
    variants: [
      {
        uid: 'swe-1-7',
        label: 'SWE-1.7 Max',
        effort: 'max',
        pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
      },
      {
        uid: 'swe-1-7-medium',
        label: 'SWE-1.7 Medium',
        effort: 'medium',
        pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
      }
    ],
    defaultEffort: 'max',
    pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
  },
  {
    id: 'swe-1-7-lightning',
    label: 'SWE-1.7 Lightning',
    familySlug: 'swe-1.7-lightning',
    aliases: ['swe'],
    vendor: 'Cognition',
    variants: [
      {
        uid: 'swe-1-7-lightning',
        label: 'SWE-1.7 Lightning Max',
        effort: 'max',
        pricing: { input: 2.5, cachedInput: 1, output: 12.5 }
      },
      {
        uid: 'swe-1-7-lightning-medium',
        label: 'SWE-1.7 Lightning Medium',
        effort: 'medium',
        pricing: { input: 2.5, cachedInput: 1, output: 12.5 }
      }
    ],
    defaultEffort: 'max',
    pricing: { input: 2.5, cachedInput: 1, output: 12.5 }
  },
  {
    id: 'swe-1-6-fast',
    label: 'SWE-1.6 Fast',
    familySlug: 'swe-1.6-fast',
    aliases: [],
    vendor: 'Cognition',
    variants: [
      {
        uid: 'swe-1-6-fast',
        label: 'SWE-1.6 Fast',
        effort: null,
        pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
      }
    ],
    defaultEffort: null,
    pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
  },
  {
    id: 'swe-1-6',
    label: 'SWE-1.6',
    familySlug: 'swe-1.6',
    aliases: [],
    vendor: 'Cognition',
    variants: [
      {
        uid: 'swe-1-6',
        label: 'SWE-1.6',
        effort: null,
        pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
      }
    ],
    defaultEffort: null,
    pricing: { input: 0.5, cachedInput: 0.2, output: 2.5 }
  },
  {
    id: 'adaptive',
    label: 'Adaptive',
    familySlug: 'adaptive',
    aliases: [],
    vendor: 'Cognition',
    variants: [
      {
        uid: 'adaptive',
        label: 'Adaptive',
        effort: null,
        pricing: { input: 0.5, cachedInput: 0.1, output: 2 }
      }
    ],
    defaultEffort: null,
    pricing: { input: 0.5, cachedInput: 0.1, output: 2 }
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    familySlug: 'claude-fable-5.1',
    aliases: [],
    vendor: 'Anthropic',
    variants: [
      {
        uid: 'claude-fable-5-1-medium',
        label: 'Claude Fable 5.1 Medium',
        effort: 'medium',
        pricing: { input: 10, cachedInput: 0.25, output: 50 },
        isNew: true
      },
      {
        uid: 'claude-fable-5-1-low',
        label: 'Claude Fable 5.1 Low',
        effort: 'low',
        pricing: { input: 10, cachedInput: 0.25, output: 50 },
        isNew: true
      },
      {
        uid: 'claude-fable-5-1-high',
        label: 'Claude Fable 5.1 High',
        effort: 'high',
        pricing: { input: 10, cachedInput: 0.25, output: 50 },
        isNew: true
      },
      {
        uid: 'claude-fable-5-1-xhigh',
        label: 'Claude Fable 5.1 XHigh',
        effort: 'xhigh',
        pricing: { input: 10, cachedInput: 0.25, output: 50 },
        isNew: true
      },
      {
        uid: 'claude-fable-5-1-max',
        label: 'Claude Fable 5.1 Max',
        effort: 'max',
        pricing: { input: 10, cachedInput: 0.25, output: 50 },
        isNew: true
      }
    ],
    defaultEffort: 'medium',
    pricing: { input: 10, cachedInput: 0.25, output: 50 },
    isNew: true
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    familySlug: 'claude-opus-5',
    aliases: ['opus'],
    vendor: 'Anthropic',
    variants: [
      {
        uid: 'claude-opus-5-medium',
        label: 'Claude Opus 5 Medium',
        effort: 'medium',
        pricing: { input: 5, cachedInput: 0.5, output: 25 }
      },
      {
        uid: 'claude-opus-5-low',
        label: 'Claude Opus 5 Low',
        effort: 'low',
        pricing: { input: 5, cachedInput: 0.5, output: 25 }
      },
      {
        uid: 'claude-opus-5-high',
        label: 'Claude Opus 5 High',
        effort: 'high',
        pricing: { input: 5, cachedInput: 0.5, output: 25 }
      },
      {
        uid: 'claude-opus-5-xhigh',
        label: 'Claude Opus 5 XHigh',
        effort: 'xhigh',
        pricing: { input: 5, cachedInput: 0.5, output: 25 }
      },
      {
        uid: 'claude-opus-5-max',
        label: 'Claude Opus 5 Max',
        effort: 'max',
        pricing: { input: 5, cachedInput: 0.5, output: 25 }
      }
    ],
    defaultEffort: 'medium',
    pricing: { input: 5, cachedInput: 0.5, output: 25 }
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    familySlug: 'claude-sonnet-5',
    aliases: ['claude', 'sonnet'],
    vendor: 'Anthropic',
    variants: [
      {
        uid: 'claude-sonnet-5-medium',
        label: 'Claude Sonnet 5 Medium',
        effort: 'medium',
        pricing: { input: 2, cachedInput: 0.2, output: 10 }
      },
      {
        uid: 'claude-sonnet-5-low',
        label: 'Claude Sonnet 5 Low',
        effort: 'low',
        pricing: { input: 2, cachedInput: 0.2, output: 10 }
      },
      {
        uid: 'claude-sonnet-5-high',
        label: 'Claude Sonnet 5 High',
        effort: 'high',
        pricing: { input: 2, cachedInput: 0.2, output: 10 }
      },
      {
        uid: 'claude-sonnet-5-xhigh',
        label: 'Claude Sonnet 5 XHigh',
        effort: 'xhigh',
        pricing: { input: 2, cachedInput: 0.2, output: 10 }
      },
      {
        uid: 'claude-sonnet-5-max',
        label: 'Claude Sonnet 5 Max',
        effort: 'max',
        pricing: { input: 2, cachedInput: 0.2, output: 10 }
      }
    ],
    defaultEffort: 'medium',
    pricing: { input: 2, cachedInput: 0.2, output: 10 }
  },
  {
    id: 'gpt-5-6-sol',
    label: 'GPT-5.6 Sol',
    familySlug: 'gpt-5.6-sol',
    aliases: [],
    vendor: 'OpenAI',
    variants: [
      {
        uid: 'gpt-5-6-sol-medium',
        label: 'GPT-5.6 Sol Medium Thinking',
        effort: 'medium',
        pricing: { input: 4, cachedInput: 0.4, output: 20 }
      },
      {
        uid: 'gpt-5-6-sol-none',
        label: 'GPT-5.6 Sol No Thinking',
        effort: 'none',
        pricing: { input: 4, cachedInput: 0.4, output: 20 }
      },
      {
        uid: 'gpt-5-6-sol-low',
        label: 'GPT-5.6 Sol Low Thinking',
        effort: 'low',
        pricing: { input: 4, cachedInput: 0.4, output: 20 }
      },
      {
        uid: 'gpt-5-6-sol-high',
        label: 'GPT-5.6 Sol High Thinking',
        effort: 'high',
        pricing: { input: 4, cachedInput: 0.4, output: 20 }
      },
      {
        uid: 'gpt-5-6-sol-xhigh',
        label: 'GPT-5.6 Sol XHigh Thinking',
        effort: 'xhigh',
        pricing: { input: 4, cachedInput: 0.4, output: 20 }
      },
      {
        uid: 'gpt-5-6-sol-max',
        label: 'GPT-5.6 Sol Max Thinking',
        effort: 'max',
        pricing: { input: 4, cachedInput: 0.4, output: 20 }
      }
    ],
    defaultEffort: 'medium',
    pricing: { input: 4, cachedInput: 0.4, output: 20 }
  },
  {
    id: 'gpt-5-6-terra',
    label: 'GPT-5.6 Terra',
    familySlug: 'gpt-5.6-terra',
    aliases: ['gpt'],
    vendor: 'OpenAI',
    variants: [
      {
        uid: 'gpt-5-6-terra-none',
        label: 'GPT-5.6 Terra No Thinking',
        effort: 'none',
        pricing: { input: 2, cachedInput: 0.2, output: 12 }
      },
      {
        uid: 'gpt-5-6-terra-low',
        label: 'GPT-5.6 Terra Low Thinking',
        effort: 'low',
        pricing: { input: 2, cachedInput: 0.2, output: 12 }
      },
      {
        uid: 'gpt-5-6-terra-medium',
        label: 'GPT-5.6 Terra Medium Thinking',
        effort: 'medium',
        pricing: { input: 2, cachedInput: 0.2, output: 12 }
      },
      {
        uid: 'gpt-5-6-terra-high',
        label: 'GPT-5.6 Terra High Thinking',
        effort: 'high',
        pricing: { input: 2, cachedInput: 0.2, output: 12 }
      },
      {
        uid: 'gpt-5-6-terra-xhigh',
        label: 'GPT-5.6 Terra XHigh Thinking',
        effort: 'xhigh',
        pricing: { input: 2, cachedInput: 0.2, output: 12 }
      },
      {
        uid: 'gpt-5-6-terra-max',
        label: 'GPT-5.6 Terra Max Thinking',
        effort: 'max',
        pricing: { input: 2, cachedInput: 0.2, output: 12 }
      }
    ],
    defaultEffort: 'none',
    pricing: { input: 2, cachedInput: 0.2, output: 12 }
  },
  {
    id: 'gpt-5-6-luna',
    label: 'GPT-5.6 Luna',
    familySlug: 'gpt-5.6-luna',
    aliases: [],
    vendor: 'OpenAI',
    variants: [
      {
        uid: 'gpt-5-6-luna-medium',
        label: 'GPT-5.6 Luna Medium Thinking',
        effort: 'medium',
        pricing: { input: 0.2, cachedInput: 0.02, output: 1.2 }
      },
      {
        uid: 'gpt-5-6-luna-none',
        label: 'GPT-5.6 Luna No Thinking',
        effort: 'none',
        pricing: { input: 0.2, cachedInput: 0.02, output: 1.2 }
      },
      {
        uid: 'gpt-5-6-luna-low',
        label: 'GPT-5.6 Luna Low Thinking',
        effort: 'low',
        pricing: { input: 0.2, cachedInput: 0.02, output: 1.2 }
      },
      {
        uid: 'gpt-5-6-luna-high',
        label: 'GPT-5.6 Luna High Thinking',
        effort: 'high',
        pricing: { input: 0.2, cachedInput: 0.02, output: 1.2 }
      },
      {
        uid: 'gpt-5-6-luna-xhigh',
        label: 'GPT-5.6 Luna XHigh Thinking',
        effort: 'xhigh',
        pricing: { input: 0.2, cachedInput: 0.02, output: 1.2 }
      },
      {
        uid: 'gpt-5-6-luna-max',
        label: 'GPT-5.6 Luna Max Thinking',
        effort: 'max',
        pricing: { input: 0.2, cachedInput: 0.02, output: 1.2 }
      }
    ],
    defaultEffort: 'medium',
    pricing: { input: 0.2, cachedInput: 0.02, output: 1.2 }
  },
  {
    id: 'gpt-5-3-codex',
    label: 'GPT-5.3-Codex',
    familySlug: 'gpt-5.3-codex',
    aliases: ['codex'],
    vendor: 'OpenAI',
    variants: [
      {
        uid: 'gpt-5-3-codex-low',
        label: 'GPT-5.3-Codex Low',
        effort: 'low',
        pricing: { input: 1.75, cachedInput: 0.17, output: 14 }
      },
      {
        uid: 'gpt-5-3-codex-medium',
        label: 'GPT-5.3-Codex Medium',
        effort: 'medium',
        pricing: { input: 1.75, cachedInput: 0.17, output: 14 }
      },
      {
        uid: 'gpt-5-3-codex-high',
        label: 'GPT-5.3-Codex High',
        effort: 'high',
        pricing: { input: 1.75, cachedInput: 0.17, output: 14 }
      },
      {
        uid: 'gpt-5-3-codex-xhigh',
        label: 'GPT-5.3-Codex X-High',
        effort: 'xhigh',
        pricing: { input: 1.75, cachedInput: 0.17, output: 14 }
      }
    ],
    defaultEffort: 'low',
    pricing: { input: 1.75, cachedInput: 0.17, output: 14 }
  },
  {
    id: 'gemini-3-7-flash',
    label: 'Gemini 3.7 Flash',
    familySlug: 'gemini-3.7-flash',
    aliases: ['gemini'],
    vendor: 'Google',
    variants: [
      {
        uid: 'gemini-3-7-flash-medium',
        label: 'Gemini 3.7 Flash Medium',
        effort: 'medium',
        pricing: { input: 1.5, cachedInput: 0.15, output: 7.5 }
      },
      {
        uid: 'gemini-3-7-flash-low',
        label: 'Gemini 3.7 Flash Low',
        effort: 'low',
        pricing: { input: 1.5, cachedInput: 0.15, output: 7.5 }
      },
      {
        uid: 'gemini-3-7-flash-high',
        label: 'Gemini 3.7 Flash High',
        effort: 'high',
        pricing: { input: 1.5, cachedInput: 0.15, output: 7.5 }
      }
    ],
    defaultEffort: 'medium',
    pricing: { input: 1.5, cachedInput: 0.15, output: 7.5 }
  },
  {
    id: 'grok-4-6',
    label: 'Grok 4.6',
    familySlug: 'grok-4.6',
    aliases: [],
    vendor: 'xAI',
    variants: [
      {
        uid: 'grok-4-6-low',
        label: 'Grok 4.6 Low',
        effort: 'low',
        pricing: { input: 2, cachedInput: 0.3, output: 6 },
        isNew: true,
        isBeta: true
      },
      {
        uid: 'grok-4-6-medium',
        label: 'Grok 4.6 Medium',
        effort: 'medium',
        pricing: { input: 2, cachedInput: 0.3, output: 6 },
        isNew: true,
        isBeta: true
      },
      {
        uid: 'grok-4-6-high',
        label: 'Grok 4.6 High',
        effort: 'high',
        pricing: { input: 2, cachedInput: 0.3, output: 6 },
        isNew: true,
        isBeta: true
      },
      {
        uid: 'grok-4-6-xhigh',
        label: 'Grok 4.6 XHigh',
        effort: 'xhigh',
        pricing: { input: 2, cachedInput: 0.3, output: 6 },
        isNew: true,
        isBeta: true
      }
    ],
    defaultEffort: 'low',
    pricing: { input: 2, cachedInput: 0.3, output: 6 },
    isNew: true,
    isBeta: true
  },
  {
    id: 'grok-4-5',
    label: 'Grok 4.5',
    familySlug: 'grok-4.5',
    aliases: [],
    vendor: 'xAI',
    variants: [
      {
        uid: 'grok-4-5-low',
        label: 'Grok 4.5 Low',
        effort: 'low',
        pricing: { input: 2, cachedInput: 0.3, output: 6 }
      },
      {
        uid: 'grok-4-5-medium',
        label: 'Grok 4.5 Medium',
        effort: 'medium',
        pricing: { input: 2, cachedInput: 0.3, output: 6 }
      },
      {
        uid: 'grok-4-5-high',
        label: 'Grok 4.5 High',
        effort: 'high',
        pricing: { input: 2, cachedInput: 0.3, output: 6 }
      }
    ],
    defaultEffort: 'low',
    pricing: { input: 2, cachedInput: 0.3, output: 6 }
  },
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    familySlug: 'kimi-k3',
    aliases: [],
    vendor: 'Moonshot AI',
    variants: [
      {
        uid: 'kimi-k3-high',
        label: 'Kimi K3 High',
        effort: 'high',
        pricing: { input: 3, cachedInput: 0.3, output: 15 }
      },
      {
        uid: 'kimi-k3-low',
        label: 'Kimi K3 Low',
        effort: 'low',
        pricing: { input: 3, cachedInput: 0.3, output: 15 }
      },
      {
        uid: 'kimi-k3-max',
        label: 'Kimi K3 Max',
        effort: 'max',
        pricing: { input: 3, cachedInput: 0.3, output: 15 }
      }
    ],
    defaultEffort: 'high',
    pricing: { input: 3, cachedInput: 0.3, output: 15 }
  },
  {
    id: 'glm-5-3',
    label: 'GLM-5.3',
    familySlug: 'glm-5.3',
    aliases: [],
    vendor: 'Z.ai',
    variants: [
      {
        uid: 'glm-5-3-low',
        label: 'GLM-5.3 Low',
        effort: 'low',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'glm-5-3-high',
        label: 'GLM-5.3 High',
        effort: 'high',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'glm-5-3-max',
        label: 'GLM-5.3 Max',
        effort: 'max',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      }
    ],
    defaultEffort: 'low',
    pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
  },
  {
    id: 'glm-5-3-flash',
    label: 'GLM-5.3 Flash',
    familySlug: 'glm-5.3-flash',
    aliases: [],
    vendor: 'Z.ai',
    variants: [
      {
        uid: 'glm-5-3-flash-low',
        label: 'GLM-5.3 Flash Low',
        effort: 'low',
        pricing: { input: 0.15, cachedInput: 0.03, output: 0.5 }
      },
      {
        uid: 'glm-5-3-flash-high',
        label: 'GLM-5.3 Flash High',
        effort: 'high',
        pricing: { input: 0.15, cachedInput: 0.03, output: 0.5 }
      },
      {
        uid: 'glm-5-3-flash-max',
        label: 'GLM-5.3 Flash Max',
        effort: 'max',
        pricing: { input: 0.15, cachedInput: 0.03, output: 0.5 }
      }
    ],
    defaultEffort: 'low',
    pricing: { input: 0.15, cachedInput: 0.03, output: 0.5 }
  },
  {
    id: 'glm-5-2',
    label: 'GLM-5.2',
    familySlug: 'glm-5.2',
    aliases: [],
    vendor: 'Z.ai',
    variants: [
      {
        uid: 'glm-5-2',
        label: 'GLM-5.2 High',
        effort: 'high',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'glm-5-2-max',
        label: 'GLM-5.2 Max',
        effort: 'max',
        pricing: { input: 0.7, cachedInput: 0.13, output: 2.2 }
      },
      {
        uid: 'glm-5-2-none',
        label: 'GLM-5.2 No Thinking',
        effort: 'none',
        pricing: { input: 0.7, cachedInput: 0.13, output: 2.2 }
      }
    ],
    defaultEffort: 'high',
    pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
  },
  {
    id: 'glm-5-2-1m',
    label: 'GLM-5.2 1M',
    familySlug: 'glm-5.2',
    aliases: [],
    vendor: 'Z.ai',
    variants: [
      {
        uid: 'glm-5-2-1m',
        label: 'GLM-5.2 High 1M',
        effort: 'high',
        pricing: { input: 0.7, cachedInput: 0.13, output: 2.2 }
      },
      {
        uid: 'glm-5-2-max-1m',
        label: 'GLM-5.2 Max 1M',
        effort: 'max',
        pricing: { input: 0.7, cachedInput: 0.13, output: 2.2 }
      },
      {
        uid: 'glm-5-2-none-1m',
        label: 'GLM-5.2 No Thinking 1M',
        effort: 'none',
        pricing: { input: 0.7, cachedInput: 0.13, output: 2.2 }
      }
    ],
    defaultEffort: 'high',
    pricing: { input: 0.7, cachedInput: 0.13, output: 2.2 }
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    familySlug: 'deepseek-v4-pro',
    aliases: [],
    vendor: 'DeepSeek',
    variants: [
      {
        uid: 'deepseek-v4-pro-low',
        label: 'DeepSeek V4 Pro Low',
        effort: 'low',
        pricing: { input: 1.32, cachedInput: 0.04, output: 3.96 }
      },
      {
        uid: 'deepseek-v4-pro-high',
        label: 'DeepSeek V4 Pro High',
        effort: 'high',
        pricing: { input: 1.32, cachedInput: 0.04, output: 3.96 }
      },
      {
        uid: 'deepseek-v4-pro-max',
        label: 'DeepSeek V4 Pro Max',
        effort: 'max',
        pricing: { input: 1.32, cachedInput: 0.04, output: 3.96 }
      }
    ],
    defaultEffort: 'low',
    pricing: { input: 1.32, cachedInput: 0.04, output: 3.96 }
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    familySlug: 'deepseek-v4-flash',
    aliases: [],
    vendor: 'DeepSeek',
    variants: [
      {
        uid: 'deepseek-v4-flash-low',
        label: 'DeepSeek V4 Flash Low',
        effort: 'low',
        pricing: { input: 0.14, cachedInput: 0.03, output: 0.28 }
      },
      {
        uid: 'deepseek-v4-flash-high',
        label: 'DeepSeek V4 Flash High',
        effort: 'high',
        pricing: { input: 0.14, cachedInput: 0.03, output: 0.28 }
      },
      {
        uid: 'deepseek-v4-flash-max',
        label: 'DeepSeek V4 Flash Max',
        effort: 'max',
        pricing: { input: 0.14, cachedInput: 0.03, output: 0.28 }
      }
    ],
    defaultEffort: 'low',
    pricing: { input: 0.14, cachedInput: 0.03, output: 0.28 }
  },
  {
    id: 'inkling',
    label: 'Inkling',
    familySlug: 'inkling',
    aliases: [],
    vendor: 'Thinking Machines',
    variants: [
      {
        uid: 'inkling-none',
        label: 'Inkling None',
        effort: 'none',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'inkling-low',
        label: 'Inkling Low',
        effort: 'low',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'inkling-medium',
        label: 'Inkling Medium',
        effort: 'medium',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'inkling-high',
        label: 'Inkling High',
        effort: 'high',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'inkling-xhigh',
        label: 'Inkling X-High',
        effort: 'xhigh',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      },
      {
        uid: 'inkling-max',
        label: 'Inkling Max',
        effort: 'max',
        pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
      }
    ],
    defaultEffort: 'none',
    pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 }
  },
  {
    id: 'nemotron-3-ultra',
    label: 'Nemotron 3 Ultra',
    familySlug: 'nemotron-3-ultra',
    aliases: [],
    vendor: 'NVIDIA',
    variants: [
      {
        uid: 'nemotron-3-ultra-none',
        label: 'Nemotron 3 Ultra None',
        effort: 'none',
        pricing: { input: 0.6, cachedInput: 0.12, output: 2.4 }
      },
      {
        uid: 'nemotron-3-ultra-medium',
        label: 'Nemotron 3 Ultra Medium',
        effort: 'medium',
        pricing: { input: 0.6, cachedInput: 0.12, output: 2.4 }
      },
      {
        uid: 'nemotron-3-ultra-high',
        label: 'Nemotron 3 Ultra High',
        effort: 'high',
        pricing: { input: 0.6, cachedInput: 0.12, output: 2.4 }
      }
    ],
    defaultEffort: 'none',
    pricing: { input: 0.6, cachedInput: 0.12, output: 2.4 }
  }
]

export const DEVIN_MODEL_IDS: readonly string[] = DEVIN_MODEL_CATALOG.map((family) => family.id)

const FAMILIES_BY_ID: ReadonlyMap<string, DevinModelFamily> = new Map(
  DEVIN_MODEL_CATALOG.map((family) => [family.id, family])
)

const VARIANTS_BY_UID: ReadonlyMap<
  string,
  { family: DevinModelFamily; variant: DevinModelVariant }
> = new Map(
  DEVIN_MODEL_CATALOG.flatMap((family) =>
    family.variants.map((variant) => [variant.uid, { family, variant }] as const)
  )
)

/**
 * Labels for every family id AND every variant uid, so a run recorded with
 * the exact dispatched variant still reads as the CLI's own label.
 */
export const DEVIN_MODEL_LABELS: Readonly<Record<string, string>> = Object.fromEntries([
  // Variants first, families last: a family whose default variant shares its
  // id (SWE-1.7's bare `swe-1-7` is its Max variant) must label as the family.
  ...DEVIN_MODEL_CATALOG.flatMap((family) =>
    family.variants.map((variant) => [variant.uid, variant.label] as const)
  ),
  ...DEVIN_MODEL_CATALOG.map((family) => [family.id, family.label] as const)
])

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

export function findDevinCatalogRow(value: string | null | undefined): DevinModelFamily | null {
  const key = normalizeKey(value)
  return key ? (FAMILIES_BY_ID.get(key) ?? null) : null
}

export function findDevinVariant(
  value: string | null | undefined
): { family: DevinModelFamily; variant: DevinModelVariant } | null {
  const key = normalizeKey(value)
  return key ? (VARIANTS_BY_UID.get(key) ?? null) : null
}

export function isDevinCatalogModelId(value: string | null | undefined): boolean {
  return findDevinCatalogRow(value) !== null
}

/** Reasoning levels a family offers, in ladder order (empty = no axis). */
export function devinReasoningEfforts(modelId: string | null | undefined): DevinReasoningEffort[] {
  const family = findDevinCatalogRow(modelId)
  if (!family) return []
  const offered = new Set(
    family.variants.map((variant) => variant.effort).filter((effort) => effort !== null)
  )
  return DEVIN_REASONING_EFFORT_LADDER.filter((effort) => offered.has(effort))
}

export function devinDefaultReasoningEffort(
  modelId: string | null | undefined
): DevinReasoningEffort | null {
  return findDevinCatalogRow(modelId)?.defaultEffort ?? null
}

function isDevinReasoningEffort(value: string): value is DevinReasoningEffort {
  return (DEVIN_REASONING_EFFORT_LADDER as readonly string[]).includes(value)
}

/** Composer/picker effort token → the CLI's level; `extra` is the old spelling of `xhigh`. */
export function normalizeDevinReasoningEffort(
  value: string | null | undefined
): DevinReasoningEffort | null {
  const key = normalizeKey(value)
  if (!key) return null
  if (key === 'extra' || key === 'extra-high' || key === 'extra_high') return 'xhigh'
  if (key === 'off') return 'none'
  return isDevinReasoningEffort(key) ? key : null
}

function formatUsd(value: number): string {
  return `$${Number.isInteger(value) ? value.toFixed(0) : String(value)}`
}

/** Picker/catalogue description: vendor and the CLI's list price for this seat. */
export function devinModelDescription(family: DevinModelFamily): string {
  const parts = [
    family.vendor === 'Cognition' ? 'Cognition' : `${family.vendor} via Devin`,
    `${formatUsd(family.pricing.input)} in / ${formatUsd(family.pricing.output)} out per 1M tokens`
  ]
  if (family.isNew) parts.push('new')
  if (family.isBeta) parts.push('beta')
  return parts.join(' · ')
}

/**
 * The legacy sentinels a stored Devin selection may still carry. None of them
 * names a model, so all of them resolve to the seat default.
 */
const DEVIN_DEFAULT_SENTINELS: ReadonlySet<string> = new Set([
  '',
  'default',
  'cli-default',
  'auto',
  'custom',
  'best'
])

/**
 * Canonicalise a Devin model selection for the picker and for display.
 *   - sentinels → DEVIN_DEFAULT_MODEL_ID
 *   - family ids → their exact catalogue casing
 *   - an exact variant uid (a run recorded at dispatch) → its family id
 *   - anything else → trimmed verbatim, so a custom id reaches
 *     `devin acp --model <id>` exactly as typed and fails visibly at the CLI
 *     if unknown rather than being silently substituted here.
 */
export function normalizeDevinModelId(raw: string | null | undefined): string {
  const trimmed = String(raw ?? '').trim()
  const key = trimmed.toLowerCase()
  if (DEVIN_DEFAULT_SENTINELS.has(key)) return DEVIN_DEFAULT_MODEL_ID
  return FAMILIES_BY_ID.get(key)?.id ?? VARIANTS_BY_UID.get(key)?.family.id ?? trimmed
}

/**
 * The exact `--model` value for one launch: fold (model, reasoning effort)
 * into the variant uid.
 *   - a family id + an effort the family offers → that variant
 *   - a family id + no/unsupported effort → the family default variant
 *   - an exact variant uid → itself, unless a different offered effort is
 *     requested explicitly (the effort control wins over a stale uid)
 *   - sentinels → the default family's default variant
 *   - anything else → trimmed verbatim (custom id)
 */
export function resolveDevinVariantId(
  modelRaw: string | null | undefined,
  effortRaw?: string | null
): string {
  const trimmed = String(modelRaw ?? '').trim()
  const key = trimmed.toLowerCase()
  const requested = normalizeDevinReasoningEffort(effortRaw)
  const family = DEVIN_DEFAULT_SENTINELS.has(key)
    ? FAMILIES_BY_ID.get(DEVIN_DEFAULT_MODEL_ID)
    : FAMILIES_BY_ID.get(key)
  if (family) {
    const match = requested
      ? family.variants.find((variant) => variant.effort === requested)
      : undefined
    return (match ?? family.variants[0]).uid
  }
  const recorded = VARIANTS_BY_UID.get(key)
  if (recorded) {
    const match = requested
      ? recorded.family.variants.find((variant) => variant.effort === requested)
      : undefined
    return (match ?? recorded.variant).uid
  }
  return trimmed
}
