/**
 * M6 (1.0.7) — Ensemble thinking-ephemerality policy.
 *
 * Blueprint goal: a participant's *reasoning chain* (chain-of-thought /
 * thinking block) must not accumulate in the SHARED PANEL TRANSCRIPT fed to
 * FUTURE rounds, except where a provider explicitly streams reasoning as durable
 * output (Codex). Every other provider's reasoning is ephemeral here by design.
 *
 * SCOPE — this is about CROSS-SEAT bleed, NOT about a seat's own continuity.
 * Two different things get confused otherwise, and the earlier wording of this
 * comment did confuse them:
 *   - "seat B must not read seat A's chain-of-thought" — THIS module's job, and
 *     the right policy: a peer's raw CoT is cost and noise in your context.
 *   - "seat A should still have its OWN reasoning next turn" — NOT this module's
 *     job, and genuinely valuable (OpenAI's 2026-07-29 ARC-AGI-3 write-up
 *     attributes a large share of a 3x score / 6x output-token improvement to
 *     retaining reasoning across turns). Whether that holds is decided per lane
 *     by the TRANSPORT: providers whose native session resumes keep it
 *     internally; lanes TaskWraith reconstructs from a transcript never had it.
 *     Nothing here either helps or harms that — do not "fix" self-continuity by
 *     loosening this guard, which would leak every seat's CoT to every peer.
 *
 * The policy list is deliberately an ALLOWlist of durable providers rather than
 * a denylist of ephemeral ones, so it stays correct as the fleet grows: a new
 * ProviderId is ephemeral until someone deliberately opts it in. (An earlier
 * version of this comment enumerated five providers by name and went stale as
 * the fleet reached ten — the code was always fleet-complete; the prose wasn't.)
 *
 * Current state (verified 1.0.7): the ensemble transcript builder already only
 * carries `message.content`, and `ChatMessage` has no reasoning field — so
 * reasoning does NOT currently leak into future prompts. This module ENCODES
 * that as a tested invariant rather than leaving it accidental:
 *
 *   1. `shouldRetainReasoning(provider)` — the per-provider policy, the single
 *      source of truth for "does this provider's reasoning persist?".
 *   2. `stripReasoningChains(content, provider)` — a defensive guard applied in
 *      `buildTaggedTranscript`. Today it's a no-op for well-formed content
 *      (there are no reasoning fences in `.content`), but if a future provider
 *      adapter ever starts inlining a reasoning block into the persisted
 *      assistant message (a real risk as providers expose CoT), this guard
 *      removes it from the ephemeral providers' future-context transcript
 *      automatically — the invariant can't silently regress.
 *
 * Pure + dependency-free so the policy is exhaustively unit-testable.
 */
import type { ProviderId } from './store/types'

/**
 * Providers whose reasoning is durable output that SHOULD persist into future
 * round context. Codex streams its reasoning as a first-class part of its
 * answer; dropping it would lose content the panel legitimately referenced.
 * Everything else is ephemeral.
 */
const REASONING_DURABLE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['codex'])

export function shouldRetainReasoning(provider: ProviderId | undefined): boolean {
  return provider !== undefined && REASONING_DURABLE_PROVIDERS.has(provider)
}

/**
 * Reasoning-fence patterns we defensively strip for ephemeral providers. These
 * are the common shapes a provider/adapter might use if it ever inlines a
 * thinking block into the persisted message content:
 *   - <think>…</think> / <thinking>…</thinking> (Kimi/DeepSeek-style tags)
 *   - <reasoning>…</reasoning>
 * Matched case-insensitively, across newlines, non-greedy so multiple blocks in
 * one message are each removed. Anchored to the tag names only — ordinary prose
 * that merely contains the word "thinking" is untouched.
 */
const REASONING_FENCE = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi

/**
 * Strip reasoning-fenced blocks from `content` UNLESS the authoring provider's
 * reasoning is durable (Codex). Collapses the blank lines a removed block
 * leaves behind so the transcript stays tidy. Returns the input unchanged when
 * retention applies or when there's nothing to strip — callers can rely on
 * reference equality to skip work.
 */
export function stripReasoningChains(content: string, provider: ProviderId | undefined): string {
  if (typeof content !== 'string' || content.length === 0) return content
  if (shouldRetainReasoning(provider)) return content
  if (!REASONING_FENCE.test(content)) {
    REASONING_FENCE.lastIndex = 0 // reset the stateful global regex
    return content
  }
  REASONING_FENCE.lastIndex = 0
  const stripped = content
    .replace(REASONING_FENCE, '')
    // Collapse 3+ newlines (left by a removed block) down to a paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return stripped
}
