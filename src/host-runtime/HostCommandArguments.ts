/**
 * Strict HostCommand target + argument codecs (Wave 2D-1 Lane B).
 *
 * Validates exact keys per HostCommandName before fingerprinting. Unknown
 * target/argument keys fail closed. Actor identity is preserved and never
 * reminted. Reserved Authority-RPC read aliases are validated here as wire
 * shapes only — this module does not integrate into command() execution.
 *
 * question.answer / approval.decide preserve the existing narrow shared
 * codecs from hostProtocol (mirrored locally; protocol file is closed).
 */

import {
  HOST_APPROVAL_DECIDE_DECISIONS,
  HOST_APPROVAL_DECIDE_MESSAGE_MAX_CHARS,
  HOST_PROTOCOL_MAX_ID,
  HOST_PROTOCOL_MAX_STRING,
  HOST_PROTOCOL_MAX_SHORT,
  HOST_PROTOCOL_VERSION,
  HOST_QUESTION_ANSWER_DECISIONS,
  HOST_QUESTION_ANSWER_MAX_CHARS,
  HOST_QUESTION_DISMISS_MESSAGE_MAX_CHARS,
  HOST_THREAD_RECORD_TRANSFER_MAX_BYTES,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandName,
  type HostDecodeResult
} from '../shared/hostProtocol'

/** Matches control v1 + decodeHostCommand composer text bound. */
export const HOST_COMPOSER_SEND_TEXT_MAX_CHARS = 12_000
/** Matches control v1 `model` bound (HOST_PROTOCOL_MAX_SHORT). */
export const HOST_COMPOSER_SEND_MODEL_MAX_CHARS = HOST_PROTOCOL_MAX_SHORT
/** Matches control v1 `reasoningEffort` bound. */
export const HOST_COMPOSER_SEND_REASONING_EFFORT_MAX_CHARS = 40

const HOST_QUESTION_ANSWER_DECISION_SET = new Set<string>(HOST_QUESTION_ANSWER_DECISIONS)
const HOST_APPROVAL_DECIDE_DECISION_SET = new Set<string>(HOST_APPROVAL_DECIDE_DECISIONS)

const HOST_THREAD_RECORD_TRANSFER_ID_MAX_CHARS = 128
const HOST_THREAD_RECORD_TRANSFER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const HOST_SHA256_HEX_RE = /^[a-f0-9]{64}$/

type CanonicalParts = {
  target: Record<string, string>
  arguments: Record<string, unknown>
}

type CommandShapeValidator = (command: HostCommand) => HostDecodeResult<CanonicalParts>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  )
}

function fail(error: string): HostDecodeResult<never> {
  return { ok: false, error }
}

function exactStringTarget(
  target: Record<string, string>,
  key: string,
  label: string
): HostDecodeResult<Record<string, string>> {
  const keys = Object.keys(target)
  if (keys.length !== 1 || keys[0] !== key) {
    return fail(`${label} target must be exactly { ${key} }`)
  }
  const id = target[key]
  if (!isNonEmptyString(id, HOST_PROTOCOL_MAX_ID)) {
    return fail(`${label} target.${key} is required and bounded`)
  }
  return { ok: true, value: { [key]: id } }
}

function emptyTarget(
  target: Record<string, string>,
  label: string
): HostDecodeResult<Record<string, string>> {
  if (Object.keys(target).length !== 0) {
    return fail(`${label} target must be empty`)
  }
  return { ok: true, value: {} }
}

function emptyArguments(
  args: Record<string, unknown>,
  label: string
): HostDecodeResult<Record<string, unknown>> {
  if (Object.keys(args).length !== 0) {
    return fail(`${label} arguments must be empty`)
  }
  return { ok: true, value: {} }
}

function preserveActor(actor: HostActorIdentity): HostActorIdentity {
  // Pass-through only — never remint or trust alternate wire assertions.
  return {
    actorId: actor.actorId,
    clientId: actor.clientId,
    clientClass: actor.clientClass
  }
}

/**
 * Mirror of hostProtocol decodeQuestionAnswerArguments — keep in lockstep.
 * Protocol exports are closed for this lane.
 */
function decodeQuestionAnswerArguments(
  value: Record<string, unknown>
): HostDecodeResult<Record<string, unknown>> {
  const decision = value.decision
  if (typeof decision !== 'string' || !HOST_QUESTION_ANSWER_DECISION_SET.has(decision)) {
    return fail('question.answer decision must be answer or dismiss')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'decision' && key !== 'answer' && key !== 'isCustom' && key !== 'message') {
      return fail('question.answer has unknown argument keys')
    }
  }
  if (decision === 'answer') {
    if (value.message !== undefined) {
      return fail('question.answer answer must not include dismiss message')
    }
    const answer = value.answer
    if (
      typeof answer !== 'string' ||
      answer.length === 0 ||
      answer.length > HOST_QUESTION_ANSWER_MAX_CHARS
    ) {
      return fail('question.answer answer text is required and bounded')
    }
    if (!answer.trim()) {
      return fail('question.answer answer text is required and bounded')
    }
    if (value.isCustom !== undefined && typeof value.isCustom !== 'boolean') {
      return fail('question.answer isCustom must be boolean')
    }
    const out: Record<string, unknown> = { decision: 'answer', answer }
    if (value.isCustom !== undefined) out.isCustom = value.isCustom
    return { ok: true, value: out }
  }
  if (value.answer !== undefined || value.isCustom !== undefined) {
    return fail('question.answer dismiss must not include answer fields')
  }
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' ||
      value.message.length === 0 ||
      value.message.length > HOST_QUESTION_DISMISS_MESSAGE_MAX_CHARS)
  ) {
    return fail('question.answer dismiss message is invalid')
  }
  const out: Record<string, unknown> = { decision: 'dismiss' }
  if (value.message !== undefined) out.message = value.message
  return { ok: true, value: out }
}

/**
 * Mirror of hostProtocol decodeApprovalDecideArguments — keep in lockstep.
 */
function decodeApprovalDecideArguments(
  value: Record<string, unknown>
): HostDecodeResult<Record<string, unknown>> {
  const decision = value.decision
  if (typeof decision !== 'string' || !HOST_APPROVAL_DECIDE_DECISION_SET.has(decision)) {
    return fail('approval.decide decision is invalid')
  }
  if (
    value.message !== undefined &&
    (typeof value.message !== 'string' ||
      value.message.length === 0 ||
      value.message.length > HOST_APPROVAL_DECIDE_MESSAGE_MAX_CHARS)
  ) {
    return fail('approval.decide message is invalid')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'decision' && key !== 'message') {
      return fail('approval.decide has unknown argument keys')
    }
  }
  const out: Record<string, unknown> = { decision }
  if (value.message !== undefined) out.message = value.message
  return { ok: true, value: out }
}

function validateSnapshotGet(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = emptyTarget(command.target, 'snapshot.get')
  if (!target.ok) return target
  const args = emptyArguments(command.arguments, 'snapshot.get')
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function validateDeltasSince(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = emptyTarget(command.target, 'deltas.since')
  if (!target.ok) return target
  const args = command.arguments
  for (const key of Object.keys(args)) {
    if (key !== 'generation' && key !== 'cursor') {
      return fail('deltas.since has unknown argument keys')
    }
  }
  if (!isNonNegativeInt(args.generation) || !isNonNegativeInt(args.cursor)) {
    return fail('deltas.since requires generation and cursor')
  }
  if (Object.keys(args).length !== 2) {
    return fail('deltas.since arguments must be exactly { generation, cursor }')
  }
  return {
    ok: true,
    value: {
      target: target.value,
      arguments: { generation: args.generation, cursor: args.cursor }
    }
  }
}

function validateReceiptLookup(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const keys = Object.keys(command.target).sort()
  if (keys.length !== 1 || (keys[0] !== 'commandId' && keys[0] !== 'idempotencyKey')) {
    return fail('receipt.lookup target must be exactly one of commandId or idempotencyKey')
  }
  const key = keys[0]
  const id = command.target[key]
  if (!isNonEmptyString(id, HOST_PROTOCOL_MAX_ID)) {
    return fail(`receipt.lookup target.${key} is required and bounded`)
  }
  const args = emptyArguments(command.arguments, 'receipt.lookup')
  if (!args.ok) return args
  return { ok: true, value: { target: { [key]: id }, arguments: args.value } }
}

function validateComposerSend(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'threadId', 'composer.send')
  if (!target.ok) return target
  const args = command.arguments
  for (const key of Object.keys(args)) {
    if (key !== 'text' && key !== 'model' && key !== 'reasoningEffort') {
      return fail('composer.send has unknown argument keys')
    }
  }
  const text = args.text
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    text.length > HOST_COMPOSER_SEND_TEXT_MAX_CHARS ||
    !text.trim()
  ) {
    return fail('composer.send text is required and bounded')
  }
  if (
    args.model !== undefined &&
    !isNonEmptyString(args.model, HOST_COMPOSER_SEND_MODEL_MAX_CHARS)
  ) {
    return fail('composer.send model must be a bounded string')
  }
  if (
    args.reasoningEffort !== undefined &&
    !isNonEmptyString(args.reasoningEffort, HOST_COMPOSER_SEND_REASONING_EFFORT_MAX_CHARS)
  ) {
    return fail('composer.send reasoningEffort must be a bounded string')
  }
  const out: Record<string, unknown> = { text }
  if (args.model !== undefined) out.model = args.model
  if (args.reasoningEffort !== undefined) out.reasoningEffort = args.reasoningEffort
  return { ok: true, value: { target: target.value, arguments: out } }
}

function validateThreadOnlyEmptyArgs(
  command: HostCommand,
  label: 'run.cancel' | 'thread.select'
): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'threadId', label)
  if (!target.ok) return target
  const args = emptyArguments(command.arguments, label)
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function validateEnsembleSeatToggle(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'threadId', 'ensemble.seat.toggle')
  if (!target.ok) return target
  const args = command.arguments
  for (const key of Object.keys(args)) {
    if (key !== 'participantId' && key !== 'enabled') {
      return fail('ensemble.seat.toggle has unknown argument keys')
    }
  }
  if (!isNonEmptyString(args.participantId, HOST_PROTOCOL_MAX_SHORT)) {
    return fail('ensemble.seat.toggle participantId is required and bounded')
  }
  if (typeof args.enabled !== 'boolean') {
    return fail('ensemble.seat.toggle enabled must be a boolean')
  }
  if (Object.keys(args).length !== 2) {
    return fail('ensemble.seat.toggle arguments must be exactly { participantId, enabled }')
  }
  return {
    ok: true,
    value: {
      target: target.value,
      arguments: { participantId: args.participantId, enabled: args.enabled }
    }
  }
}

function validateThreadRecordPersist(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'threadId', 'thread.record.persist')
  if (!target.ok) return target
  const args = command.arguments
  const allowed = ['transferId', 'sha256', 'byteLength', 'expectedRevision'] as const
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key as (typeof allowed)[number])) {
      return fail('thread.record.persist has unknown argument keys')
    }
  }
  if (Object.keys(args).length !== allowed.length) {
    return fail(
      'thread.record.persist arguments must be exactly { transferId, sha256, byteLength, expectedRevision }'
    )
  }
  if (
    !isNonEmptyString(args.transferId, HOST_THREAD_RECORD_TRANSFER_ID_MAX_CHARS) ||
    !HOST_THREAD_RECORD_TRANSFER_ID_RE.test(args.transferId)
  ) {
    return fail('thread.record.persist transferId is invalid')
  }
  if (typeof args.sha256 !== 'string' || !HOST_SHA256_HEX_RE.test(args.sha256)) {
    return fail('thread.record.persist sha256 must be lowercase SHA-256 hex')
  }
  if (
    !Number.isSafeInteger(args.byteLength) ||
    (args.byteLength as number) <= 0 ||
    (args.byteLength as number) > HOST_THREAD_RECORD_TRANSFER_MAX_BYTES
  ) {
    return fail('thread.record.persist byteLength is invalid')
  }
  if (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 0) {
    return fail('thread.record.persist expectedRevision is invalid')
  }
  return {
    ok: true,
    value: {
      target: target.value,
      arguments: {
        transferId: args.transferId,
        sha256: args.sha256,
        byteLength: args.byteLength,
        expectedRevision: args.expectedRevision
      }
    }
  }
}

function validateThreadRecordDelete(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'threadId', 'thread.record.delete')
  if (!target.ok) return target
  const args = command.arguments
  const keys = Object.keys(args)
  if (keys.some((key) => key !== 'expectedRevision')) {
    return fail('thread.record.delete has unknown argument keys')
  }
  if (keys.length !== 1) {
    return fail('thread.record.delete arguments must be exactly { expectedRevision }')
  }
  if (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 0) {
    return fail('thread.record.delete expectedRevision is invalid')
  }
  return {
    ok: true,
    value: {
      target: target.value,
      arguments: { expectedRevision: args.expectedRevision }
    }
  }
}

function validateQuestionAnswer(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'questionId', 'question.answer')
  if (!target.ok) return target
  const args = decodeQuestionAnswerArguments(command.arguments)
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function validateApprovalDecide(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'approvalId', 'approval.decide')
  if (!target.ok) return target
  const args = decodeApprovalDecideArguments(command.arguments)
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function validateChannelMemberRevoke(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'channelId', 'channel.member.revoke')
  if (!target.ok) return target
  const keys = Object.keys(command.arguments)
  if (keys.length !== 1 || keys[0] !== 'memberId') {
    return fail('channel.member.revoke arguments must be exactly { memberId }')
  }
  if (!isNonEmptyString(command.arguments.memberId, HOST_PROTOCOL_MAX_ID)) {
    return fail('channel.member.revoke memberId is required and bounded')
  }
  return {
    ok: true,
    value: { target: target.value, arguments: { memberId: command.arguments.memberId } }
  }
}

function validateChannelClose(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'channelId', 'channel.close')
  if (!target.ok) return target
  const args = emptyArguments(command.arguments, 'channel.close')
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function validatePing(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = emptyTarget(command.target, 'ping')
  if (!target.ok) return target
  const args = emptyArguments(command.arguments, 'ping')
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function exactArgumentKeys(
  args: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): HostDecodeResult<Record<string, unknown>> {
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    return fail(`${label} has unknown argument keys`)
  }
  return { ok: true, value: args }
}

function optionalShortString(value: unknown, label: string): HostDecodeResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isNonEmptyString(value, HOST_PROTOCOL_MAX_SHORT)) {
    return fail(`${label} must be a bounded string`)
  }
  return { ok: true, value }
}

function validateWorkspaceRegister(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = emptyTarget(command.target, 'workspace.register')
  if (!target.ok) return target
  const args = exactArgumentKeys(
    command.arguments,
    ['path', 'displayName', 'pinned'],
    'workspace.register'
  )
  if (!args.ok) return args
  if (!isNonEmptyString(args.value.path, HOST_PROTOCOL_MAX_STRING)) {
    return fail('workspace.register path is required and bounded')
  }
  const displayName = optionalShortString(args.value.displayName, 'workspace.register displayName')
  if (!displayName.ok) return displayName
  if (args.value.pinned !== undefined && typeof args.value.pinned !== 'boolean') {
    return fail('workspace.register pinned must be boolean')
  }
  const output: Record<string, unknown> = { path: args.value.path }
  if (displayName.value !== undefined) output.displayName = displayName.value
  if (args.value.pinned !== undefined) output.pinned = args.value.pinned
  return { ok: true, value: { target: target.value, arguments: output } }
}

function validateWorkspaceRecordUpsert(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'workspaceId', 'workspace.record.upsert')
  if (!target.ok) return target
  const args = command.arguments
  const allowed = [
    'path',
    'displayName',
    'createdAt',
    'lastOpenedAt',
    'pinned',
    'branch',
    'geminiWorktree'
  ] as const
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key as (typeof allowed)[number])) {
      return fail('workspace.record.upsert has unknown argument keys')
    }
  }
  if (
    !isNonEmptyString(args.path, HOST_PROTOCOL_MAX_STRING) ||
    !isNonEmptyString(args.displayName, HOST_PROTOCOL_MAX_SHORT) ||
    !isNonNegativeInt(args.createdAt) ||
    !isNonNegativeInt(args.lastOpenedAt) ||
    typeof args.pinned !== 'boolean'
  ) {
    return fail('workspace.record.upsert arguments are invalid')
  }
  if (args.branch !== undefined && !isNonEmptyString(args.branch, HOST_PROTOCOL_MAX_SHORT)) {
    return fail('workspace.record.upsert branch is invalid')
  }
  let geminiWorktree: Record<string, unknown> | undefined
  if (args.geminiWorktree !== undefined) {
    if (!isRecord(args.geminiWorktree)) {
      return fail('workspace.record.upsert geminiWorktree is invalid')
    }
    const keys = Object.keys(args.geminiWorktree)
    if (keys.some((key) => key !== 'enabled' && key !== 'name')) {
      return fail('workspace.record.upsert geminiWorktree has unknown keys')
    }
    if (typeof args.geminiWorktree.enabled !== 'boolean') {
      return fail('workspace.record.upsert geminiWorktree is invalid')
    }
    if (
      args.geminiWorktree.name !== undefined &&
      !isNonEmptyString(args.geminiWorktree.name, HOST_PROTOCOL_MAX_SHORT)
    ) {
      return fail('workspace.record.upsert geminiWorktree name is invalid')
    }
    geminiWorktree = { enabled: args.geminiWorktree.enabled }
    if (args.geminiWorktree.name !== undefined) geminiWorktree.name = args.geminiWorktree.name
  }
  const output: Record<string, unknown> = {
    path: args.path,
    displayName: args.displayName,
    createdAt: args.createdAt,
    lastOpenedAt: args.lastOpenedAt,
    pinned: args.pinned
  }
  if (args.branch !== undefined) output.branch = args.branch
  if (geminiWorktree !== undefined) output.geminiWorktree = geminiWorktree
  return { ok: true, value: { target: target.value, arguments: output } }
}

function validateWorkspaceRecordRemove(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'workspaceId', 'workspace.record.remove')
  if (!target.ok) return target
  const args = emptyArguments(command.arguments, 'workspace.record.remove')
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function validateWorkspaceRecordsClear(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = emptyTarget(command.target, 'workspace.records.clear')
  if (!target.ok) return target
  const args = emptyArguments(command.arguments, 'workspace.records.clear')
  if (!args.ok) return args
  return { ok: true, value: { target: target.value, arguments: args.value } }
}

function validateThreadCreate(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = emptyTarget(command.target, 'thread.create')
  if (!target.ok) return target
  const args = exactArgumentKeys(
    command.arguments,
    ['scope', 'workspaceId', 'title'],
    'thread.create'
  )
  if (!args.ok) return args
  if (args.value.scope !== 'global' && args.value.scope !== 'workspace') {
    return fail('thread.create scope must be global or workspace')
  }
  const title = optionalShortString(args.value.title, 'thread.create title')
  if (!title.ok) return title
  if (args.value.scope === 'global' && args.value.workspaceId !== undefined) {
    return fail('thread.create global must not include workspaceId')
  }
  if (
    args.value.scope === 'workspace' &&
    !isNonEmptyString(args.value.workspaceId, HOST_PROTOCOL_MAX_ID)
  ) {
    return fail('thread.create workspace requires workspaceId')
  }
  const output: Record<string, unknown> = { scope: args.value.scope }
  if (args.value.scope === 'workspace') output.workspaceId = args.value.workspaceId
  if (title.value !== undefined) output.title = title.value
  return { ok: true, value: { target: target.value, arguments: output } }
}

function validateThreadConfigure(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'threadId', 'thread.configure')
  if (!target.ok) return target
  const args = command.arguments
  const keys = Object.keys(args).sort()
  if (args.chatKind === 'ensemble' && keys.length === 1 && keys[0] === 'chatKind') {
    return {
      ok: true,
      value: { target: target.value, arguments: { chatKind: 'ensemble' } }
    }
  }
  if (
    args.chatKind === 'single' &&
    keys.length === 2 &&
    keys[0] === 'canonicalProviderId' &&
    keys[1] === 'chatKind'
  ) {
    if (!isNonEmptyString(args.canonicalProviderId, HOST_PROTOCOL_MAX_ID)) {
      return fail('thread.configure canonicalProviderId must be a bounded string')
    }
    return {
      ok: true,
      value: {
        target: target.value,
        arguments: { chatKind: 'single', canonicalProviderId: args.canonicalProviderId }
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(args, 'chatKind')) {
    return fail('thread.configure chat-kind change is invalid')
  }
  if (keys.length === 1 && keys[0] === 'title') {
    if (!isNonEmptyString(args.title, HOST_PROTOCOL_MAX_SHORT)) {
      return fail('thread.configure title must be a bounded string')
    }
    return { ok: true, value: { target: target.value, arguments: { title: args.title } } }
  }
  const required = ['modelId', 'offerRevision', 'postureId', 'providerId']
  const allowed = [
    'modelId',
    'offerRevision',
    'postureId',
    'providerId',
    'reasoningId',
    'title',
    'postureConsent'
  ]
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(args, key))
  ) {
    return fail('thread.configure must be title-only or a complete provider selection')
  }
  for (const key of required) {
    if (!isNonEmptyString(args[key], HOST_PROTOCOL_MAX_ID)) {
      return fail(`thread.configure ${key} must be a bounded string`)
    }
  }
  if (args.reasoningId !== undefined && !isNonEmptyString(args.reasoningId, HOST_PROTOCOL_MAX_ID)) {
    return fail('thread.configure reasoningId must be a bounded string')
  }
  if (args.title !== undefined && !isNonEmptyString(args.title, HOST_PROTOCOL_MAX_SHORT)) {
    return fail('thread.configure title must be a bounded string')
  }
  if (args.postureConsent !== undefined && args.postureConsent !== true) {
    return fail('thread.configure postureConsent must be true when present')
  }
  const output: Record<string, unknown> = {
    providerId: args.providerId,
    modelId: args.modelId,
    postureId: args.postureId,
    offerRevision: args.offerRevision
  }
  if (args.reasoningId !== undefined) output.reasoningId = args.reasoningId
  if (args.title !== undefined) output.title = args.title
  if (args.postureConsent === true) output.postureConsent = true
  return { ok: true, value: { target: target.value, arguments: output } }
}

function validateThreadArchive(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'threadId', 'thread.archive')
  if (!target.ok) return target
  const args = command.arguments
  if (Object.keys(args).length !== 1 || !Object.prototype.hasOwnProperty.call(args, 'archived')) {
    return fail('thread.archive arguments must be exactly { archived }')
  }
  if (typeof args.archived !== 'boolean') return fail('thread.archive archived must be boolean')
  return { ok: true, value: { target: target.value, arguments: { archived: args.archived } } }
}

function validateProviderAuthBegin(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const target = exactStringTarget(command.target, 'providerId', 'provider.auth.begin')
  if (!target.ok) return target
  const args = command.arguments
  if (Object.keys(args).length !== 1 || !Object.prototype.hasOwnProperty.call(args, 'flowId')) {
    return fail('provider.auth.begin arguments must be exactly { flowId }')
  }
  if (!isNonEmptyString(args.flowId, HOST_PROTOCOL_MAX_ID)) {
    return fail('provider.auth.begin flowId is required and bounded')
  }
  return { ok: true, value: { target: target.value, arguments: { flowId: args.flowId } } }
}

function validateProviderAuthCancel(command: HostCommand): HostDecodeResult<CanonicalParts> {
  const targetKeys = Object.keys(command.target).sort()
  if (
    targetKeys.length !== 2 ||
    targetKeys[0] !== 'operationId' ||
    targetKeys[1] !== 'providerId'
  ) {
    return fail('provider.auth.cancel target must be exactly { providerId, operationId }')
  }
  const providerId = command.target.providerId
  const operationId = command.target.operationId
  if (
    !isNonEmptyString(providerId, HOST_PROTOCOL_MAX_ID) ||
    !isNonEmptyString(operationId, HOST_PROTOCOL_MAX_ID)
  ) {
    return fail('provider.auth.cancel target identifiers are required and bounded')
  }
  const args = emptyArguments(command.arguments, 'provider.auth.cancel')
  if (!args.ok) return args
  return {
    ok: true,
    value: { target: { providerId, operationId }, arguments: args.value }
  }
}

/**
 * Exhaustive per-name validators. Adding a HostCommandName without an entry
 * fails typecheck via `satisfies Record`.
 */
const HOST_COMMAND_ARGUMENT_VALIDATORS = {
  'snapshot.get': validateSnapshotGet,
  'deltas.since': validateDeltasSince,
  'receipt.lookup': validateReceiptLookup,
  'composer.send': validateComposerSend,
  'run.cancel': (command) => validateThreadOnlyEmptyArgs(command, 'run.cancel'),
  'question.answer': validateQuestionAnswer,
  'approval.decide': validateApprovalDecide,
  'ensemble.seat.toggle': validateEnsembleSeatToggle,
  'thread.record.persist': validateThreadRecordPersist,
  'thread.record.delete': validateThreadRecordDelete,
  'channel.member.revoke': validateChannelMemberRevoke,
  'channel.close': validateChannelClose,
  'thread.select': (command) => validateThreadOnlyEmptyArgs(command, 'thread.select'),
  'workspace.register': validateWorkspaceRegister,
  'workspace.record.upsert': validateWorkspaceRecordUpsert,
  'workspace.record.remove': validateWorkspaceRecordRemove,
  'workspace.records.clear': validateWorkspaceRecordsClear,
  'thread.create': validateThreadCreate,
  'thread.configure': validateThreadConfigure,
  'thread.archive': validateThreadArchive,
  'provider.auth.begin': validateProviderAuthBegin,
  'provider.auth.cancel': validateProviderAuthCancel,
  ping: validatePing
} as const satisfies Record<HostCommandName, CommandShapeValidator>

/**
 * Strictly validate exact targets and arguments for a HostCommand.
 * Returns a canonical command with preserved identity fields, or a bounded error.
 * Does not fingerprint, execute, or remint actor/commandId/idempotencyKey.
 */
export function validateHostCommandArguments(command: HostCommand): HostDecodeResult<HostCommand> {
  if (!isRecord(command as unknown)) {
    return fail('command must be an object')
  }
  if (command.type !== 'host.command') {
    return fail('type must be host.command')
  }
  if (command.protocolVersion !== HOST_PROTOCOL_VERSION) {
    return fail('unsupported protocol version')
  }
  if (!isNonEmptyString(command.commandId, HOST_PROTOCOL_MAX_ID)) {
    return fail('commandId is required')
  }
  if (!isNonEmptyString(command.idempotencyKey, HOST_PROTOCOL_MAX_ID)) {
    return fail('idempotencyKey is required')
  }
  if (!isNonEmptyString(command.issuedAt, 80)) {
    return fail('issuedAt is required')
  }
  if (!isRecord(command.actor as unknown)) {
    return fail('actor must be an object')
  }
  if (!isNonEmptyString(command.actor.actorId, HOST_PROTOCOL_MAX_ID)) {
    return fail('actor.actorId is required')
  }
  if (!isNonEmptyString(command.actor.clientId, HOST_PROTOCOL_MAX_ID)) {
    return fail('actor.clientId is required')
  }
  if (
    command.actor.clientClass !== 'desktop' &&
    command.actor.clientClass !== 'tui' &&
    command.actor.clientClass !== 'ios' &&
    command.actor.clientClass !== 'test'
  ) {
    return fail('actor.clientClass is invalid')
  }
  if (!isRecord(command.target as unknown)) {
    return fail('target must be an object')
  }
  if (!isRecord(command.arguments as unknown)) {
    return fail('arguments must be an object')
  }

  const name = command.name
  const validator = HOST_COMMAND_ARGUMENT_VALIDATORS[name]
  if (!validator) {
    return fail('unknown command name')
  }

  const shape = validator(command)
  if (!shape.ok) return shape

  return {
    ok: true,
    value: {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      actor: preserveActor(command.actor),
      name,
      target: shape.value.target,
      arguments: shape.value.arguments,
      issuedAt: command.issuedAt
    }
  }
}
