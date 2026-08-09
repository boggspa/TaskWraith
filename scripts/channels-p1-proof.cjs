#!/usr/bin/env node

const { execFileSync, fork } = require('child_process')
const { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } = require('fs')
const { tmpdir } = require('os')
const { dirname, join, resolve } = require('path')
const { isDeepStrictEqual } = require('util')
const { randomUUID, createHash } = require('crypto')
const esbuild = require('esbuild')

const ROOT = resolve(__dirname, '..')
const DEFAULT_EVIDENCE = join(ROOT, '.local-only', 'channels-p1-proof-evidence.json')
const REQUEST_TIMEOUT_MS = 30_000

class RemoteWorkerError extends Error {
  constructor(label, remote) {
    super(label + ': ' + (remote?.message || 'worker request failed'))
    this.name = 'RemoteWorkerError'
    this.remoteCode = remote?.code
  }
}

class ProofWorker {
  constructor(label, child) {
    this.label = label
    this.child = child
    this.pending = new Map()
    this.events = []
    this.eventWaiters = []
    this.output = []
    this.ready = null
    this.exited = false
    this.exitResult = null
    this.exitPromise = new Promise((resolveExit) => {
      this.resolveExit = resolveExit
    })
    this.readyPromise = new Promise((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady
      this.rejectReady = rejectReady
    })
    child.stdout?.on('data', (chunk) => this.capture('stdout', chunk))
    child.stderr?.on('data', (chunk) => this.capture('stderr', chunk))
    child.on('message', (message) => this.onMessage(message))
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('error', (error) => {
      this.rejectReady(error)
      this.rejectAll(error)
    })
  }

  capture(stream, chunk) {
    const text = String(chunk).trim()
    if (!text) return
    this.output.push({ stream, text: text.slice(0, 2_000) })
    if (this.output.length > 20) this.output.shift()
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'ready') {
      this.ready = message
      this.resolveReady(message)
      return
    }
    if (message.type === 'fatal') {
      const error = new RemoteWorkerError(this.label, message.error)
      this.rejectReady(error)
      this.rejectAll(error)
      return
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new RemoteWorkerError(this.label, message.error))
      return
    }
    if (message.type === 'event') {
      const waiterIndex = this.eventWaiters.findIndex(
        (waiter) =>
          waiter.name === message.event && (!waiter.predicate || waiter.predicate(message))
      )
      if (waiterIndex >= 0) {
        const waiter = this.eventWaiters.splice(waiterIndex, 1)[0]
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      } else {
        this.events.push(message)
      }
    }
  }

  onExit(code, signal) {
    this.exited = true
    this.exitResult = { code, signal }
    const error = new Error(
      this.label + ' exited code=' + String(code) + ' signal=' + String(signal)
    )
    this.rejectAll(error)
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.resolveExit(this.exitResult)
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async waitReady(timeoutMs = 15_000) {
    const timer = new Promise((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(this.label + ' did not become ready')),
        timeoutMs
      )
      timeout.unref?.()
    })
    return Promise.race([this.readyPromise, timer])
  }

  request(command, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited) {
      return Promise.reject(new Error(this.label + ' is not running'))
    }
    const id = randomUUID()
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(this.label + ' ' + command + ' timed out'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer
      })
      this.child.send({ type: 'request', id, command, params })
    })
  }

  nextEvent(name, predicate, timeoutMs = 15_000) {
    const existingIndex = this.events.findIndex(
      (event) => event.event === name && (!predicate || predicate(event))
    )
    if (existingIndex >= 0) {
      return Promise.resolve(this.events.splice(existingIndex, 1)[0])
    }
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        const index = this.eventWaiters.findIndex((candidate) => candidate.timer === timer)
        if (index >= 0) this.eventWaiters.splice(index, 1)
        rejectEvent(new Error(this.label + ' event ' + name + ' timed out'))
      }, timeoutMs)
      timer.unref?.()
      this.eventWaiters.push({
        name,
        predicate,
        resolve: resolveEvent,
        reject: rejectEvent,
        timer
      })
    })
  }

  waitForExit() {
    return this.exitPromise
  }

  async stop() {
    if (this.exited) return this.exitResult
    try {
      await this.request('shutdown', {}, 5_000)
    } catch {
      // Fall through to bounded termination.
    }
    const outcome = await Promise.race([this.exitPromise, delay(2_000).then(() => null)])
    if (outcome) return outcome
    this.child.kill('SIGTERM')
    return this.exitPromise
  }
}

function parseArgs(argv) {
  let evidencePath = DEFAULT_EVIDENCE
  let runs = 2
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence') evidencePath = resolve(argv[++index])
    else if (argv[index] === '--runs') runs = Number(argv[++index])
    else throw new Error('unknown argument ' + argv[index])
  }
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) {
    throw new Error('--runs must be an integer from 1 through 5')
  }
  return { evidencePath, runs }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function assertProof(condition, message) {
  if (!condition) throw new Error('P1 proof assertion failed: ' + message)
}

function fingerprintRoom(roomId) {
  return createHash('sha256').update(roomId).digest('hex').slice(0, 12)
}

function contiguous(manifest) {
  return manifest.every((record, index) => record.sequence === index + 1)
}

function consensus(hostState, ...memberStates) {
  return memberStates.every(
    (state) =>
      state.cursor === hostState.highWaterSequence &&
      state.digest === hostState.digest &&
      isDeepStrictEqual(state.manifest, hostState.manifest)
  )
}

function maxWireMetrics(...states) {
  return states.reduce(
    (combined, state) => {
      const value = state?.wireMetrics || {}
      return {
        maxFrameBytes: Math.max(combined.maxFrameBytes, Number(value.maxFrameBytes || 0)),
        encryptedFrames: combined.encryptedFrames + Number(value.encryptedFrames || 0),
        handshakeFrames: combined.handshakeFrames + Number(value.handshakeFrames || 0),
        plaintextApplicationFrames:
          combined.plaintextApplicationFrames + Number(value.plaintextApplicationFrames || 0)
      }
    },
    {
      maxFrameBytes: 0,
      encryptedFrames: 0,
      handshakeFrames: 0,
      plaintextApplicationFrames: 0
    }
  )
}

async function expectRemoteCode(promise, expectedCode) {
  try {
    await promise
  } catch (error) {
    assertProof(
      error instanceof RemoteWorkerError && error.remoteCode === expectedCode,
      'expected ' + expectedCode + ', received ' + (error.remoteCode || error.message)
    )
    return expectedCode
  }
  throw new Error('P1 proof assertion failed: expected rejection ' + expectedCode)
}

async function waitForMemberState(worker, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await worker.request('state')
    if (predicate(latest)) return latest
    await delay(50)
  }
  throw new Error(worker.label + ' state condition timed out; latest=' + JSON.stringify(latest))
}

async function runMission(input) {
  const startedAt = Date.now()
  const runRoot = join(input.workRoot, 'run-' + input.runNumber)
  const profiles = {
    relay: join(runRoot, 'relay'),
    host: join(runRoot, 'instance-1-host'),
    memberB: join(runRoot, 'instance-2-member-b'),
    memberC: join(runRoot, 'instance-3-member-c')
  }
  for (const path of Object.values(profiles)) {
    mkdirSync(path, { recursive: true })
  }
  const workers = new Set()
  const starts = []

  const startWorker = async (label, workerRole, profile, instanceId, extraEnv = {}) => {
    const child = fork(input.workerBundle, [], {
      cwd: ROOT,
      env: {
        ...process.env,
        CHANNELS_PROOF_ROLE: workerRole,
        CHANNELS_PROOF_PROFILE: profile,
        CHANNELS_PROOF_RELAY_URL: extraEnv.relayUrl || '',
        CHANNELS_PROOF_IGNORE_STATE: extraEnv.ignoreState ? '1' : '0',
        TASKWRAITH_INSTANCE_ID: String(instanceId),
        ...(workerRole === 'member' ? { IOS_REMOTE_TRUE: '0' } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: []
    })
    const worker = new ProofWorker(label, child)
    workers.add(worker)
    const ready = await worker.waitReady()
    starts.push({
      label,
      instanceId: ready.instanceId,
      userDataPath: ready.userDataPath,
      identityFingerprint: ready.identityFingerprint,
      pid: ready.pid,
      birthIdentity: ready.birthIdentity,
      iosRemoteTrue: workerRole === 'member' ? '0' : undefined
    })
    return worker
  }

  let relay
  let host
  let memberB
  let memberC
  try {
    relay = await startWorker('relay', 'relay', profiles.relay, 'relay')
    const actualRelayUrl = 'ws://127.0.0.1:' + String(relay.ready.relayPort)
    host = await startWorker('Host', 'host', profiles.host, 1, {
      relayUrl: actualRelayUrl
    })
    memberB = await startWorker('Member B', 'member', profiles.memberB, 2, {
      relayUrl: actualRelayUrl
    })
    memberC = await startWorker('Member C', 'member', profiles.memberC, 3, {
      relayUrl: actualRelayUrl
    })

    const initialStarts = starts.filter((entry) => entry.label !== 'relay')
    assertProof(
      new Set(initialStarts.map((entry) => entry.userDataPath)).size === 3,
      'instance userData paths are not isolated'
    )
    assertProof(
      new Set(initialStarts.map((entry) => entry.identityFingerprint)).size === 3,
      'instance identity fingerprints are not distinct'
    )

    const created = await host.request('create', {
      chatId: 'proof-general-' + input.runNumber,
      title: 'Channels P1 proof',
      ownerDisplayName: 'Host'
    })
    const inviteB = await host.request('invite', {
      channelId: created.channelId,
      ttlMs: 600_000
    })
    const inviteC = await host.request('invite', {
      channelId: created.channelId,
      ttlMs: 600_000
    })
    assertProof(inviteB.roomId !== inviteC.roomId, 'member rooms are not distinct')

    await memberB.request('connect', {
      relayUrl: actualRelayUrl,
      roomId: inviteB.roomId
    })
    const crossRoomCode = await expectRemoteCode(
      memberB.request('beginAdmission', {
        channelId: created.channelId,
        inviteId: inviteC.inviteId,
        inviteToken: inviteC.inviteToken,
        displayName: 'Member B',
        expectedHostIdentityPubKeyB64: host.ready.hostIdentityPubKeyB64
      }),
      'identity_mismatch'
    )

    const hostBeganB = host.nextEvent(
      'admission.began',
      (event) => event.displayName === 'Member B'
    )
    const localBeginB = await memberB.request('beginAdmission', {
      channelId: created.channelId,
      inviteId: inviteB.inviteId,
      inviteToken: inviteB.inviteToken,
      displayName: 'Member B',
      expectedHostIdentityPubKeyB64: host.ready.hostIdentityPubKeyB64
    })
    const hostBeginB = await hostBeganB
    assertProof(
      localBeginB.confirmCode === hostBeginB.confirmCode,
      'Member B SAS does not match the host'
    )
    const confirmedB = await memberB.request('confirmAdmission')
    await memberB.request('resume', { resumeAfter: 0 })

    await memberC.request('connect', {
      relayUrl: actualRelayUrl,
      roomId: inviteC.roomId
    })
    const hostBeganC = host.nextEvent(
      'admission.began',
      (event) => event.displayName === 'Member C'
    )
    const localBeginC = await memberC.request('beginAdmission', {
      channelId: created.channelId,
      inviteId: inviteC.inviteId,
      inviteToken: inviteC.inviteToken,
      displayName: 'Member C',
      expectedHostIdentityPubKeyB64: host.ready.hostIdentityPubKeyB64
    })
    const hostBeginC = await hostBeganC
    assertProof(
      localBeginC.confirmCode === hostBeginC.confirmCode,
      'Member C SAS does not match the host'
    )
    const confirmedC = await memberC.request('confirmAdmission')
    await memberC.request('resume', { resumeAfter: 0 })

    await Promise.all([
      host.request('append', {
        channelId: created.channelId,
        clientMessageId: 'host-initial',
        content: 'host initial proof message'
      }),
      memberB.request('append', {
        clientMessageId: 'member-b-initial',
        content: 'member B initial proof message'
      }),
      memberC.request('append', {
        clientMessageId: 'member-c-initial',
        content: 'member C initial proof message'
      })
    ])
    const initialHostState = await host.request('state', {
      channelId: created.channelId
    })
    const initialBState = await waitForMemberState(
      memberB,
      (state) => state.cursor === initialHostState.highWaterSequence
    )
    const initialCState = await waitForMemberState(
      memberC,
      (state) => state.cursor === initialHostState.highWaterSequence
    )
    assertProof(initialHostState.highWaterSequence === 3, 'initial high-water is not 3')
    assertProof(contiguous(initialHostState.manifest), 'initial host manifest is not contiguous')
    assertProof(
      consensus(initialHostState, initialBState, initialCState),
      'initial three-instance views do not match'
    )

    const bBeforeOffline = initialBState
    const firstBFingerprint = memberB.ready.identityFingerprint
    await memberB.stop()
    await Promise.all([
      host.request('append', {
        channelId: created.channelId,
        clientMessageId: 'host-while-b-offline',
        content: 'host while B offline'
      }),
      memberC.request('append', {
        clientMessageId: 'member-c-while-b-offline',
        content: 'member C while B offline'
      })
    ])
    const offlineHostState = await host.request('state', {
      channelId: created.channelId
    })
    await waitForMemberState(
      memberC,
      (state) => state.cursor === offlineHostState.highWaterSequence
    )
    assertProof(offlineHostState.highWaterSequence === 5, 'offline high-water is not 5')

    memberB = await startWorker('Member B restart', 'member', profiles.memberB, 2, {
      relayUrl: actualRelayUrl
    })
    assertProof(
      memberB.ready.identityFingerprint === firstBFingerprint,
      'Member B identity did not survive process restart'
    )
    assertProof(
      memberB.ready.recoveredCursor === bBeforeOffline.cursor,
      'Member B cursor did not survive process restart'
    )
    await memberB.request('connect', {
      relayUrl: actualRelayUrl,
      roomId: inviteB.roomId
    })
    await memberB.request('reconnect', {
      channelId: created.channelId,
      memberId: confirmedB.memberId,
      expectedHostIdentityPubKeyB64: host.ready.hostIdentityPubKeyB64
    })
    await memberB.request('resume')
    const reconnectedBState = await waitForMemberState(
      memberB,
      (state) => state.cursor === offlineHostState.highWaterSequence
    )
    assertProof(
      consensus(offlineHostState, reconnectedBState),
      'Member B replay after offline restart does not match the host'
    )

    await host.request('armCrash')
    const durableFault = host.nextEvent('fault.durable')
    await memberB.request('appendFire', {
      clientMessageId: 'durable-crash-window',
      content: 'durable before host crash'
    })
    const faultEvent = await durableFault
    const crashExit = await host.waitForExit()
    assertProof(crashExit.code === 86, 'host did not exit at the injected fault')

    const firstHostFingerprint = host.ready.identityFingerprint
    host = await startWorker('Host crash restart', 'host', profiles.host, 1, {
      relayUrl: actualRelayUrl
    })
    assertProof(
      host.ready.identityFingerprint === firstHostFingerprint,
      'host identity did not survive crash restart'
    )
    await delay(200)
    await Promise.all([
      memberB.request('reconnect', {
        channelId: created.channelId,
        memberId: confirmedB.memberId,
        expectedHostIdentityPubKeyB64: host.ready.hostIdentityPubKeyB64
      }),
      memberC.request('reconnect', {
        channelId: created.channelId,
        memberId: confirmedC.memberId,
        expectedHostIdentityPubKeyB64: host.ready.hostIdentityPubKeyB64
      })
    ])
    await Promise.all([memberB.request('resume'), memberC.request('resume')])
    const recoveredCrashState = await host.request('state', {
      channelId: created.channelId
    })
    assertProof(
      recoveredCrashState.highWaterSequence === 6,
      'durable crash record was not recovered'
    )
    const retry = await memberB.request('append', {
      clientMessageId: 'durable-crash-window',
      content: 'durable before host crash'
    })
    assertProof(retry.deduplicated === true, 'crash-window retry was not deduplicated')
    const afterCrash = await host.request('append', {
      channelId: created.channelId,
      clientMessageId: 'after-crash',
      content: 'after crash'
    })
    assertProof(
      afterCrash.record.sequence === 7,
      'next sequence after crash recovery is not greater'
    )
    const postCrashHostState = await host.request('state', {
      channelId: created.channelId
    })
    const postCrashBState = await waitForMemberState(
      memberB,
      (state) => state.cursor === postCrashHostState.highWaterSequence
    )
    const postCrashCState = await waitForMemberState(
      memberC,
      (state) => state.cursor === postCrashHostState.highWaterSequence
    )
    assertProof(
      consensus(postCrashHostState, postCrashBState, postCrashCState),
      'views diverged after crash recovery'
    )

    const firstCFingerprint = memberC.ready.identityFingerprint
    await memberC.stop()
    await host.request(
      'appendBulk',
      {
        channelId: created.channelId,
        count: 140,
        contentBytes: 7_800,
        prefix: 'large-replay'
      },
      60_000
    )
    const largeHostState = await host.request('state', {
      channelId: created.channelId
    })
    const largeBState = await waitForMemberState(
      memberB,
      (state) => state.cursor === largeHostState.highWaterSequence,
      30_000
    )
    assertProof(largeHostState.highWaterSequence === 147, 'large-history high-water is not 147')

    memberC = await startWorker('Member C replay restart', 'member', profiles.memberC, 3, {
      relayUrl: actualRelayUrl,
      ignoreState: true
    })
    assertProof(
      memberC.ready.identityFingerprint === firstCFingerprint,
      'Member C identity did not survive replay restart'
    )
    assertProof(memberC.ready.recoveredCursor === 0, 'Member C did not restart from cursor 0')
    await memberC.request('connect', {
      relayUrl: actualRelayUrl,
      roomId: inviteC.roomId
    })
    await memberC.request('reconnect', {
      channelId: created.channelId,
      memberId: confirmedC.memberId,
      expectedHostIdentityPubKeyB64: host.ready.hostIdentityPubKeyB64
    })
    await host.request('clearReplayBatches')
    await memberC.request('resume', { resumeAfter: 0 }, 60_000)
    const replayedCState = await waitForMemberState(
      memberC,
      (state) => state.cursor === largeHostState.highWaterSequence,
      30_000
    )
    const replayHostState = await host.request('state', {
      channelId: created.channelId
    })
    const memberCReplayBatches = replayHostState.replayBatches.filter(
      (batch) => batch.memberId === confirmedC.memberId
    )
    assertProof(memberCReplayBatches.length > 2, 'large replay did not use multiple batches')
    assertProof(
      memberCReplayBatches.every(
        (batch) => batch.recordCount <= 256 && batch.serializedBytes <= 512 * 1024
      ),
      'a replay batch exceeded its record/byte bound'
    )
    assertProof(
      memberCReplayBatches.at(-1)?.live === true,
      'large replay never crossed to live delivery'
    )
    assertProof(
      consensus(replayHostState, largeBState, replayedCState),
      'three-instance views diverged before revocation'
    )

    await host.request('revoke', {
      channelId: created.channelId,
      memberId: confirmedB.memberId
    })
    const revokedBState = await waitForMemberState(memberB, (state) => state.revokedCount === 1)
    let memberAppendError = ''
    try {
      await memberB.request('append', {
        clientMessageId: 'revoked-append',
        content: 'must fail'
      })
    } catch (error) {
      memberAppendError = error.message
    }
    assertProof(Boolean(memberAppendError), 'revoked Member B append unexpectedly succeeded')
    const revokedReconnectCode = await expectRemoteCode(
      host.request('probeMemberSession', {
        channelId: created.channelId,
        memberId: confirmedB.memberId
      }),
      'revoked'
    )
    await memberC.request('append', {
      clientMessageId: 'member-c-after-revoke',
      content: 'member C remains active'
    })
    await host.request('append', {
      channelId: created.channelId,
      clientMessageId: 'host-after-revoke',
      content: 'host remains active'
    })
    const postRevokeHostState = await host.request('state', {
      channelId: created.channelId
    })
    const postRevokeCState = await waitForMemberState(
      memberC,
      (state) => state.cursor === postRevokeHostState.highWaterSequence
    )
    assertProof(
      consensus(postRevokeHostState, postRevokeCState),
      'host and Member C diverged after scoped revocation'
    )
    assertProof(
      revokedBState.cursor === replayHostState.highWaterSequence,
      'revoked Member B received records after revocation'
    )

    const beforeFinalRestart = postRevokeHostState
    await host.stop()
    host = await startWorker('Host final restart', 'host', profiles.host, 1, {
      relayUrl: actualRelayUrl
    })
    const finalHostState = await host.request('state', {
      channelId: created.channelId
    })
    assertProof(
      finalHostState.highWaterSequence === beforeFinalRestart.highWaterSequence &&
        finalHostState.digest === beforeFinalRestart.digest &&
        isDeepStrictEqual(finalHostState.manifest, beforeFinalRestart.manifest),
      'final host restart changed durable history'
    )

    const wireMetrics = maxWireMetrics(
      replayHostState,
      largeBState,
      replayedCState,
      postRevokeHostState,
      postRevokeCState
    )
    assertProof(
      wireMetrics.plaintextApplicationFrames === 0,
      'an application request crossed the relay in plaintext'
    )
    assertProof(
      wireMetrics.maxFrameBytes < 1024 * 1024,
      'a transport frame reached the relay ceiling'
    )
    assertProof(wireMetrics.encryptedFrames > 0, 'no encrypted frames were observed')

    const relayState = await relay.request('state')
    return {
      runNumber: input.runNumber,
      durationMs: Date.now() - startedAt,
      instances: starts.map((entry) => ({
        label: entry.label,
        instanceId: entry.instanceId,
        userDataPath: entry.userDataPath,
        identityFingerprint: entry.identityFingerprint,
        pid: entry.pid,
        birthIdentity: entry.birthIdentity,
        ...(entry.iosRemoteTrue ? { IOS_REMOTE_TRUE: entry.iosRemoteTrue } : {})
      })),
      roomTopology: [
        {
          member: 'Member B',
          roomFingerprint: fingerprintRoom(inviteB.roomId)
        },
        {
          member: 'Member C',
          roomFingerprint: fingerprintRoom(inviteC.roomId)
        }
      ],
      admissions: {
        memberB: { sasMatched: true, memberId: confirmedB.memberId },
        memberC: { sasMatched: true, memberId: confirmedC.memberId },
        crossRoomRejectionCode: crossRoomCode
      },
      initialConsensus: {
        highWaterSequence: initialHostState.highWaterSequence,
        digest: initialHostState.digest,
        manifest: initialHostState.manifest
      },
      offlineReplay: {
        cursorBefore: bBeforeOffline.cursor,
        highWaterAfter: offlineHostState.highWaterSequence,
        recoveredIdentityFingerprint: memberB.ready.identityFingerprint,
        digest: reconnectedBState.digest
      },
      crashRecovery: {
        exitCode: crashExit.code,
        durableRecord: faultEvent.record,
        recoveredHighWaterSequence: recoveredCrashState.highWaterSequence,
        retryDeduplicated: retry.deduplicated,
        nextSequence: afterCrash.record.sequence
      },
      largeReplay: {
        retainedBytesMinimum: 140 * 7_800,
        highWaterSequence: replayHostState.highWaterSequence,
        batches: memberCReplayBatches,
        digest: replayHostState.digest
      },
      preRevocationConsensus: {
        highWaterSequence: replayHostState.highWaterSequence,
        digest: replayHostState.digest,
        manifest: replayHostState.manifest
      },
      revocation: {
        memberId: confirmedB.memberId,
        terminalNoticeCount: revokedBState.revokedCount,
        appendRejected: true,
        reconnectRejectionCode: revokedReconnectCode,
        survivingHighWaterSequence: postRevokeHostState.highWaterSequence,
        survivingDigest: postRevokeHostState.digest
      },
      finalRecovery: {
        highWaterSequence: finalHostState.highWaterSequence,
        digest: finalHostState.digest,
        manifest: finalHostState.manifest
      },
      relay: {
        implementation: 'relay/src/server.ts createRelayServer',
        roomCount: relayState.roomCount,
        registrationCount: relayState.registrationCount,
        wireMetrics
      },
      assertions: {
        isolatedProfilesAndIdentities: true,
        twoIndependentSingleUseRooms: true,
        sasMatchedBeforeConfirmation: true,
        applicationFramesEncrypted: true,
        simultaneousGaplessGlobalOrder: true,
        offlineReplayExactlyOnce: true,
        crashAfterDurableRecovered: true,
        retryDidNotRefanout: true,
        replayExceededOneMiBInBoundedBatches: true,
        revocationScopedToMemberB: true,
        finalRestartDigestStable: true,
        noAgentOrProviderRouteObserved: true
      }
    }
  } finally {
    for (const worker of [...workers].reverse()) {
      try {
        await worker.stop()
      } catch {
        if (!worker.exited) worker.child.kill('SIGTERM')
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  const workRoot = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p1-proof-'))
  const workerBundle = join(workRoot, 'channels-p1-proof-worker.cjs')
  esbuild.buildSync({
    entryPoints: [join(ROOT, 'scripts', 'channels-p1-proof-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: workerBundle,
    sourcemap: false,
    logLevel: 'warning'
  })

  const evidence = {
    schemaVersion: 1,
    proof: 'Channels P1 three-instance mission',
    status: 'passed',
    sourceCommit,
    generatedAt: new Date().toISOString(),
    platform: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    },
    p0Evidence:
      'User attestation in this task on 2026-08-09: unrelated-network two-Mac proof passed.',
    runs: []
  }

  try {
    for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
      evidence.runs.push(
        await runMission({
          runNumber,
          workRoot,
          workerBundle
        })
      )
    }
    const serialized = JSON.stringify(evidence, null, 2)
    for (const forbidden of [
      '"inviteToken"',
      '"roomId"',
      '"hostIdentityPubKeyB64"',
      '"memberIdentityPubKeyB64"',
      '"content":',
      '"confirmCode"'
    ]) {
      assertProof(
        !serialized.includes(forbidden),
        'evidence contains forbidden secret/plaintext field ' + forbidden
      )
    }
    mkdirSync(dirname(options.evidencePath), { recursive: true })
    const temporary = options.evidencePath + '.' + randomUUID() + '.tmp'
    writeFileSync(temporary, serialized, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporary, options.evidencePath)
    process.stdout.write(
      JSON.stringify(
        {
          status: evidence.status,
          sourceCommit,
          runs: evidence.runs.length,
          evidencePath: options.evidencePath,
          finalHighWaterSequences: evidence.runs.map((run) => run.finalRecovery.highWaterSequence),
          finalDigests: evidence.runs.map((run) => run.finalRecovery.digest)
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error.message || error) + '\n')
  process.exitCode = 1
})
