/**
 * Per-model reasoning ladders for the Pi seat.
 *
 * Pi's `--thinking` flag takes a fixed vocabulary, and TaskWraith offered all
 * of it to every model. That is wrong in both directions: several upstreams
 * expose no effort control at all (Qwen uses a token budget, MiniMax and MiMo
 * are plain booleans), several accept an effort but collapse most of it onto
 * one tier, and two of them reason unconditionally while still accepting a
 * "disable" flag they ignore. A stop the upstream discards is worse than no
 * stop, because the user believes they changed something.
 *
 * Keyed by TaskWraith wire id (`<upstream>/<modelId>`), because the SAME model
 * has different controls per route — GLM-5.2 direct from Z.ai exposes High and
 * Max, while OpenRouter's copy exposes High and Extra High.
 *
 * An unlisted id keeps the full ladder. A newly registered model must not be
 * silently stripped of a control it may well support.
 */

export type PiReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface PiReasoningSupport {
  readonly kind: 'unsupported' | 'levels'
  /** Complete offered ladder, lowest first; `off` only when it is real. */
  readonly efforts: readonly PiReasoningEffort[]
  readonly defaultEffort: PiReasoningEffort | null
  /** False for upstreams that reason on every turn regardless of the flag. */
  readonly canDisable: boolean
}

/** The historical ladder, still correct for a model we have not researched. */
export const PI_FULL_LADDER: readonly PiReasoningEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

const UNSUPPORTED: PiReasoningSupport = Object.freeze({
  kind: 'unsupported',
  efforts: [],
  defaultEffort: null,
  canDisable: false
})

function ladder(
  efforts: readonly PiReasoningEffort[],
  defaultEffort: PiReasoningEffort,
  canDisable = true
): PiReasoningSupport {
  return Object.freeze({
    kind: 'levels',
    efforts: canDisable ? (['off', ...efforts] as const) : efforts,
    defaultEffort,
    canDisable
  })
}

/** Upstream exposes on/off only — one meaningful stop plus Off. */
const BOOLEAN = ladder(['high'], 'high')
/** Reasons on every turn; the disable flag is accepted and ignored. */
const ALWAYS_ON = ladder(['high'], 'high', false)

const PI_MODEL_REASONING: Readonly<Record<string, PiReasoningSupport>> = {
  // DeepSeek: low/high/max, default high. `medium` and `xhigh` are documented
  // aliases for `high`, so surfacing them would be a fake distinction.
  'deepseek/deepseek-v4-pro': ladder(['low', 'high', 'max'], 'high'),
  'deepseek/deepseek-v4-flash': ladder(['low', 'high', 'max'], 'high'),

  // Z.ai documents seven efforts that collapse to three outcomes:
  // none/minimal skip thinking, low+medium map to high, xhigh maps to max.
  'zai/glm-5.2': ladder(['high', 'max'], 'max'),
  // `reasoning_effort` is "GLM-5.2 and above" — 5.1 is on/off only.
  'zai/glm-5.1': BOOLEAN,
  // Forced thinking. `thinking.type: "disabled"` is accepted and ignored, so
  // an Off stop here would silently do nothing.
  'zai/glm-4.7': ALWAYS_ON,

  // Qwen has no named ladder at all — `enable_thinking` plus a
  // `thinking_budget` token count. Off is real; the levels are not.
  'qwen-token-plan/qwen3.7-max': BOOLEAN,
  'qwen-token-plan/qwen3.7-plus': BOOLEAN,
  'qwen-token-plan/qwen3.8-max': BOOLEAN,

  // MiniMax M3 takes adaptive/disabled. M2.x documents that thinking stays on
  // whatever the flag says.
  'minimax/MiniMax-M3': BOOLEAN,
  'minimax/MiniMax-M2.7': ALWAYS_ON,

  // MiMo is `thinking.type` enabled/disabled with no effort control.
  'xiaomi-token-plan-cn/mimo-v2-pro': BOOLEAN,
  'xiaomi-token-plan-cn/mimo-v2.5': BOOLEAN,
  'xiaomi-token-plan-cn/mimo-v2.5-pro': BOOLEAN,
  'xiaomi-token-plan-sgp/mimo-v2-pro': BOOLEAN,
  'xiaomi-token-plan-sgp/mimo-v2.5': BOOLEAN,
  'xiaomi-token-plan-sgp/mimo-v2.5-pro': BOOLEAN,
  'xiaomi-token-plan-ams/mimo-v2-pro': BOOLEAN,
  'xiaomi-token-plan-ams/mimo-v2.5': BOOLEAN,
  'xiaomi-token-plan-ams/mimo-v2.5-pro': BOOLEAN,

  // Mistral documents `high` and `none` for its own reasoning models. The raw
  // schema enum is wider, but only those two have defined semantics.
  'mistral/mistral-medium-3.5': BOOLEAN,
  'mistral/mistral-medium-latest': BOOLEAN,
  'mistral/mistral-small-2603': BOOLEAN,
  // Mistral's hosted GLM-5.2 declares a `Reasoning output` modality and is
  // served without Mistral modifications. Its effort control is undocumented
  // on this route, so it gets the on/off surface we can actually stand behind.
  'mistral/zai-glm-5-2': BOOLEAN,
  'mistral/mistral-large-2512': UNSUPPORTED,
  'mistral/devstral-2512': UNSUPPORTED,
  'mistral/codestral-2508': UNSUPPORTED,
  'mistral/labs-leanstral-1-5': UNSUPPORTED,
  'mistral/mistral-medium-2508': UNSUPPORTED,
  'mistral/mistral-medium-2505': UNSUPPORTED,
  'mistral/ministral-14b-2512': UNSUPPORTED,
  'mistral/ministral-8b-2512': UNSUPPORTED,
  'mistral/ministral-3b-2512': UNSUPPORTED,

  // GPT-OSS reasoning cannot be switched off on either host — neither enum
  // carries a `none`; it can only be hidden from the response.
  'groq/openai/gpt-oss-120b': ladder(['low', 'medium', 'high'], 'medium', false),
  'cerebras/gpt-oss-120b': ladder(['low', 'medium', 'high'], 'medium', false),
  'groq/qwen/qwen3-32b': BOOLEAN,
  'cerebras/zai-glm-4.7': ALWAYS_ON,

  // OpenRouter advertises per-model `supported_efforts`, and GLM-5.2's copy is
  // High and Extra High — a different pair from Z.ai's own High and Max.
  'openrouter/z-ai/glm-5.2': ladder(['high', 'xhigh'], 'high'),
  // Reasoning model, but it advertises no effort values at all.
  'openrouter/poolside/laguna-s-2.1': BOOLEAN,
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': ladder(['medium', 'high'], 'high')
}

const FULL: PiReasoningSupport = Object.freeze({
  kind: 'levels',
  efforts: PI_FULL_LADDER,
  defaultEffort: 'medium',
  canDisable: true
})

/**
 * An unlisted OR unset id keeps the full ladder. Unset is the seat-level
 * question ("what can Pi do?"), which must stay the union rather than collapse
 * to nothing before a model is chosen.
 */
export function resolvePiReasoningSupport(wireId?: string | null): PiReasoningSupport {
  const id = String(wireId || '').trim()
  if (!id) return FULL
  return PI_MODEL_REASONING[id] ?? FULL
}
