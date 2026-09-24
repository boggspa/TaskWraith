'use strict'

const { createHash } = require('node:crypto')

// State is explicitly shared only by the repetitions/roles of one replay.
// It never bootstraps from arbitrary canonical reads or a refused save's ACK.
const sessions = new WeakMap()

function createReplayRevisionState(api) {
  const session = Object.freeze({})
  sessions.set(session, { api, chats: new Map() })
  return session
}

function bindReplayRevisionState(session, api, lane) {
  const state = sessions.get(session)
  if (!state || state.api !== api)
    throw new Error('replay revision state belongs to another adapter')
  const chat = (lane.chats || []).find((candidate) => candidate.appChatId === lane.chatId)
  // Hash the entire intended seed outside measured windows, including its
  // identity, scope and contents. Retain only its digest, never another history.
  const seedDigest = createHash('sha256')
    .update(JSON.stringify(chat ?? null))
    .digest('hex')
  const existing = state.chats.get(lane.chatId)
  if (existing) {
    if (existing.seedDigest !== seedDigest)
      throw new Error('replay seed changed within its owned session')
    return existing
  }
  const revision = chat?.persistenceRevision
  if (chat && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw new Error('replay seed requires a safe canonical revision')
  }
  const bound = {
    seedDigest,
    canonicalRevisions: new Map(chat ? [[lane.chatId, revision]] : []),
    invalid: false
  }
  state.chats.set(lane.chatId, bound)
  return bound
}

function assertReplaySaveContinuity(bound) {
  if (!bound.invalid) return
  const error = new Error(
    'T2 replay save has no trusted canonical base after a failed or unresolved effect'
  )
  error.code = 'T2_REPLAY_SAVE_REJECTED'
  throw error
}

function invalidateReplayRevisionState(bound) {
  bound.invalid = true
  bound.canonicalRevisions.clear()
}

module.exports = {
  createReplayRevisionState,
  bindReplayRevisionState,
  assertReplaySaveContinuity,
  invalidateReplayRevisionState
}
