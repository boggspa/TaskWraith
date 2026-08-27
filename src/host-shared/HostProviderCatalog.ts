/**
 * Canonical Node-safe provider catalog for the pure-Node Host.
 *
 * Adapted from src/main/providers/StaticProviderModels.ts (staticRowsForProvider
 * at 1159-1190, model rows at 375-468, 529-590, 593-617, 659-803, 884-905,
 * 919-1008, 1021-1028, 1030-1050). Desktop reuse is a named follow-up.
 *
 * This module is imported by the pure-Node Host and MUST NOT import from
 * src/main/** or src/renderer/**. It is the single source of truth for the
 * static model/reasoning/offer-revision data every live provider serves.
 */

import { createHash } from 'node:crypto'

import { LIVE_SELECTABLE_PROVIDER_IDS } from '../shared/retiredProviders'
import { KIMI_K27_MODEL_ID, KIMI_K3_256K_MODEL_ID, KIMI_K3_MODEL_ID } from '../shared/kimiModels'
import type {
  HostProviderAuthFlowProjection,
  HostProviderModelOffer,
  HostProviderOffersProjection,
  HostProviderStatusProjection,
  HostPermissionPostureOffer
} from '../shared/hostSetupProtocol'

export interface HostProviderCatalogEntry {
  readonly providerId: string
  readonly displayProvider: string
  readonly shortCode: string
  readonly models: readonly HostProviderModelOffer[]
  readonly postures: readonly HostPermissionPostureOffer[]
  readonly authFlows: readonly HostProviderAuthFlowProjection[]
}

const STANDARD_REASONING = [
  { reasoningId: 'low', label: 'Low', available: true },
  { reasoningId: 'medium', label: 'Medium', available: true },
  { reasoningId: 'high', label: 'High', available: true },
  { reasoningId: 'xhigh', label: 'Extra High', available: true }
] as const

const CLAUDE_REASONING = [
  ...STANDARD_REASONING,
  { reasoningId: 'max', label: 'Max', available: true },
  { reasoningId: 'ultracode', label: 'Ultracode', available: true }
] as const

const KIMI_REASONING = [
  { reasoningId: 'low', label: 'Low', available: true },
  { reasoningId: 'high', label: 'High', available: true },
  { reasoningId: 'max', label: 'Max', available: true }
] as const

const MUSE_REASONING = [
  { reasoningId: 'minimal', label: 'Minimal', available: true },
  { reasoningId: 'low', label: 'Low', available: true },
  { reasoningId: 'medium', label: 'Medium', available: true },
  { reasoningId: 'high', label: 'High', available: true },
  { reasoningId: 'xhigh', label: 'Extra High', available: true },
  { reasoningId: 'ultra', label: 'Ultra', available: true }
] as const

const POSTURES: readonly HostPermissionPostureOffer[] = [
  {
    postureId: 'read_only',
    label: 'Read only',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'read'
  },
  {
    postureId: 'plan',
    label: 'Plan',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'read'
  },
  {
    postureId: 'default',
    label: 'Default',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'workspace_write'
  },
  {
    postureId: 'workspace_write',
    label: 'Workspace write',
    available: true,
    requiresExplicitConsent: true,
    ceiling: 'workspace_write'
  }
]

function model(
  modelId: string,
  label: string,
  reasoning: readonly {
    reasoningId: string
    label: string
    available: boolean
  }[] = STANDARD_REASONING,
  isDefault = false
): HostProviderModelOffer {
  return {
    modelId,
    label,
    available: true,
    ...(isDefault ? { default: true } : {}),
    reasoning: reasoning.map((r) => ({ ...r }))
  }
}

const CATALOG: Readonly<Record<string, Omit<HostProviderCatalogEntry, 'providerId' | 'postures'>>> =
  {
    codex: {
      displayProvider: 'Codex',
      shortCode: 'CODEX',
      models: [
        model('gpt-5.6-sol', 'GPT-5.6-Sol'),
        model('gpt-5.6-terra', 'GPT-5.6-Terra'),
        model('gpt-5.6-luna', 'GPT-5.6-Luna'),
        model('gpt-5.5', 'GPT-5.5', STANDARD_REASONING, true),
        model('gpt-5.4', 'GPT-5.4'),
        model('gpt-5.4-mini', 'GPT-5.4 Mini'),
        model('gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark')
      ],
      authFlows: [{ flowId: 'codex:login', kind: 'manual', label: 'Sign in', available: true }]
    },
    claude: {
      displayProvider: 'Claude',
      shortCode: 'CL',
      models: [
        model('claude-opus-5', 'Opus 5', CLAUDE_REASONING),
        model('claude-fable-5', 'Fable 5', CLAUDE_REASONING),
        model('claude-sonnet-5', 'Sonnet 5', CLAUDE_REASONING, true),
        model('claude-sonnet-4-6', 'Sonnet 4.6 Legacy', CLAUDE_REASONING),
        model('claude-opus-4-8-1m', 'Opus 4.8 1M Legacy', CLAUDE_REASONING),
        model('claude-opus-4-7-1m', 'Opus 4.7 1M Legacy', CLAUDE_REASONING),
        model('claude-haiku-4-5', 'Haiku 4.5', [
          { reasoningId: 'low', label: 'Low', available: true },
          { reasoningId: 'medium', label: 'Medium', available: true },
          { reasoningId: 'high', label: 'High', available: true }
        ])
      ],
      authFlows: [{ flowId: 'claude:login', kind: 'manual', label: 'Sign in', available: true }]
    },
    kimi: {
      displayProvider: 'Kimi',
      shortCode: 'KIMI',
      models: [
        model(
          KIMI_K27_MODEL_ID,
          'K2.7 Coding',
          [{ reasoningId: 'on', label: 'On', available: true }],
          true
        ),
        model(KIMI_K3_MODEL_ID, 'K3 (up to 1M)', KIMI_REASONING),
        model(KIMI_K3_256K_MODEL_ID, 'K3 256K', KIMI_REASONING)
      ],
      authFlows: [{ flowId: 'kimi:login', kind: 'manual', label: 'Sign in', available: true }]
    },
    cursor: {
      displayProvider: 'Cursor',
      shortCode: 'CURSOR',
      models: [
        model('composer-2.5-fast', 'Composer 2.5 Fast', STANDARD_REASONING, true),
        model('composer-2.5', 'Composer 2.5', STANDARD_REASONING),
        model('cursor-grok-4.6', 'Cursor Grok 4.6', STANDARD_REASONING),
        model('cursor-grok-4.5', 'Cursor Grok 4.5', STANDARD_REASONING)
      ],
      authFlows: [{ flowId: 'cursor:login', kind: 'manual', label: 'Sign in', available: true }]
    },
    grok: {
      displayProvider: 'Grok',
      shortCode: 'GROK',
      models: [
        model('grok-4.6', 'Grok 4.6 Fast', STANDARD_REASONING, true),
        model('grok-4.5', 'Grok 4.5 Fast', STANDARD_REASONING),
        model('grok-composer-2.5-fast', 'Grok Composer 2.5 Fast', STANDARD_REASONING)
      ],
      authFlows: []
    },
    ollama: {
      displayProvider: 'Ollama',
      shortCode: 'OLLAMA',
      models: [
        model('qwen3:4b-instruct', 'Qwen 3 (4B Param)', STANDARD_REASONING, true),
        model('qwen3.5:2b', 'Qwen 3.5 (2B Param)', STANDARD_REASONING),
        model('qwen3.5:4b', 'Qwen 3.5 (4B Param)', STANDARD_REASONING),
        model('qwen3.5:9b', 'Qwen 3.5 (9B Param)', STANDARD_REASONING),
        model('qwen3.6:35b', 'Qwen 3.6 (35B-A3B)', STANDARD_REASONING),
        model('qwen3.8:27b-mlx', 'Qwen 3.8 (27B-MLX)', STANDARD_REASONING),
        model('gemma3:4b', 'Gemma 3 (4B Param)', STANDARD_REASONING),
        model('gemma4:12b', 'Gemma 4 (12B Param)', STANDARD_REASONING),
        model('gemma4:31b-mlx', 'Gemma 4 (31B-MLX)', STANDARD_REASONING),
        model('ornith:9b', 'Ornith 1.0 (9B Param)', STANDARD_REASONING),
        model('ornith:35b', 'Ornith 1.0 (35B Param)', STANDARD_REASONING),
        model('ornith-1.5:9b', 'Ornith 1.5 (9B Param)', STANDARD_REASONING),
        model('ornith-1.5:35b', 'Ornith 1.5 (35B Param)', STANDARD_REASONING),
        model('laguna-xs-2.1:q8_0', 'Laguna XS 2.1 (33B-A3B Q8)', STANDARD_REASONING),
        model('gpt-oss:20b', 'GPT OSS (20B Param)', STANDARD_REASONING),
        model('lfm2.5-thinking:1.2b', 'LFM 2.5 Thinking (1.2B Param)', STANDARD_REASONING),
        model('lfm2.5:8b', 'LFM 2.5 (8B-A1B)', STANDARD_REASONING),
        model('minicpm-v4.5:8b', 'MiniCPM-V 4.5 (8B Param)', STANDARD_REASONING),
        model('granite4:3b', 'Granite 4.0 (3B Param)', STANDARD_REASONING),
        model('granite4.1:3b', 'Granite 4.1 (3B Param)', STANDARD_REASONING),
        model('granite4.1:30b', 'Granite 4.1 (30B Param)', STANDARD_REASONING)
      ],
      authFlows: [{ flowId: 'ollama:login', kind: 'manual', label: 'Sign in', available: true }]
    },
    pi: {
      displayProvider: 'Pi',
      shortCode: 'PI',
      models: [
        model('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', STANDARD_REASONING, true),
        model('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash', STANDARD_REASONING),
        model('zai/glm-5.2', 'GLM-5.2', STANDARD_REASONING),
        model('zai/glm-5.1', 'GLM-5.1', STANDARD_REASONING),
        model('zai/glm-4.7', 'GLM-4.7', STANDARD_REASONING),
        model('qwen-token-plan/qwen3.7-max', 'Qwen3.7 Max', STANDARD_REASONING),
        model('qwen-token-plan/qwen3.7-plus', 'Qwen3.7 Plus', STANDARD_REASONING),
        model('qwen-token-plan/qwen3.8-max', 'Qwen3.8 Max', STANDARD_REASONING),
        model('minimax/MiniMax-M3', 'MiniMax M3', STANDARD_REASONING),
        model('minimax/MiniMax-M2.7', 'MiniMax M2.7', STANDARD_REASONING),
        model('xiaomi-token-plan-cn/mimo-v2-pro', 'MiMo V2 Pro (CN)', STANDARD_REASONING),
        model('xiaomi-token-plan-cn/mimo-v2.5', 'MiMo V2.5 (CN)', STANDARD_REASONING),
        model('xiaomi-token-plan-cn/mimo-v2.5-pro', 'MiMo V2.5 Pro (CN)', STANDARD_REASONING),
        model('xiaomi-token-plan-sgp/mimo-v2-pro', 'MiMo V2 Pro (SGP)', STANDARD_REASONING),
        model('xiaomi-token-plan-sgp/mimo-v2.5', 'MiMo V2.5 (SGP)', STANDARD_REASONING),
        model('xiaomi-token-plan-sgp/mimo-v2.5-pro', 'MiMo V2.5 Pro (SGP)', STANDARD_REASONING),
        model('xiaomi-token-plan-ams/mimo-v2-pro', 'MiMo V2 Pro (AMS)', STANDARD_REASONING),
        model('xiaomi-token-plan-ams/mimo-v2.5', 'MiMo V2.5 (AMS)', STANDARD_REASONING),
        model('xiaomi-token-plan-ams/mimo-v2.5-pro', 'MiMo V2.5 Pro (AMS)', STANDARD_REASONING),
        model('mistral/zai-glm-5-2', 'GLM-5.2 (via Mistral)', STANDARD_REASONING),
        model('mistral/mistral-medium-3.5', 'Mistral Medium 3.5', STANDARD_REASONING),
        model('mistral/mistral-medium-latest', 'Mistral Medium (Latest)', STANDARD_REASONING),
        model('mistral/mistral-small-2603', 'Mistral Small 4', STANDARD_REASONING),
        model('mistral/mistral-large-2512', 'Mistral Large 3', STANDARD_REASONING),
        model('mistral/devstral-2512', 'Devstral 2', STANDARD_REASONING),
        model('mistral/codestral-2508', 'Codestral (Aug 2025)', STANDARD_REASONING),
        model('mistral/labs-leanstral-1-5', 'Leanstral 1.5 (Labs)', STANDARD_REASONING),
        model('mistral/mistral-medium-2508', 'Mistral Medium 3.1', STANDARD_REASONING),
        model('mistral/mistral-medium-2505', 'Mistral Medium 3', STANDARD_REASONING),
        model('mistral/ministral-14b-2512', 'Ministral 3 (14B)', STANDARD_REASONING),
        model('mistral/ministral-8b-2512', 'Ministral 3 (8B)', STANDARD_REASONING),
        model('mistral/ministral-3b-2512', 'Ministral 3 (3B)', STANDARD_REASONING),
        model('groq/openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', STANDARD_REASONING),
        model('groq/qwen/qwen3-32b', 'Qwen3 32B (Groq)', STANDARD_REASONING),
        model('cerebras/zai-glm-4.7', 'GLM-4.7 (Cerebras)', STANDARD_REASONING),
        model('cerebras/gpt-oss-120b', 'GPT-OSS 120B (Cerebras)', STANDARD_REASONING),
        model('openrouter/stealth/ox-alpha', 'Ox Alpha', STANDARD_REASONING),
        model('openrouter/zai/glm-5.2', 'GLM 5.2', STANDARD_REASONING),
        model('openrouter/poolside/laguna-s-2.1', 'Laguna S 2.1', STANDARD_REASONING)
      ],
      authFlows: []
    },
    mistral: {
      displayProvider: 'Mistral',
      shortCode: 'MISTRAL',
      models: [
        model('devstral-small', 'Devstral Small', STANDARD_REASONING, true),
        model('mistral-medium-3.5', 'Mistral Medium 3.5', STANDARD_REASONING),
        model('mistral-large-2512', 'Mistral Large 3', STANDARD_REASONING),
        model('zai-glm-5-2', 'GLM-5.2 (via Mistral)', STANDARD_REASONING),
        model('codestral-2508', 'Codestral (Aug 2025)', STANDARD_REASONING),
        model('mistral-small-2603', 'Mistral Small 4', STANDARD_REASONING),
        model('devstral-2512', 'Devstral 2', STANDARD_REASONING),
        model('labs-leanstral-1-5', 'Leanstral 1.5 (Labs)', STANDARD_REASONING),
        model('mistral-medium-latest', 'Mistral Medium (Latest)', STANDARD_REASONING),
        model('mistral-medium-2508', 'Mistral Medium 3.1', STANDARD_REASONING),
        model('mistral-medium-2505', 'Mistral Medium 3', STANDARD_REASONING),
        model('ministral-14b-2512', 'Ministral 3 (14B)', STANDARD_REASONING),
        model('ministral-8b-2512', 'Ministral 3 (8B)', STANDARD_REASONING),
        model('ministral-3b-2512', 'Ministral 3 (3B)', STANDARD_REASONING)
      ],
      authFlows: [{ flowId: 'mistral:login', kind: 'manual', label: 'Sign in', available: true }]
    },
    muse: {
      displayProvider: 'Muse',
      shortCode: 'MUSE',
      models: [model('muse-spark-1.2', 'Muse Spark 1.2', MUSE_REASONING, true)],
      authFlows: [{ flowId: 'muse:login', kind: 'manual', label: 'Sign in', available: true }]
    }
  }

function hashEntry(entry: Omit<HostProviderCatalogEntry, 'providerId'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        models: entry.models.map((m) => ({
          modelId: m.modelId,
          label: m.label,
          available: m.available,
          default: m.default === true,
          reasoning: m.reasoning.map((r) => ({
            reasoningId: r.reasoningId,
            label: r.label,
            available: r.available
          }))
        })),
        postures: entry.postures.map((p) => ({
          postureId: p.postureId,
          label: p.label,
          available: p.available,
          requiresExplicitConsent: p.requiresExplicitConsent,
          ceiling: p.ceiling
        }))
      })
    )
    .digest('hex')
}

/** Full static catalog entry for one live provider. */
export function hostProviderCatalogEntry(providerId: string): HostProviderCatalogEntry | null {
  const entry = CATALOG[providerId]
  if (!entry) return null
  return {
    providerId,
    displayProvider: entry.displayProvider,
    shortCode: entry.shortCode,
    models: entry.models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      available: m.available,
      ...(m.default === true ? { default: true } : {}),
      reasoning: m.reasoning.map((r) => ({ ...r }))
    })),
    postures: POSTURES.map((p) => ({ ...p })),
    authFlows: entry.authFlows.map((f) => ({ ...f }))
  }
}

/** Offers projection for one provider, derived from the static catalog. */
export function hostProviderOffers(
  providerId: string,
  available: boolean
): HostProviderOffersProjection | null {
  const entry = hostProviderCatalogEntry(providerId)
  if (!entry) return null
  return {
    providerId,
    offerRevision: hashEntry(entry),
    models: entry.models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      available: m.available && available,
      ...(m.default === true ? { default: true } : {}),
      reasoning: m.reasoning.map((r) => ({
        reasoningId: r.reasoningId,
        label: r.label,
        available: r.available && available
      }))
    })),
    postures: entry.postures.map((p) => ({ ...p, available: p.available && available }))
  }
}

/** Status projection for one provider. */
export function hostProviderStatus(
  providerId: string,
  available: boolean,
  configured: boolean
): HostProviderStatusProjection | null {
  const entry = hostProviderCatalogEntry(providerId)
  if (!entry) return null
  return {
    providerId,
    status: !available ? 'unavailable' : configured ? 'ready' : 'auth_required',
    label: entry.displayProvider
  }
}

/** Auth-flow projections for one provider. */
export function hostProviderAuthFlows(
  providerId: string
): readonly HostProviderAuthFlowProjection[] {
  const entry = hostProviderCatalogEntry(providerId)
  return entry ? entry.authFlows.map((f) => ({ ...f })) : []
}

/** All live provider ids in canonical order. */
export function hostProviderCatalogIds(): readonly string[] {
  return [...LIVE_SELECTABLE_PROVIDER_IDS]
}

/** True when the catalog has a static entry for this provider. */
export function hasHostProviderCatalogEntry(providerId: string): boolean {
  return providerId in CATALOG
}
