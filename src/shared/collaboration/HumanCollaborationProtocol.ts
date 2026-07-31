export const HUMAN_COLLABORATION_PROTOCOL = 'taskwraith-human-collaboration-v1'

export const HUMAN_COLLABORATION_METHODS = {
  beginHandshake: 'humanCollaboration.handshake.begin',
  confirmSas: 'humanCollaboration.handshake.confirmSas',
  subscribeProjection: 'humanCollaboration.projection.subscribe',
  appendComment: 'humanCollaboration.comment.append',
  /** Page BACKWARDS through the thread, within the share's history floor. */
  loadOlder: 'humanCollaboration.projection.loadOlder',
  disconnect: 'humanCollaboration.disconnect'
} as const

export const HUMAN_COLLABORATION_EVENTS = {
  projectionUpdate: 'humanCollaboration.projection.update',
  /**
   * The host refused a contribution — too long, too fast, too many awaiting
   * review, or a session that is no longer valid.
   *
   * Additive, and safe for an older collaborator build: the cipher only
   * dispatches methods it recognises, and an unknown one falls through
   * `handleSealed` silently rather than erroring. Such a build degrades to
   * today's behaviour (silence), which is what it already has.
   *
   * This is the ONLY host→collaborator channel besides the projection. Without
   * it every refusal was a host-only console line while the collaborator's UI
   * still read "Connected" and their text was already gone.
   */
  contributionRejected: 'humanCollaboration.comment.rejected',
  /**
   * One backwards page, answering a `loadOlder`.
   *
   * An EVENT rather than a reply frame because the sealed lane has no
   * request/response — only the plaintext handshake does, and the transport
   * discards whatever `routeEncryptedAction` returns.
   */
  olderPage: 'humanCollaboration.projection.olderPage'
} as const

/** What a refusal tells the collaborator. Deliberately narrow: a code they can
 *  be shown, the host-authored reason string, and which of their messages it
 *  was — never anything about the host's state. */
export interface HumanCollaborationContributionRejectedEvent {
  code: string
  message: string
  clientMessageId?: string
}

export type HumanCollaborationMethod =
  (typeof HUMAN_COLLABORATION_METHODS)[keyof typeof HUMAN_COLLABORATION_METHODS]
export type HumanCollaborationEvent =
  (typeof HUMAN_COLLABORATION_EVENTS)[keyof typeof HUMAN_COLLABORATION_EVENTS]
export type HumanCollaborationWireName = HumanCollaborationMethod | HumanCollaborationEvent

export type HumanCollaborationHandshakeMode = 'admission' | 'reconnect'
export type HumanCollaborationFrameDirection = 'hostToCollaborator' | 'collaboratorToHost'

export interface HumanCollaborationHandshakeContext {
  protocol: typeof HUMAN_COLLABORATION_PROTOCOL
  mode: HumanCollaborationHandshakeMode
  shareId: string
  chatId: string
  inviteId: string
  inviteTokenHash: string
  inviteExpiresAt: number
  shareMode: 'readOnly' | 'comments'
  collaboratorId?: string
  hostIdentityPubKeyB64: string
  collaboratorIdentityPubKeyB64: string
  hostEphemeralPubKeyB64: string
  collaboratorEphemeralPubKeyB64: string
  hostNonceB64: string
  collaboratorNonceB64: string
}
export interface HumanCollaborationBeginHandshakeInput {
  shareId: string
  chatId: string
  displayName: string
  inviteToken?: string
  collaboratorId?: string
  collaboratorIdentityPubKeyB64: string
  collaboratorEphemeralPubKeyB64: string
  collaboratorNonceB64: string
}

export interface HumanCollaborationBeginHandshakeResult {
  handshakeId: string
  protocol: typeof HUMAN_COLLABORATION_PROTOCOL
  mode: HumanCollaborationHandshakeMode
  shareId: string
  chatId: string
  inviteId: string
  hostIdentityPubKeyB64: string
  hostEphemeralPubKeyB64: string
  hostNonceB64: string
  confirmCode: string
  hostTranscriptSigB64: string
  transcriptHashB64: string
  expiresAt: number
}

export interface HumanCollaborationConfirmSasInput {
  handshakeId: string
  confirmCode: string
  collaboratorTranscriptSigB64: string
}

export interface HumanCollaborationConfirmSasResult {
  sessionId: string
  shareId: string
  chatId: string
  collaboratorId: string
  displayName: string
  hostIdentityPubKeyB64: string
  establishedAt: number
}

export interface HumanCollaborationSubscribeProjectionInput {
  sessionId: string
}

export interface HumanCollaborationAppendCommentInput {
  sessionId: string
  clientMessageId: string
  content: string
  /**
   * P2b contribution intent, rides the v1 appendComment method for
   * compatibility: a pre-P2b host simply ignores the field and records a plain
   * comment (fail-safe — still an external/untrusted row, still host-reviewed),
   * while a P2b host validates it against the share's contribution rules.
   */
  intent?: 'comment' | 'requestHostAction'
}

export interface HumanCollaborationLoadOlderInput {
  sessionId: string
  /**
   * Page strictly OLDER than this row id; omit for the first page back from the
   * live window. An id the host cannot place yields an EMPTY page, never the
   * newest rows — a client paging with a stale cursor must not be handed the
   * live window dressed as history.
   */
  beforeRowId?: string
}

export interface HumanCollaborationOlderPageEvent {
  /**
   * The session this page belongs to, and the whole of the L-3 control.
   *
   * A page is CLIENT-HELD, so a host-side truncation cannot reach it. The room
   * drop forces a re-handshake, and a re-handshake mints a NEW sessionId — so a
   * client that keys its page cache on this value cannot merge pre-truncation
   * rows into a post-truncation session. Discarding has to be structural: a
   * cache that must remember to call `clear()` is a cache that will one day
   * forget, and the rows it keeps are rows somebody asked to have erased.
   */
  sessionId: string
  /** Echoes the request, so a client can correlate concurrent pages. */
  beforeRowId?: string
  rows: unknown[]
  /** More rows exist above this page — budget-bound OR floor-bound. */
  hasMore: boolean
  /** Cursor for the next call: the id of the OLDEST row in this page. */
  oldestRowId?: string
  /**
   * This page was REFUSED for rate, not answered — no rows were read, and
   * `hasMore` says nothing about the thread.
   *
   * Distinguishing this from a genuine empty page is the point. An empty page
   * with no flag reads as "you have reached the top", and a client that showed
   * that would be telling the collaborator the conversation began somewhere it
   * did not. Silence would be the same lie with fewer words.
   */
  throttled?: boolean
}

export interface HumanCollaborationDisconnectInput {
  sessionId: string
}

export interface HumanCollaborationPlainMessage {
  msgId: number
  method: HumanCollaborationWireName
  params?: unknown
}

export interface HumanCollaborationEncryptedFrame {
  t: 'humanCollaboration.enc'
  protocol: typeof HUMAN_COLLABORATION_PROTOCOL
  sessionId: string
  direction: HumanCollaborationFrameDirection
  seq: number
  nonce: string
  ct: string
  tag: string
}
