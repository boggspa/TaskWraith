/*
 * composerChipFormat.ts — per-shell text formatter for the combined
 * model + reasoning chip in the composer.
 *
 * Real Codex shows `5.5 Extra High` (model digit + capitalised
 * reasoning level). Real Claude shows `Opus 4.7 · Max` (model name +
 * effort capped at "Max"). Real Kimi shows `K2.7 Coding` or `K3 Max`.
 * Each upstream product has its own convention; this module captures
 * those rules in pure functions so the rendering surface stays dumb.
 *
 * No React, no IPC. Pure data transforms — easy to test.
 */

import type { ProviderId, ComposerStyle } from '../../../main/store/types'
import { antigravityGeminiApiModelDisplayLabel } from '../../../shared/antigravityGeminiApiModelNaming'
import { antigravityEffortForModelId } from '../../../shared/antigravityAgyModelGrouping'
import {
  isCursorGrok45ModelId,
  isGrok45ReasoningModelId
} from '../../../shared/grok45Models'

export interface ComposerChipContext {
  provider: ProviderId
  composerStyle: ComposerStyle
  /** Model id (e.g. "gpt-5.5", "claude-opus-4-7-thinking"). */
  modelId: string
  /** Human-readable model label as it appears in the existing model picker. */
  modelLabel: string
  /** Codex reasoning effort token (e.g. "low"/"light" | "medium" | "high" | "xhigh"). */
  codexReasoningEffort?: string
  /** Claude reasoning effort token (e.g. "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"). */
  claudeReasoningEffort?: string
  /** Grok reasoning effort token (e.g. "low" | "medium" | "high"). */
  grokReasoningEffort?: string
  /** Cursor Grok reasoning effort token (e.g. "low" | "medium" | "high"). */
  cursorReasoningEffort?: string
  /** Kimi thinking toggle (boolean). */
  kimiThinkingEnabled?: boolean
  /** K3 thinking effort token (low/high/max). */
  kimiReasoningEffort?: string
  /** Claude composer shell only — render explicit "Fast" between model +
   * reasoning for Claude/Codex tier toggles and Cursor composer-2.5-fast. */
  shellFastModeActive?: boolean
}

/**
 * Extract a short, idiomatic model name per provider convention.
 *
 * Codex (`gpt-5.5`, `gpt-5.4-mini`)        → `5.5`, `5.4-Mini`
 * Claude (`claude-opus-4-7-1m`)            → `Opus 4.7 1M`
 * Kimi (`kimi-k2.7-code`, `kimi-k2.7-code-thinking`) → `K2.7 Coding`
 * Kimi (`kimi-k3`)                         → `K3`
 * Gemini (`gemini-2.5-pro`)                → `2.5 Pro`
 * Cursor (`grok-4.5`)                      → `Grok 4.5`
 * Grok (`grok-4.5`)                        → `Grok 4.5 Fast` (permanently Fast-mode)
 * Ollama (`qwen3:4b-instruct`)             → `Qwen 3 (4B Param)`
 *
 * Falls back to the full label when no provider-specific pattern matches.
 */
export function shortModelName(provider: ProviderId, modelLabel: string, modelId: string): string {
  const id = (modelId || '').toLowerCase()
  const label = modelLabel || modelId

  // Legacy persisted chats can still contain the old generic sentinel. Display
  // the concrete TaskWraith default so badges do not reintroduce a fake model.
  if (id === 'cli-default') {
    if (provider === 'codex') return '5.5'
    if (provider === 'claude') return 'Sonnet 4.6'
    if (provider === 'kimi') return 'K2.7 Coding'
    if (provider === 'grok') return 'Grok 4.5 Fast'
    if (provider === 'cursor') return 'Composer 2.5 Fast'
    if (provider === 'ollama') return 'Qwen 3 (4B Param)'
    if (provider === 'gemini') return 'Flash Lite'
    return label
  }

  if (provider === 'codex') {
    // gpt-5.5 → 5.5; gpt-5.4-mini → 5.4-Mini; gpt-5.3-codex-spark → 5.3-Codex-Spark
    const match = id.match(/^gpt-([\d.]+)(.*)$/)
    if (match) {
      const version = match[1]
      const suffix = match[2]
        .replace(/^-/, '')
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('-')
      return suffix ? `${version}-${suffix}` : version
    }
  }

  if (provider === 'claude') {
    // claude-opus-4-7, claude-sonnet-4-6-thinking → Opus 4.7 / Sonnet 4.6.
    // Fable/Mythos use a single version digit (claude-fable-5 → Fable 5); the
    // minor-version group is optional with a `$|-` lookahead so the `-1m`
    // context marker is never mis-read as a minor version (claude-fable-5-1m
    // must be Fable 5, not Fable 5.1).
    const match = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?(?=$|-)/)
    if (match) {
      const family = match[1].charAt(0).toUpperCase() + match[1].slice(1)
      const version = match[3] ? `${match[2]}.${match[3]}` : match[2]
      const contextSuffix = id.endsWith('-1m') ? ' 1M' : ''
      return `${family} ${version}${contextSuffix}`
    }
  }

  if (provider === 'kimi') {
    // kimi-k2.7-code, kimi-k2.7-code-thinking → K2.7 Coding. The explicit branch
    // exists because the generic version matcher below would drop " Coding";
    // plain version ids (kimi-k3 → K3, kimi-k2.6 → K2.6) fall through to it.
    if (id.startsWith('kimi-k2.7-code')) return 'K2.7 Coding'
    const match = id.match(/^kimi-(k[\d.]+)/)
    if (match) {
      return match[1].toUpperCase()
    }
  }

  if (provider === 'gemini') {
    // gemini-2.5-pro, gemini-flash-lite, gemini-1.5-flash → 2.5 Pro / Flash Lite / 1.5 Flash
    const match = id.match(/^gemini-(.+)$/)
    if (match) {
      return match[1]
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
    }
  }

  if (provider === 'antigravity') {
    // Key-lane ids (`gemini-api:gemini-2.5-flash`) → the exact catalog label
    // (`2.5 Flash`); agy-lane ids fall through to the label like any provider.
    const apiLabel = antigravityGeminiApiModelDisplayLabel(id)
    if (apiLabel) return apiLabel
  }

  if (provider === 'cursor') {
    // composer-2.5-fast (Cursor's default = Fast mode) / composer-2.5 → human label.
    if (id === 'composer-2.5-fast') return 'Composer 2.5 Fast'
    if (id === 'composer-2.5') return 'Composer 2.5'
    if (id === 'grok-4.5' || id === 'cursor-grok-4.5' || id.startsWith('grok-4.5')) {
      return 'Grok 4.5'
    }
  }

  if (provider === 'grok') {
    // Grok's CLI models are permanently Fast-mode, so "Fast" is part of the name.
    if (id === 'grok-4.5' || id === 'grok-4.5-latest' || id === 'grok-build-latest') {
      return 'Grok 4.5 Fast'
    }
    if (id === 'grok-composer-2.5-fast') return 'Grok Composer 2.5 Fast'
    if (id === 'grok-build' || id === 'grok-build-0.1') return 'Grok 4.5 Fast'
  }

  if (provider === 'ollama') {
    if (id === 'qwen3:4b-instruct') return 'Qwen 3 (4B Param)'
    if (id === 'qwen3.5:2b' || id.startsWith('qwen3.5:2b-')) {
      return 'Qwen 3.5 (2B Param)'
    }
    if (id === 'qwen3.5:4b' || id.startsWith('qwen3.5:4b-')) {
      return 'Qwen 3.5 (4B Param)'
    }
    if (id === 'qwen3.5:9b' || id.startsWith('qwen3.5:9b-')) {
      return 'Qwen 3.5 (9B Param)'
    }
    if (id === 'qwen3.6:35b' || id.startsWith('qwen3.6:35b-')) {
      return 'Qwen 3.6 (35B-A3B)'
    }
    if (id === 'gemma3:4b' || id.startsWith('gemma3:4b-')) {
      return 'Gemma 3 (4B Param)'
    }
    if (id === 'gemma4:12b' || id.startsWith('gemma4:12b-')) {
      return 'Gemma 4 (12B Param)'
    }
    if (
      id === 'ornith' ||
      id === 'ornith:latest' ||
      id === 'ornith:9b' ||
      id.startsWith('ornith:9b-')
    ) {
      return 'Ornith 1.0 (9B Param)'
    }
    if (id === 'ornith:35b' || id.startsWith('ornith:35b-')) {
      return 'Ornith 1.0 (35B Param)'
    }
    if (id === 'laguna-xs-2.1:q8_0') {
      return 'Laguna XS 2.1 (33B-A3B Q8)'
    }
    if (
      id === 'gpt-oss' ||
      id === 'gpt-oss:20b' ||
      id === 'gpt-oss:latest' ||
      id === 'openai/gpt-oss-20b'
    ) {
      return 'GPT OSS (20B Param)'
    }
    if (id === 'lfm2.5-thinking:1.2b' || id.startsWith('lfm2.5-thinking:1.2b-')) {
      return 'LFM 2.5 Thinking (1.2B Param)'
    }
    if (
      id === 'lfm2.5' ||
      id === 'lfm2.5:latest' ||
      id === 'lfm2.5:8b' ||
      id.startsWith('lfm2.5:8b-')
    ) {
      return 'LFM 2.5 (8B-A1B)'
    }
    if (id === 'minicpm-v4.5:8b' || id.startsWith('minicpm-v4.5:8b-')) {
      return 'MiniCPM-V 4.5 (8B Param)'
    }
    if (id === 'granite4:3b' || id.startsWith('granite4:3b-')) {
      return 'Granite 4.0 (3B Param)'
    }
    if (id === 'granite4.1:3b' || id.startsWith('granite4.1:3b-')) {
      return 'Granite 4.1 (3B Param)'
    }
    if (id === 'granite4.1:30b' || id.startsWith('granite4.1:30b-')) {
      return 'Granite 4.1 (30B Param)'
    }
    if (id === 'nemotron-3-nano:4b' || id.startsWith('nemotron-3-nano:4b-')) {
      return 'Nemotron 3 Nano (4B Param)'
    }
    if (id === 'nemotron3:33b' || id.startsWith('nemotron3:33b-')) {
      return 'Nemotron 3 Nano Omni (33B Param)'
    }
    if (id === 'devstral-small-2:24b' || id.startsWith('devstral-small-2:24b-')) {
      return 'Devstral Small 2 (24B Param)'
    }
    if (id === 'ministral-3:3b' || id.startsWith('ministral-3:3b-')) {
      return 'Ministral 3 (3B Param)'
    }
    if (id === 'ministral-3:14b' || id.startsWith('ministral-3:14b-')) {
      return 'Ministral 3 (14B Param)'
    }
    if (id === 'llama3.1:8b' || id.startsWith('llama3.1:8b-')) {
      return 'Llama 3.1 (8B Param)'
    }
    if (id === 'deepseek-r1:1.5b' || id.startsWith('deepseek-r1:1.5b-')) {
      return 'DeepSeek R1 (1.5B Param)'
    }
    if (id === 'deepseek-r1:8b' || id.startsWith('deepseek-r1:8b-')) {
      return 'DeepSeek R1 (8B Param)'
    }
    if (id === 'rnj-1' || id === 'rnj-1:latest' || id === 'rnj-1:8b') {
      return 'Rnj-1 (8B Param)'
    }
    if (id === 'glm-4.7-flash:q4_k_m' || id.startsWith('glm-4.7-flash:q4_k_m-')) {
      return 'GLM-4.7-Flash (30B-A3B Q4)'
    }
    if (
      id === 'north-mini-code-1.0:q4_k_m' ||
      id.startsWith('north-mini-code-1.0:q4_k_m-')
    ) {
      return 'North Mini Code 1.0 (30B-A3B Q4)'
    }
    if (id === 'llama3.2:3b' || id.startsWith('llama3.2:3b-')) {
      return 'Llama 3.2 (3B Param)'
    }
  }

  return label
}

/**
 * Reasoning-level display per provider's product convention.
 *
 * Codex: `Light` / `Medium` / `High` / `Extra High` (low/light → "Light"; xhigh → "Extra High")
 * Claude: `Low` / `Medium` / `High` / `Extra` / `Max` / `Ultracode`
 * Grok/Cursor Grok: `Low` / `Medium` / `High`
 * Kimi: K3's `Low`/`High`/`Max`; K2.7 Coding's fixed `Thinking`
 * Gemini: no reasoning concept today — returns empty
 *
 * `off` always returns empty so the chip omits the reasoning suffix.
 */
export function reasoningDisplayLabel(ctx: ComposerChipContext): string {
  const { provider } = ctx

  if (provider === 'codex') {
    return codexReasoningDisplayLabel(ctx.codexReasoningEffort)
  }

  if (provider === 'claude') {
    return claudeReasoningDisplayLabel(ctx.claudeReasoningEffort)
  }

  if (provider === 'kimi') {
    if (ctx.modelId.trim().toLowerCase() === 'kimi-k3') {
      return kimiReasoningDisplayLabel(ctx.kimiReasoningEffort)
    }
    return ctx.kimiThinkingEnabled ? 'Thinking' : ''
  }

  if (provider === 'grok') {
    return isGrok45ReasoningModelId(ctx.modelId)
      ? grokReasoningDisplayLabel(ctx.grokReasoningEffort)
      : ''
  }

  if (provider === 'cursor') {
    return isCursorGrok45ModelId(ctx.modelId)
      ? grokReasoningDisplayLabel(ctx.cursorReasoningEffort)
      : ''
  }

  if (provider === 'antigravity') {
    // The reasoning level is encoded in the concrete wire id
    // (gemini-3.6-flash-high); the picker groups families and the slider
    // swaps variants, so the chip suffix reads straight off the id.
    const effort = antigravityEffortForModelId(ctx.modelId)
    return effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : ''
  }

  // Mistral Medium 3.5 (Vibe seat + Pi BYOK mirror) is fixed at High thinking
  // — vibe-acp schema pin / known upstream default. Not user-adjustable, but
  // the compact chip still names the level so it matches the locked ladder.
  const modelId = ctx.modelId.trim().toLowerCase()
  if (provider === 'mistral' && modelId === 'mistral-medium-3.5') return 'High'
  if (provider === 'pi' && modelId === 'mistral/mistral-medium-3.5') return 'High'

  return ''
}

export function kimiReasoningDisplayLabel(effortValue?: string | null): string {
  const effort = (effortValue || '').trim().toLowerCase()
  if (effort === 'low') return 'Low'
  if (effort === 'high') return 'High'
  if (effort === 'max') return 'Max'
  return ''
}

export function codexReasoningDisplayLabel(effortValue?: string | null): string {
  const effort = (effortValue || '').toLowerCase()
  if (!effort || effort === 'off') return ''
  if (effort === 'xhigh') return 'Extra High'
  if (effort === 'low' || effort === 'light') return 'Light'
  if (effort === 'medium') return 'Medium'
  if (effort === 'high') return 'High'
  // The top two Codex tiers — as of GPT-5.6 GA, `max` exists on all three
  // models and `ultra` on Sol + Terra. Codex names its top mode "Ultra"
  // (official OpenAI tier id); it still coalesces onto Claude's shared
  // "ultracode" ladder stop on the iOS reasoning slider.
  if (effort === 'max') return 'Max'
  if (effort === 'ultracode') return 'Ultra'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function claudeReasoningDisplayLabel(effortValue?: string | null): string {
  const effort = (effortValue || '').toLowerCase()
  if (!effort || effort === 'off') return ''
  if (effort === 'low') return 'Low'
  if (effort === 'medium') return 'Medium'
  if (effort === 'high') return 'High'
  if (effort === 'xhigh' || effort === 'extra') return 'Extra'
  if (effort === 'max') return 'Max'
  if (effort === 'ultracode') return 'Ultracode'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function grokReasoningDisplayLabel(effortValue?: string | null): string {
  const effort = (effortValue || '').toLowerCase()
  if (!effort || effort === 'off') return ''
  if (effort === 'low') return 'Low'
  if (effort === 'medium') return 'Medium'
  if (effort === 'high') return 'High'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** Model label for the Claude composer shell chip — strips a trailing "Fast"
 * from Cursor's composer-2.5-fast id so "Fast" can render as its own segment.
 * Codex models use the marketing-style `GPT 5.5` / `GPT 5.4` prefix here (the
 * native Codex shell keeps the bare `5.5` convention via `shortModelName`). */
export function resolveClaudeShellModelLabel(
  provider: ProviderId,
  modelLabel: string,
  modelId: string,
  shellFastModeActive: boolean
): string {
  if (provider === 'cursor' && shellFastModeActive && modelId === 'composer-2.5-fast') {
    return 'Composer 2.5'
  }
  const short = shortModelName(provider, modelLabel, modelId)
  if (provider === 'codex') {
    return `GPT ${short}`
  }
  return short
}

function formatClaudeShellChip(
  provider: ProviderId,
  modelLabel: string,
  modelId: string,
  reasoning: string,
  shellFastModeActive: boolean
): string {
  const short = resolveClaudeShellModelLabel(provider, modelLabel, modelId, shellFastModeActive)
  const fast = shellFastModeActive ? 'Fast' : ''
  if (fast && reasoning) return `${short} · ${fast} ${reasoning}`
  if (fast) return `${short} · ${fast}`
  return reasoning ? `${short} · ${reasoning}` : short
}

/**
 * Compose the chip text. Per-shell native format when the shell is
 * themed for that provider (Codex shell + Codex provider → real-Codex
 * convention); otherwise a sensible cross-shell default.
 *
 * Examples:
 *   Codex shell + codex provider + xhigh   → `5.5 Extra High`
 *   Claude shell + claude provider + high  → `Opus 4.7 · High`
 *   Claude shell + claude + fast + extra  → `Opus 4.8 · Fast Extra`
 *   Claude shell + codex + fast + xhigh   → `GPT 5.5 · Fast Extra High`
 *   Claude shell + cursor fast model      → `Composer 2.5 · Fast`
 *   Kimi shell + kimi provider + on        → `K2.7 Coding Thinking`
 *   TaskWraith shell + codex + high           → `GPT-5.5 · High`
 *   TaskWraith shell + kimi + on              → `Kimi K2.7 Coding · Thinking`
 */
export function formatComposerModelChip(ctx: ComposerChipContext): string {
  const { provider, composerStyle, modelLabel, modelId } = ctx
  const reasoning = reasoningDisplayLabel(ctx)

  // Claude composer shell uses one chip layout for every provider — explicit
  // "Fast" segment between model + reasoning when the active provider supports
  // it (Claude/Codex tier toggle, Cursor composer-2.5-fast model).
  if (composerStyle === 'claude') {
    return formatClaudeShellChip(
      provider,
      modelLabel,
      modelId,
      reasoning,
      Boolean(ctx.shellFastModeActive)
    )
  }

  const shellMatchesProvider =
    (composerStyle === 'codex' && provider === 'codex') ||
    (composerStyle === 'kimi' && provider === 'kimi') ||
    (composerStyle === 'gemini' && provider === 'gemini') ||
    (composerStyle === 'grok' && provider === 'grok') ||
    (composerStyle === 'cursor' && provider === 'cursor')

  // Per-shell native format — only when the shell is themed FOR the
  // active provider. Mixed combinations fall back to the TaskWraith
  // default so the chip is always readable.
  if (shellMatchesProvider) {
    const short =
      provider === 'cursor' && ctx.shellFastModeActive && modelId === 'composer-2.5-fast'
        ? 'Composer 2.5'
        : shortModelName(provider, modelLabel, modelId)
    if (provider === 'codex') {
      return reasoning ? `${short} ${reasoning}` : short
    }
    if (provider === 'kimi') {
      return reasoning ? `${short} ${reasoning}` : short
    }
    if (provider === 'gemini') {
      return short
    }
    if (provider === 'grok' || provider === 'cursor') {
      const fast = ctx.shellFastModeActive ? 'Fast' : ''
      if (fast && reasoning) return `${short} ${reasoning} ${fast}`
      if (fast) return `${short} ${fast}`
      return reasoning ? `${short} ${reasoning}` : short
    }
  }

  // Default (TaskWraith native shell, mismatched shell/provider, or
  // creative shells: modular / terminal / stub / satellite).
  const defaultModelLabel =
    provider === 'cursor' ? shortModelName(provider, modelLabel, modelId) : modelLabel
  if (provider === 'cursor' && ctx.shellFastModeActive) {
    const label = modelId === 'composer-2.5-fast' ? 'Composer 2.5' : defaultModelLabel
    return reasoning ? `${label} · ${reasoning} Fast` : `${label} · Fast`
  }
  return reasoning ? `${defaultModelLabel} · ${reasoning}` : defaultModelLabel
}
