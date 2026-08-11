#!/usr/bin/env node

const { execFileSync, fork } = require('child_process')
const { createHash, randomUUID } = require('crypto')
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('fs')
const { tmpdir } = require('os')
const { basename, dirname, join, relative, resolve } = require('path')
const { isDeepStrictEqual } = require('util')
const asar = require('@electron/asar')
const esbuild = require('esbuild')

const ROOT = resolve(__dirname, '..')
const DEFAULT_EVIDENCE = join(ROOT, '.local-only', 'channels-p2-proof-evidence.json')
const REQUEST_TIMEOUT_MS = 30_000

const EXPECTED_HOST_IPC = [
  'channels:agent:enroll',
  'channels:agent:grant',
  'channels:agent:overview',
  'channels:agent:revoke',
  'channels:agent:rotate',
  'channels:append',
  'channels:approve-human-review',
  'channels:audit',
  'channels:close',
  'channels:create',
  'channels:deny-human-review',
  'channels:human-reviews',
  'channels:issue-invite',
  'channels:list',
  'channels:migration-handoff',
  'channels:read',
  'channels:revoke-member'
]

const EXPECTED_MEMBER_IPC = [
  'channels:member:append',
  'channels:member:begin-join',
  'channels:member:confirm-join',
  'channels:member:disconnect',
  'channels:member:forget',
  'channels:member:list',
  'channels:member:reconnect',
  'channels:member:reset-local-history',
  'channels:member:resume',
  'channels:member:snapshot'
]

const PACKAGED_SURFACE_MARKERS = {
  main: [
    'channels:issue-invite',
    'channels:migration-handoff',
    'channels:member:begin-join',
    'channels:member:reset-local-history'
  ],
  preload: [
    'channelMemberships',
    'channels:changed',
    'migrationHandoff',
    'channels:member:begin-join'
  ],
  renderer: [
    'Confirm joins',
    'Compare each code out of band before the member confirms.',
    'Opened the retained read-only history for this revoked membership.',
    'People share stays available alongside it',
    'Migrated invitations',
    'Human posts stay manual.',
    'named in an active signed grant can mention that agent to start a bounded run'
  ]
}

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
    if (message.type !== 'response') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new RemoteWorkerError(this.label, message.error))
  }

  onExit(code, signal) {
    this.exited = true
    this.exitResult = { code, signal }
    const detail = this.output.map((entry) => `${entry.stream}: ${entry.text}`).join('\n')
    const error = new Error(
      `${this.label} exited code=${String(code)} signal=${String(signal)}${detail ? `\n${detail}` : ''}`
    )
    this.rejectReady(error)
    this.rejectAll(error)
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
        () => reject(new Error(`${this.label} did not become ready`)),
        timeoutMs
      )
      timeout.unref?.()
    })
    return Promise.race([this.readyPromise, timer])
  }

  request(command, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(new Error(`${this.label} is not running`))
    const id = randomUUID()
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new Error(`${this.label} ${command} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      this.child.send({ type: 'request', id, command, params })
    })
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
  let packageInput = ''
  let runs = 2
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence') evidencePath = resolve(argv[++index])
    else if (argv[index] === '--package') packageInput = resolve(argv[++index])
    else if (argv[index] === '--runs') runs = Number(argv[++index])
    else throw new Error(`unknown argument ${argv[index]}`)
  }
  if (!packageInput)
    throw new Error('--package must name the packaged app, app.asar, or package root')
  if (!Number.isInteger(runs) || runs < 1 || runs > 3) {
    throw new Error('--runs must be an integer from 1 through 3')
  }
  return { evidencePath, packageInput, runs }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertProof(condition, message) {
  if (!condition) throw new Error(`P2 proof assertion failed: ${message}`)
}

function verifySurfaceGroups(groups) {
  const summary = {}
  for (const [group, markers] of Object.entries(PACKAGED_SURFACE_MARKERS)) {
    const files = groups[group]
    assertProof(Array.isArray(files) && files.length > 0, `packaged ${group} bundle is missing`)
    const combined = files
      .map((file) =>
        Buffer.isBuffer(file.contents) ? file.contents.toString('utf8') : String(file.contents)
      )
      .join('\n')
    const missing = markers.filter((marker) => !combined.includes(marker))
    assertProof(missing.length === 0, `packaged ${group} surface is stale: ${missing.join(', ')}`)
    const entries = files
      .map((file) => ({
        path: file.path,
        bytes: Buffer.byteLength(file.contents),
        sha256: sha256(file.contents)
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
    summary[group] = {
      fileCount: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      digest: sha256(entries.map((entry) => `${entry.path}:${entry.sha256}`).join('\n')),
      markers: [...markers]
    }
  }
  return summary
}

function findAppAsars(root, found = []) {
  const stat = lstatSync(root)
  if (stat.isSymbolicLink()) return found
  if (stat.isFile()) {
    if (basename(root) === 'app.asar') found.push(root)
    return found
  }
  if (!stat.isDirectory()) return found
  for (const entry of readdirSync(root)) findAppAsars(join(root, entry), found)
  return found
}

function resolveAppAsar(packageInput) {
  assertProof(existsSync(packageInput), `package path does not exist: ${packageInput}`)
  if (statSync(packageInput).isFile()) {
    assertProof(basename(packageInput) === 'app.asar', 'package file must be app.asar')
    return packageInput
  }
  const direct = packageInput.endsWith('.app')
    ? join(packageInput, 'Contents', 'Resources', 'app.asar')
    : join(packageInput, 'resources', 'app.asar')
  if (existsSync(direct)) return direct
  const candidates = findAppAsars(packageInput)
  assertProof(
    candidates.length === 1,
    `expected one app.asar below package path, found ${candidates.length}`
  )
  return candidates[0]
}

function scanPackagedSurface(packageInput) {
  const appAsarPath = resolveAppAsar(packageInput)
  const archive = require('fs').readFileSync(appAsarPath)
  const paths = asar.listPackage(appAsarPath)
  const readGroup = (prefix) =>
    paths
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.js'))
      .map((entry) => ({
        path: entry.slice(1),
        contents: asar.extractFile(appAsarPath, entry.slice(1))
      }))
  const groups = {
    main: readGroup('/out/main/'),
    preload: readGroup('/out/preload/'),
    renderer: readGroup('/out/renderer/assets/')
  }
  return {
    artifact: relative(ROOT, appAsarPath) || basename(appAsarPath),
    bytes: archive.length,
    sha256: sha256(archive),
    groups: verifySurfaceGroups(groups)
  }
}

function contiguous(manifest) {
  return manifest.every((record, index) => record.sequence === index + 1)
}

function consensus(left, right) {
  return (
    left.highWaterSequence === right.highWaterSequence &&
    left.digest === right.digest &&
    isDeepStrictEqual(left.manifest, right.manifest)
  )
}

function aggregateWireMetrics(...states) {
  return states.reduce(
    (combined, state) => {
      const value = state?.wireMetrics || {}
      return {
        maxFrameBytes: Math.max(combined.maxFrameBytes, Number(value.maxFrameBytes || 0)),
        encryptedFrames: combined.encryptedFrames + Number(value.encryptedFrames || 0),
        handshakeFrames: combined.handshakeFrames + Number(value.handshakeFrames || 0),
        agentRouteCalls: combined.agentRouteCalls + Number(value.agentRouteCalls || 0),
        plaintextApplicationFrames:
          combined.plaintextApplicationFrames + Number(value.plaintextApplicationFrames || 0)
      }
    },
    {
      maxFrameBytes: 0,
      encryptedFrames: 0,
      handshakeFrames: 0,
      agentRouteCalls: 0,
      plaintextApplicationFrames: 0
    }
  )
}

async function waitForState(worker, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await worker.request('state')
    if (predicate(latest)) return latest
    await delay(50)
  }
  throw new Error(`${worker.label} state condition timed out; latest=${JSON.stringify(latest)}`)
}

async function runMission(input) {
  const startedAt = Date.now()
  const runRoot = join(input.workRoot, `run-${input.runNumber}`)
  const profiles = {
    relay: join(runRoot, 'relay'),
    host: join(runRoot, 'instance-1-host'),
    member: join(runRoot, 'instance-2-member')
  }
  for (const path of Object.values(profiles)) mkdirSync(path, { recursive: true })
  const workers = new Set()
  const starts = []

  const startWorker = async (label, workerRole, profile, instance, workerRelayUrl = '') => {
    const child = fork(input.workerBundle, [], {
      cwd: ROOT,
      env: {
        ...process.env,
        CHANNELS_P2_PROOF_ROLE: workerRole,
        CHANNELS_P2_PROOF_PROFILE: profile,
        CHANNELS_P2_PROOF_RELAY_URL: workerRelayUrl,
        TASKWRAITH_INSTANCE_ID: String(instance),
        NODE_PATH: join(ROOT, 'node_modules'),
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
      profileFingerprint: ready.profileFingerprint,
      userDataPath: ready.userDataPath,
      identityFingerprint: ready.identityFingerprint,
      pid: ready.pid,
      birthIdentity: ready.birthIdentity,
      handlerChannels: ready.handlerChannels
    })
    return worker
  }

  let relay
  let host
  let member
  let memberBeforeOfflineState
  let replayedMemberState
  let revokedMemberState
  try {
    relay = await startWorker('Relay', 'relay', profiles.relay, 'relay')
    const actualRelayUrl = `ws://127.0.0.1:${relay.ready.relayPort}`
    host = await startWorker('Host', 'host', profiles.host, 1, actualRelayUrl)
    member = await startWorker('Member', 'member', profiles.member, 2, actualRelayUrl)

    assertProof(
      new Set([host.ready.userDataPath, member.ready.userDataPath]).size === 2,
      'host and member profiles are not isolated'
    )
    assertProof(host.ready.pid !== member.ready.pid, 'host and member share a process')
    assertProof(
      isDeepStrictEqual(host.ready.handlerChannels, EXPECTED_HOST_IPC),
      'host did not register the exact closed IPC catalogue'
    )
    assertProof(
      isDeepStrictEqual(member.ready.handlerChannels, EXPECTED_MEMBER_IPC),
      'member did not register the exact closed IPC catalogue'
    )

    const created = await host.request('create', { ownerDisplayName: 'Host' })
    assertProof(typeof created.channelId === 'string', 'host controller did not create a Channel')
    const channelId = created.channelId
    const issued = await host.request('issueInvite')
    assertProof(issued.hostRoomOpened === true, 'host production service did not open the room')

    const began = await member.request('beginJoin', {
      inviteText: issued.payload,
      displayName: 'Member'
    })
    assertProof(began.accepted === true, 'member controller rejected the production invite')
    const memberCode = began.state.confirmCode
    assertProof(/^\d{6}$/.test(memberCode), 'member controller did not project a six-digit SAS')
    const hostAdmission = await waitForState(host, (state) =>
      state.pendingAdmissions.some((admission) => admission.displayName === 'Member')
    )
    const hostPending = hostAdmission.pendingAdmissions.find(
      (admission) => admission.displayName === 'Member'
    )
    assertProof(hostPending.confirmCode === memberCode, 'host/member SAS values do not match')

    const confirmed = await member.request('confirmJoin')
    assertProof(confirmed.accepted === true, 'member controller did not confirm the SAS join')
    assertProof(confirmed.state.phase === 'connected', 'member is not connected after confirmation')
    const memberId = confirmed.state.memberId
    const memberIdentityFingerprint = confirmed.state.identityFingerprint
    assertProof(typeof memberId === 'string', 'confirmed member id is missing')
    assertProof(
      typeof memberIdentityFingerprint === 'string' &&
        memberIdentityFingerprint !== host.ready.identityFingerprint,
      'host/member identities are missing or not distinct'
    )
    const admittedHost = await waitForState(
      host,
      (state) =>
        state.pendingAdmissions.length === 0 &&
        state.members.some(
          (candidate) => candidate.memberId === memberId && candidate.status === 'active'
        )
    )

    const [hostAppend, memberAppend] = await Promise.all([
      host.request('append', { content: 'host P2 process proof message' }),
      member.request('append', { content: 'member P2 process proof message' })
    ])
    assertProof(hostAppend.accepted === true, 'host controller append failed')
    assertProof(memberAppend.accepted === true, 'member controller append failed')
    const initialHostState = await waitForState(host, (state) => state.highWaterSequence === 2)
    const initialMemberState = await waitForState(member, (state) => state.highWaterSequence === 2)
    assertProof(contiguous(initialHostState.manifest), 'initial host history is not gapless')
    assertProof(
      consensus(initialHostState, initialMemberState),
      'initial host/member views diverged'
    )

    await member.request('disconnect')
    memberBeforeOfflineState = await member.request('state')
    await member.stop()
    const offlineAppend = await host.request('append', { content: 'host while member is offline' })
    assertProof(offlineAppend.accepted === true, 'host offline-window append failed')
    const offlineHostState = await waitForState(host, (state) => state.highWaterSequence === 3)

    member = await startWorker('Member restart', 'member', profiles.member, 2, actualRelayUrl)
    assertProof(
      member.ready.identityFingerprint === memberIdentityFingerprint,
      'member identity did not survive process restart'
    )
    assertProof(
      member.ready.recoveredHighWaterSequence === memberBeforeOfflineState.highWaterSequence,
      'member durable cursor did not survive process restart'
    )
    const reconnected = await member.request('reconnect', { channelId })
    assertProof(reconnected.accepted === true, 'member controller reconnect failed')
    replayedMemberState = await waitForState(member, (state) => state.highWaterSequence === 3)
    assertProof(
      consensus(offlineHostState, replayedMemberState),
      'member offline-gap replay does not match the host'
    )

    const postRestartAppend = await member.request('append', {
      content: 'member after durable restart'
    })
    assertProof(
      postRestartAppend.accepted === true,
      `member append after restart failed: phase=${postRestartAppend.state.phase} error=${postRestartAppend.state.error}`
    )
    const preRevokeHostState = await waitForState(host, (state) => state.highWaterSequence === 4)
    const preRevokeMemberState = await waitForState(
      member,
      (state) => state.highWaterSequence === 4
    )
    assertProof(
      consensus(preRevokeHostState, preRevokeMemberState),
      'views diverged before revocation'
    )

    const revoked = await host.request('revoke', { memberId })
    assertProof(revoked.accepted === true, 'host controller revocation failed')
    revokedMemberState = await waitForState(
      member,
      (state) => state.phase === 'revoked' && state.channelStatus === 'revoked'
    )
    const rejectedAppend = await member.request('append', {
      content: 'must stay local after revocation'
    })
    assertProof(rejectedAppend.accepted === false, 'revoked member append was accepted')
    const survivingAppend = await host.request('append', { content: 'host survives revocation' })
    assertProof(survivingAppend.accepted === true, 'host could not append after revocation')
    const postRevokeHostState = await waitForState(host, (state) => state.highWaterSequence === 5)
    const retainedRevokedState = await member.request('state')
    assertProof(
      retainedRevokedState.highWaterSequence === revokedMemberState.highWaterSequence,
      'revoked member history changed after removal'
    )

    await member.stop()
    member = await startWorker(
      'Revoked history restart',
      'member',
      profiles.member,
      2,
      actualRelayUrl
    )
    assertProof(
      member.ready.identityFingerprint === memberIdentityFingerprint,
      'revoked member identity did not survive the second restart'
    )
    assertProof(member.ready.recoveredChannelStatus === 'revoked', 'revoked state was not durable')
    const openedHistory = await member.request('reconnect', { channelId })
    assertProof(openedHistory.accepted === true, 'revoked history selector was rejected')
    assertProof(openedHistory.state.phase === 'revoked', 'revoked history reopened as writable')
    assertProof(openedHistory.state.connected === false, 'revoked history opened a connection')
    assertProof(
      String(openedHistory.state.notice).includes('read-only history'),
      'revoked history notice is not honest'
    )
    assertProof(
      openedHistory.state.wireMetrics.encryptedFrames === 0 &&
        openedHistory.state.wireMetrics.handshakeFrames === 0,
      'opening revoked history touched the relay'
    )

    const closed = await host.request('close')
    assertProof(closed.accepted === true, 'host controller close failed')
    const finalHostState = await waitForState(host, (state) => state.status === 'closed')
    assertProof(
      finalHostState.highWaterSequence === postRevokeHostState.highWaterSequence,
      'closing the Channel changed durable history'
    )
    const closedAppend = await host.request('append', { content: 'must not append after close' })
    assertProof(closedAppend.accepted === false, 'closed host Channel accepted a mutation')

    const wireMetrics = aggregateWireMetrics(
      finalHostState,
      memberBeforeOfflineState,
      revokedMemberState,
      openedHistory.state
    )
    assertProof(
      wireMetrics.plaintextApplicationFrames === 0,
      'an application request crossed the relay in plaintext'
    )
    assertProof(wireMetrics.encryptedFrames > 0, 'no encrypted application frames were observed')
    assertProof(
      wireMetrics.agentRouteCalls === 0,
      'P2 compatibility mission reached an agent route'
    )
    assertProof(wireMetrics.maxFrameBytes < 1024 * 1024, 'a frame reached the relay ceiling')
    const relayState = await relay.request('state')

    return {
      runNumber: input.runNumber,
      durationMs: Date.now() - startedAt,
      instances: starts.map((entry) => ({
        label: entry.label,
        instanceId: entry.instanceId,
        profileFingerprint: entry.profileFingerprint,
        identityFingerprint: entry.identityFingerprint,
        pid: entry.pid,
        birthIdentity: entry.birthIdentity
      })),
      ipcCatalogues: {
        host: EXPECTED_HOST_IPC,
        member: EXPECTED_MEMBER_IPC
      },
      admission: {
        memberId,
        sasMatchedBeforeConfirmation: true,
        hostProjectionClearedAfterConfirmation: admittedHost.pendingAdmissions.length === 0
      },
      initialConsensus: {
        highWaterSequence: initialHostState.highWaterSequence,
        digest: initialHostState.digest,
        manifest: initialHostState.manifest
      },
      offlineReplay: {
        cursorBefore: memberBeforeOfflineState.highWaterSequence,
        highWaterAfter: offlineHostState.highWaterSequence,
        recoveredIdentityFingerprint: member.ready.identityFingerprint,
        digest: replayedMemberState.digest
      },
      revocation: {
        retainedHighWaterSequence: retainedRevokedState.highWaterSequence,
        hostHighWaterSequence: postRevokeHostState.highWaterSequence,
        appendRejected: true,
        revokedHistoryOpenedOffline: true
      },
      finalHost: {
        status: finalHostState.status,
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
        isolatedTwoApplicationProcesses: true,
        exactClosedIpcCatalogues: true,
        sasVisibleAndMatchedOnBothSides: true,
        applicationFramesEncrypted: true,
        controllerAppendsShareGaplessOrder: true,
        durableOfflineReplayExactlyOnce: true,
        durableIdentitySurvivesRestart: true,
        revocationMakesHistoryReadOnly: true,
        revokedHistorySelectionOpensNoSocket: true,
        hostCloseRetainsHistory: true,
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
  const packageSurface = scanPackagedSurface(options.packageInput)
  const workRoot = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p2-proof-'))
  const workerBundle = join(workRoot, 'channels-p2-proof-worker.cjs')
  esbuild.buildSync({
    entryPoints: [join(ROOT, 'scripts', 'channels-p2-proof-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    outfile: workerBundle,
    sourcemap: false,
    logLevel: 'warning'
  })
  const workerBundleBytes = statSync(workerBundle).size
  const workerBundleSha256 = sha256(require('fs').readFileSync(workerBundle))
  const evidence = {
    schemaVersion: 1,
    proof: 'Channels P2 packaged-surface and two-process production-path mission',
    status: 'passed',
    sourceCommit,
    generatedAt: new Date().toISOString(),
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    p0Evidence:
      'User attestation in this task on 2026-08-09: unrelated-network two-Mac People proof passed.',
    packageSurface,
    workerBundle: { bytes: workerBundleBytes, sha256: workerBundleSha256 },
    runs: []
  }

  try {
    for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
      evidence.runs.push(await runMission({ runNumber, workRoot, workerBundle }))
    }
    const serialized = JSON.stringify(evidence, null, 2)
    for (const forbidden of [
      '"inviteToken"',
      '"roomId"',
      '"confirmCode"',
      '"content":',
      '"payload":',
      '/private/var/',
      '/Users/'
    ]) {
      assertProof(
        !serialized.includes(forbidden),
        `evidence contains forbidden secret/plaintext field ${forbidden}`
      )
    }
    mkdirSync(dirname(options.evidencePath), { recursive: true })
    const temporary = `${options.evidencePath}.${randomUUID()}.tmp`
    writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, options.evidencePath)
    process.stdout.write(
      JSON.stringify(
        {
          status: evidence.status,
          sourceCommit,
          packageArtifact: packageSurface.artifact,
          packageSha256: packageSurface.sha256,
          runs: evidence.runs.length,
          evidencePath: options.evidencePath,
          finalHighWaterSequences: evidence.runs.map((run) => run.finalHost.highWaterSequence),
          finalDigests: evidence.runs.map((run) => run.finalHost.digest)
        },
        null,
        2
      ) + '\n'
    )
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

module.exports = {
  PACKAGED_SURFACE_MARKERS,
  ProofWorker,
  parseArgs,
  verifySurfaceGroups
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(String(error.stack || error.message || error) + '\n')
    process.exitCode = 1
  })
}
