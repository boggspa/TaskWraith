import type { ChatMessage } from '../store/types'
import {
  wrapExternalContribution,
  type ExternalContributionReview
} from './ExternalContributionContext'

export const HUMAN_COLLABORATOR_COMMENT_KIND = 'humanCollaboratorComment'

/**
 * P2b: what the collaborator intended this contribution to be. Deliberately a
 * SUB-FIELD of the existing comment kind (not a new metadata kind) so every
 * exclusion + anti-forgery seam that gates on `kind === humanCollaboratorComment`
 * — prompt composition, Gemini replay, ensemble prompts, transcript export,
 * projection, and ChatService canonicalization — keeps applying unchanged.
 */
export type HumanCollaboratorContributionKind = 'comment' | 'requestHostAction'

export interface HumanCollaboratorCommentMetadata {
  kind: typeof HUMAN_COLLABORATOR_COMMENT_KIND
  sourceTrust: 'external_untrusted'
  shareId: string
  collaboratorId: string
  collaboratorDisplayName: string
  clientMessageId: string
  sequence: number
  contributionKind?: HumanCollaboratorContributionKind
  promotedAt?: number
  promotedBy?: 'host' | 'auto'
  promotedDraft?: string
}

export function isHumanCollaboratorComment(message: ChatMessage | null | undefined): boolean {
  return message?.metadata?.kind === HUMAN_COLLABORATOR_COMMENT_KIND
}

/**
 * Does this row carry text authored outside the host's trust boundary?
 *
 * DELIBERATELY KEYED ON `sourceTrust`, NOT ON THE COMMENT KIND, and the two are
 * not interchangeable:
 *
 *  - `isHumanCollaboratorComment` is the EXCLUSION predicate. It answers "keep
 *    this out of provider history entirely", and every serializer uses it.
 *  - this one is the WRAPPING predicate. It answers "if this text is about to
 *    reach a model anyway, it must arrive framed as untrusted."
 *
 * They diverge precisely where it matters. A P2c Promote row is meant to reach
 * the model, so it must NOT be excluded — but it must still be wrapped. And a
 * future path that carries external text without the comment kind (the mid-run
 * steering builder stamps `role: 'user'` with `kind: 'midRunSteering'`, a
 * Channels post will carry neither) is invisible to the exclusion predicate but
 * must never be invisible to this one. Keying the wrapper on the kind would
 * reproduce exactly the gap that makes the steering path unsafe.
 */
export function isExternalUntrustedMessage(message: ChatMessage | null | undefined): boolean {
  return message?.metadata?.sourceTrust === 'external_untrusted'
}

export function humanCollaboratorMetadata(
  message: ChatMessage
): HumanCollaboratorCommentMetadata | null {
  if (!isHumanCollaboratorComment(message)) return null
  const metadata = message.metadata || {}
  const shareId = stringValue(metadata.shareId)
  const collaboratorId = stringValue(metadata.collaboratorId)
  const collaboratorDisplayName = stringValue(metadata.collaboratorDisplayName)
  const clientMessageId = stringValue(metadata.clientMessageId)
  const sequence = numberValue(metadata.sequence)
  if (!shareId || !collaboratorId || !clientMessageId || sequence === null) return null
  return {
    kind: HUMAN_COLLABORATOR_COMMENT_KIND,
    sourceTrust: 'external_untrusted',
    shareId,
    collaboratorId,
    collaboratorDisplayName: collaboratorDisplayName || 'Collaborator',
    clientMessageId,
    sequence,
    ...(metadata.contributionKind === 'requestHostAction'
      ? { contributionKind: 'requestHostAction' as const }
      : {}),
    ...(typeof metadata.promotedAt === 'number' ? { promotedAt: metadata.promotedAt } : {}),
    ...(metadata.promotedBy === 'host' || metadata.promotedBy === 'auto'
      ? { promotedBy: metadata.promotedBy as 'host' | 'auto' }
      : {}),
    ...(typeof metadata.promotedDraft === 'string' ? { promotedDraft: metadata.promotedDraft } : {})
  }
}

/** P2b: is this collaborator row a structured "request host action"? */
export function isHumanCollaboratorActionRequest(
  message: ChatMessage | null | undefined
): boolean {
  return (
    isHumanCollaboratorComment(message) &&
    message?.metadata?.contributionKind === 'requestHostAction'
  )
}

export function makeHumanCollaboratorComment(args: {
  id: string
  content: string
  timestamp: string
  shareId: string
  collaboratorId: string
  collaboratorDisplayName: string
  clientMessageId: string
  sequence: number
  contributionKind?: HumanCollaboratorContributionKind
}): ChatMessage {
  return {
    id: args.id,
    role: 'system',
    content: args.content,
    timestamp: args.timestamp,
    metadata: {
      kind: HUMAN_COLLABORATOR_COMMENT_KIND,
      sourceTrust: 'external_untrusted',
      shareId: args.shareId,
      collaboratorId: args.collaboratorId,
      collaboratorDisplayName: args.collaboratorDisplayName,
      clientMessageId: args.clientMessageId,
      sequence: args.sequence,
      ...(args.contributionKind === 'requestHostAction'
        ? { contributionKind: 'requestHostAction' as const }
        : {})
    }
  }
}

/**
 * Build the draft text placed into the HOST composer for a collaborator row.
 *
 * P2c security review, F9. Both draft paths now emit the SAME frame the
 * composition-time choke point emits, for two reasons.
 *
 * The first is that the old copy was a vouch. `promotedCollaboratorPrompt` used
 * to open "Host-approved request from collaborator X", which a model can
 * reasonably read as the host asserting the request is legitimate — the exact
 * trust elevation this feature must never perform. Host approval means the host
 * let the text through, not that the host stands behind its instructions.
 *
 * The second is structural, and it is why this is a precondition rather than a
 * copy edit. **A draft is the one external-text path the render-time choke point
 * cannot see.** Once the host sends it, it is an ordinary `role: 'user'` host
 * message carrying no `sourceTrust`, so `projectTaggedTranscript` will not — and
 * must not — reframe it. Whatever framing the draft carried at insert time is
 * the only framing that will ever exist for that text. So the draft has to carry
 * the real frame, not a summary of one.
 *
 * `review` is the ONLY difference between the two callers, which is deliberate:
 * `wrapExternalContribution` renders host-approved and unreviewed identically
 * apart from that one token, so a host cannot be socially engineered by a
 * contribution that looks more endorsed than it is.
 */
function collaboratorDraft(message: ChatMessage, review: ExternalContributionReview): string {
  const metadata = humanCollaboratorMetadata(message)
  return wrapExternalContribution(message.content, {
    senderDisplayName: metadata?.collaboratorDisplayName || '',
    ...(metadata?.shareId ? { shareId: metadata.shareId } : {}),
    ...(metadata?.collaboratorId ? { collaboratorId: metadata.collaboratorId } : {}),
    ...(message.id ? { messageId: message.id } : {}),
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    review
  })
}

/** Host clicked Promote — the host has seen the text and released it. */
export function promotedCollaboratorPrompt(message: ChatMessage): string {
  return collaboratorDraft(message, 'host-approved')
}

/**
 * P2b auto-draft. Inserted into the composer without the host having read it,
 * so it is reported as `unreviewed` — never `host-approved`. The host-facing
 * "review this before sending" guidance belongs on the composer's own
 * action-request badge, not inside the prompt text, where it would be an
 * instruction addressed to the wrong reader.
 */
export function autoDraftedCollaboratorPrompt(message: ChatMessage): string {
  return collaboratorDraft(message, 'unreviewed')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
