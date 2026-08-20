#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PUSH_PROTOCOL = 'taskwraith-push-trigger-v1'
const ALLOWED_REASONS = new Set(['runComplete', 'runFailed'])

function sharedApnsCollapseId(input) {
  const digest = crypto
    .createHash('sha256')
    .update([input.reason, input.threadId || '', input.runId || ''].join('|'))
    .digest('hex')
  return `tw1-${digest.slice(0, 56)}`
}

function pairIdFromIdentityPubKey(identityPublicKey) {
  const raw = Buffer.from(identityPublicKey, 'base64')
  if (raw.length !== 32 || raw.toString('base64') !== identityPublicKey) {
    throw new Error('P7 target identity is invalid')
  }
  return `iphone-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

function relayHttpBase(relayUrl) {
  const parsed = new URL(String(relayUrl || '').trim())
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('P7 gateway URL must not contain credentials, query, or fragment')
  }
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  else if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  else if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('P7 gateway URL must use ws/wss/http/https')
  }
  return parsed.toString().replace(/\/$/, '')
}

function triggerSigningString(input) {
  return [
    PUSH_PROTOCOL,
    'trigger',
    input.macIdentityPubKey,
    input.targetIphoneIdentityPubKey,
    input.reason,
    input.threadId || '',
    input.runId || '',
    input.taskId || '',
    input.collapseId,
    String(input.issuedAt),
    input.nonce
  ].join('|')
}

function rawEd25519PublicKey(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' })
  if (!Buffer.isBuffer(der) || der.length < 32) throw new Error('P7 Mac identity is invalid')
  return der.subarray(der.length - 32)
}

function buildTrigger(privateKey, targetIphoneIdentityPubKey, input) {
  if (!ALLOWED_REASONS.has(input.reason)) throw new Error('P7 reason is invalid')
  pairIdFromIdentityPubKey(targetIphoneIdentityPubKey)
  const publicKey = crypto.createPublicKey(privateKey)
  const macIdentityPubKey = rawEd25519PublicKey(publicKey).toString('base64')
  const trigger = {
    v: 1,
    macIdentityPubKey,
    targetIphoneIdentityPubKey,
    reason: input.reason,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    collapseId: sharedApnsCollapseId(input),
    issuedAt: input.issuedAt,
    nonce: input.nonce
  }
  trigger.sig = crypto
    .sign(null, Buffer.from(triggerSigningString(trigger), 'utf8'), privateKey)
    .toString('base64')
  return trigger
}

function ownerApnsConfigured(settings) {
  const config = settings && typeof settings === 'object' ? settings.apnsConfig : null
  return Boolean(config?.encryptedAuthKey || config?.keyId || config?.teamId)
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function selectedPhone(pairing, requestedPairId) {
  const devices = Array.isArray(pairing?.devices) ? pairing.devices : []
  const candidates = devices
    .map((device) => device?.iphoneIdentityPubKey)
    .filter((value) => typeof value === 'string' && value.length > 0)
  const selected = requestedPairId
    ? candidates.find((key) => pairIdFromIdentityPubKey(key) === requestedPairId)
    : candidates[0]
  if (!selected) throw new Error('P7 sending profile has no matching paired phone')
  return selected
}

async function runElectronTrigger(env = process.env) {
  if (env.TASKWRAITH_P7_CONFIRMED !== '1') {
    throw new Error('P7 trigger requires TASKWRAITH_P7_CONFIRMED=1')
  }
  const userDataPath = path.resolve(String(env.TASKWRAITH_P7_USER_DATA_PATH || ''))
  if (!path.isAbsolute(userDataPath) || userDataPath === path.parse(userDataPath).root) {
    throw new Error('P7 userData path must be an explicit bounded absolute path')
  }
  const identityPath = path.join(userDataPath, 'bridge', 'remote-mac-identity.json')
  const pairingPath = path.join(userDataPath, 'bridge', 'remote-pairing.json')
  const settingsPath = path.join(userDataPath, 'settings.json')
  const settings = fs.existsSync(settingsPath) ? loadJson(settingsPath) : {}
  if (ownerApnsConfigured(settings)) {
    throw new Error('P7 sending profile still contains owner APNs credentials')
  }

  const { app, safeStorage } = require('electron')
  await app.whenReady()
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('P7 cannot decrypt the Mac identity while safeStorage is unavailable')
  }
  const persistedIdentity = loadJson(identityPath)
  const privateDerBase64 = safeStorage.decryptString(
    Buffer.from(persistedIdentity.encryptedKey, 'base64')
  )
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateDerBase64, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  const target = selectedPhone(loadJson(pairingPath), env.TASKWRAITH_P7_PAIR_ID)
  const reason = env.TASKWRAITH_P7_REASON || 'runComplete'
  const threadId = env.TASKWRAITH_P7_THREAD_ID || `p7-thread-${Date.now()}`
  const runId = env.TASKWRAITH_P7_RUN_ID || `p7-run-${Date.now()}`
  const trigger = buildTrigger(privateKey, target, {
    reason,
    threadId,
    runId,
    taskId: env.TASKWRAITH_P7_TASK_ID || 'p7-real-device-gate',
    issuedAt: Date.now(),
    nonce: crypto.randomBytes(16).toString('base64')
  })
  const endpoint = `${relayHttpBase(env.TASKWRAITH_P7_GATEWAY_URL)}/v1/push/trigger`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(trigger)
  })
  const responseBody = await response.json().catch(() => ({}))
  const receipt = {
    schemaVersion: 1,
    kind: 'taskwraith-push-p7-tier2-trigger',
    accepted: response.status === 200,
    statusCode: response.status,
    coalesced: responseBody?.coalesced === true,
    pairId: pairIdFromIdentityPubKey(target),
    reason,
    collapseId: trigger.collapseId,
    issuedAt: trigger.issuedAt
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
  app.quit()
  if (!receipt.accepted) process.exitCode = 1
  return receipt
}

module.exports = {
  buildTrigger,
  ownerApnsConfigured,
  pairIdFromIdentityPubKey,
  relayHttpBase,
  runElectronTrigger,
  sharedApnsCollapseId,
  triggerSigningString
}

if (require.main === module) {
  runElectronTrigger().catch((error) => {
    process.stderr.write(
      `P7 trigger failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    try {
      require('electron').app.quit()
    } catch {
      // Plain Node invocation reaches here; the error above is sufficient.
    }
    process.exitCode = 1
  })
}
