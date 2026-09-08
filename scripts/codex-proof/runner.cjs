[read_file: lines 1-631 of 631]
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fingerprint, collectSecrets, createRedactor, writeEvidence } = require('./common.cjs')
const { createProofPlan, materializeCase } = require('./plan.cjs')
const { openAppServer, catalogue, methodProperties, toolCallParams } = require('./protocol.cjs')
const {
  validateLive,
  launchEnvironment,
  acquireHome,
  scanNativeState,
  readEvents,
  nativeSchemas
} = require('./runtime.cjs')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const unsupported = (reason) => ({ status: 'inconclusive', reason })
function resultSummary(value) {
  return {
    status: 'observed',
    isError: value?.isError === true,
    resultSha256: fingerprint(value ?? null)
  }
}
function statusTools(result) {
  const servers = result?.data || result?.servers || []
  return servers.find((server) => server.name === 'TaskWraith')?.tools || null
}
function threadIdOf(result) {
  return result?.thread?.id || result?.threadId
}
function gatewayName(catalogueValue, suffix) {
  return (
    catalogueValue?.tools.find((tool) => tool.name === suffix || tool.name.endsWith('__' + suffix))
      ?.name || suffix
  )
}

/** Retain a notification listener before the RPC to cover fast completion. */
async function executeTurn(client, params, { timeoutMs = 60000, until } = {}) {
  let completed = false
  let turnId
  const onEvent = (event) => {
    if (event.method === 'turn/completed' && event.params?.threadId === params.threadId)
      completed = true
  }
  client.events.on('notification', onEvent)
  try {
    const response = await client.request('turn/start', params)
    turnId = response?.turn?.id
    const deadline = Date.now() + timeoutMs
    while (!completed && Date.now() < deadline) {
      if (until?.()) return { status: 'observed', active: true, turnId }
      await delay(25)
    }
    return completed
      ? { status: 'observed', completed: true, turnId }
      : { ...unsupported('turn_timeout'), turnId }
  } finally {
    client.events.off('notification', onEvent)
    // Retained-child caller owns interruption when an active hold was observed.
    if (!completed && !until?.() && turnId) {
      await client.request('turn/interrupt', { threadId: params.threadId, turnId }).catch(() => {})
    }
  }
}

async function invokeProbe(client, index, threadId, call, eventFile, timeoutMs) {
  const before = readEvents(eventFile).length
  let outcome
  try {
    let params
    try {
      params = toolCallParams(index, threadId, call)
    } catch {
      /* installed version may need a native turn */
    }
    if (params) {
      outcome = {
        ...resultSummary(await client.request('mcpServer/tool/call', params)),
        transport: 'native-tool-call'
      }
    } else {
      outcome = {
        ...(await executeTurn(
          client,
          {
            threadId,
            input: [
              {
                type: 'text',
                text_elements: [],
                text:
                  'Probe only. Call exactly the TaskWraith tool ' +
                  call.name +
                  ' once with these JSON arguments: ' +
                  JSON.stringify(call.arguments || {}) +
                  '. Do not call any other tools. Report the result briefly; do not modify files or request credentials.'
              }
            ]
          },
          { timeoutMs }
        )),
        transport: 'native-turn'
      }
    }
  } catch (error) {
    outcome = {
      status: 'inconclusive',
      reason: 'probe_rpc_or_turn_failed',
      rpcCode: error.rpcCode || null
    }
  }
  const evidence = readEvents(eventFile).slice(before)
  const calls = evidence.filter((event) => event.kind === 'tool-call' && event.tool === call.name)
  const results = evidence.filter(
    (event) =>
      event.kind === 'tool-result' &&
      calls.some((start) => start.pid === event.pid && start.requestId === event.requestId)
  )
  return {
    ...outcome,
    tool: call.name,
    bridgeCallObserved: calls.length > 0,
    witnesses: calls,
    results,
    // An RPC/model success without actual bridge traffic is never proof.
    status: calls.length && results.length ? 'observed' : 'inconclusive'
  }
}

async function inspectPhase(context, seat, phase, nativeId) {
  const { client, index, manifest, eventFile, options } = context
  let nativeCatalogue
  let statusScope = 'unsupported'
  try {
    const fields = methodProperties(index, 'mcpServerStatus/list', 'McpServerStatusListParams')
    if (!fields?.threadId) throw new Error('thread_scoped_status_unavailable')
    const response = await client.request('mcpServerStatus/list', { threadId: nativeId })
    const tools = statusTools(response)
    if (tools) {
      nativeCatalogue = catalogue(tools)
      statusScope = 'thread'
    }
  } catch {
    /* no inference from process-global MCP state */
  }
  const direct = await invokeProbe(
    client,
    index,
    nativeId,
    manifest.directCall,
    eventFile,
    options.timeoutMs
  )
  const events = readEvents(eventFile)
  const witness = direct.witnesses[0]
  const child =
    witness && events.find((event) => event.kind === 'spawn' && event.pid === witness.pid)
  const wireCatalogue =
    witness &&
    events.filter((event) => event.kind === 'catalogue' && event.pid === witness.pid).at(-1)
  const available = nativeCatalogue || wireCatalogue
  const search = await invokeProbe(
    client,
    index,
    nativeId,
    {
      name: gatewayName(available, 'capability_search'),
      arguments: { query: manifest.directCall.name, limit: 1 }
    },
    eventFile,
    options.timeoutMs
  )
  const invoke = await invokeProbe(
    client,
    index,
    nativeId,
    {
      name: gatewayName(available, 'capability_invoke'),
      arguments: { name: manifest.directCall.name, arguments: manifest.directCall.arguments || {} }
    },
    eventFile,
    options.timeoutMs
  )
  const permission = await invokeProbe(
    client,
    index,
    nativeId,
    {
      name: gatewayName(available, 'capability_invoke'),
      arguments: {
        name: manifest.permissionCall.name,
        arguments: manifest.permissionCall.arguments
      }
    },
    eventFile,
    options.timeoutMs
  )
  const scoped = Boolean(child && witness)
  return {
    role: seat.role,
    lifecycle: phase.lifecycle,
    nativeThreadId: nativeId,
    requestedProfileId: phase.requestedProfileId,
    signedPresetId: seat.signedPresetId,
    postureDeclaration: phase.postureDeclaration,
    P1: scoped
      ? {
          status: 'observed',
          childPid: child.targetPid,
          observerPid: child.pid,
          environmentMatches: child.envSha256 === phase.expectedEnvSha256,
          routeMatches: fingerprint(witness.route) === fingerprint(phase.expectedRoute),
          actualRoute: witness.route,
          expectedRoute: phase.expectedRoute
        }
      : unsupported('no_correlated_child_witness'),
    P4: scoped
      ? {
          status: 'observed',
          expectedArgvTag: phase.argvTag,
          actualArgvTag: child.argvTag,
          matches: phase.argvTag === child.argvTag
        }
      : unsupported('no_child_argv_witness'),
    P5: {
      status: wireCatalogue ? 'observed' : 'inconclusive',
      statusScope,
      nativeCatalogue,
      wireCatalogue,
      toolsMatch:
        nativeCatalogue && wireCatalogue
          ? nativeCatalogue.toolsSha256 === wireCatalogue.toolsSha256
          : null,
      schemasMatch:
        nativeCatalogue && wireCatalogue
          ? nativeCatalogue.schemaSha256 === wireCatalogue.schemaSha256
          : null,
      cacheInvalidation:
        'compare phase fingerprints and child continuity; equal catalogues alone do not prove refresh'
    },
    direct,
    search,
    invoke,
    permission: {
      ...permission,
      signatureVerification: 'external-ledger-required',
      interpretation:
        'An isError or native denial alone is not signed-posture proof. Match these route/PID/request witnesses to the real broker approval ledger.',
      expectedOutcome:
        phase.postureDeclaration?.expectedPermissionOutcome ||
        manifest.permissionCall.expectedOutcome ||
        'operator-must-compare-to-signed-posture'
    },
    P3: scanNativeState(options.codeHome, {
      brokerCredential: manifest.endpoint.brokerToken,
      profile: phase.requestedProfileId,
      routeRun: phase.expectedRoute.appRunId,
      routeChat: phase.expectedRoute.appChatId,
      argsOverride: phase.argvTag,
      envOverride: 'mcp_servers.TaskWraith.env'
    })
  }
}

async function retainedTransition(context, seat, nativeId) {
  const { client, eventFile, manifest, options } = context
  const file = path.join(manifest.outputDir, seat.role + '.hold')
  fs.writeFileSync(file, 'hold', { mode: 0o600, flag: 'wx' })
  const before = readEvents(eventFile).length
  let active
  try {
    active = await executeTurn(
      client,
      {
        threadId: nativeId,
        input: [
          {
            type: 'text',
            text_elements: [],
            text:
              'Call exactly the TaskWraith tool ' +
              manifest.directCall.name +
              ' once with JSON arguments ' +
              JSON.stringify(manifest.directCall.arguments || {}) +
              '. Do not call any other tool or modify anything.'
          }
        ]
      },
      {
        timeoutMs: options.timeoutMs,
        until: () =>
          readEvents(eventFile)
            .slice(before)
            .some((event) => event.kind === 'response-held')
      }
    )
    if (!active.active) return { ...unsupported('no_observed_non_idle_mcp_response'), turn: active }
    const held = readEvents(eventFile)
      .slice(before)
      .find((event) => event.kind === 'response-held')
    // Keep the real MCP reply pending while unsubscribe and resume are requested.
    const unsubscribed = await client.request('thread/unsubscribe', { threadId: nativeId })
    const phase = seat.lifecycles.find((value) => value.lifecycle === 'retained')
    const resumed = await client.request('thread/resume', {
      threadId: nativeId,
      config: phase.config,
      persistExtendedHistory: true
    })
    return {
      status: 'observed',
      activeWitness: held,
      unsubscribeSha256: fingerprint(unsubscribed),
      sameThread: threadIdOf(resumed) === nativeId
    }
  } catch (error) {
    return { ...unsupported('retained_transition_failed'), rpcCode: error.rpcCode || null }
  } finally {
    fs.unlinkSync(file)
    if (active?.turnId) {
      await client
        .request('turn/interrupt', { threadId: nativeId, turnId: active.turnId })
        .catch(() => {})
    }
  }
}

async function runCase(spec, options, manifest, dependencies = {}) {
  const acquire = dependencies.acquireHome || acquireHome
  const connect = dependencies.openAppServer || openAppServer
  const schemas = dependencies.nativeSchemas || nativeSchemas
  const inspect = dependencies.inspectPhase || inspectPhase
  const retained = dependencies.retainedTransition || retainedTransition
  const material = materializeCase(spec, { ...manifest, codeHome: options.codeHome })
  for (const seat of material.seats)
    for (const phase of seat.lifecycles) {
      if (
        phase.postureDeclaration?.presetId !== seat.signedPresetId ||
        !phase.postureDeclaration?.evidenceRef
      ) {
        return {
          caseId: spec.id,
          status: 'inconclusive',
          reason: 'signed_route_posture_declaration_missing_or_mismatched'
        }
      }
    }
  const acquireResult = await acquire(options)
  const evidence = {
    caseId: spec.id,
    status: 'inconclusive',
    phases: [],
    credentialDomain: {
      status: acquireResult.ok ? 'acquired' : 'refused',
      mode: acquireResult.mode,
      reason: acquireResult.reason
    }
  }
  if (!acquireResult.ok) return evidence
  let client
  let confirmedDead = false
  try {
    const launch = {
      ...material.daemon,
      cwd: manifest.workspace,
      env: launchEnvironment(material.daemon.env)
    }
    const schema = await schemas(launch.command, launch.env, manifest.outputDir)
    evidence.nativeSchemaSha256 = schema.sha256
    evidence.nativeVersion = schema.version || null
    evidence.environment = { node: process.version, platform: process.platform, arch: process.arch }
    client = connect(launch, { timeoutMs: options.timeoutMs })
    if (!client.child.pid) throw new Error('native_pid_missing')
    await acquireResult.noteProviderProcess(client.child.pid)
    evidence.initialize = resultSummary(
      await client.request('initialize', {
        clientInfo: { name: 'taskwraith-catalogue-proof', version: '1' },
        capabilities: { experimentalApi: true }
      })
    )
    client.notify({ method: 'initialized', params: {} })
    const context = {
      client,
      index: schema.index,
      manifest,
      eventFile: path.join(manifest.outputDir, 'events.jsonl'),
      options
    }
    // Actual simultaneous start requests; each seat has an independent native id.
    const started = await Promise.all(
      material.seats.map(async (seat) => {
        const result = await client.request('thread/start', {
          cwd: manifest.workspace,
          model: seat.model,
          approvalPolicy: seat.approvalPolicy,
          sandbox: seat.sandbox,
          config: seat.lifecycles[0].config,
          experimentalRawEvents: false,
          persistExtendedHistory: true
        })
        const nativeId = threadIdOf(result)
        if (!nativeId) throw new Error('native_thread_id_missing')
        return { seat, nativeId }
      })
    )
    for (const { seat, nativeId } of started) {
      const fresh = await inspect(context, seat, seat.lifecycles[0], nativeId)
      evidence.phases.push(fresh)
      await client.request('thread/unsubscribe', { threadId: nativeId })
      const resumed = await client.request('thread/resume', {
        threadId: nativeId,
        config: seat.lifecycles[1].config,
        persistExtendedHistory: true
      })
      const idle = await inspect(context, seat, seat.lifecycles[1], nativeId)
      idle.P2 = {
        status: 'observed',
        sameThread: threadIdOf(resumed) === nativeId,
        childRetained:
          fresh.P1?.childPid && idle.P1?.childPid ? fresh.P1.childPid === idle.P1.childPid : null
      }
      evidence.phases.push(idle)
      const transition = await retained(context, seat, nativeId)
      if (transition.status === 'observed') {
        const active = await inspect(context, seat, seat.lifecycles[2], nativeId)
        active.P2 = {
          ...transition,
          childRetained:
            idle.P1?.childPid && active.P1?.childPid
              ? idle.P1.childPid === active.P1.childPid
              : null
        }
        evidence.phases.push(active)
      } else evidence.phases.push({ role: seat.role, lifecycle: 'retained', P2: transition })
    }
    const pids = evidence.phases
      .filter((phase) => phase.lifecycle === 'fresh')
      .map((phase) => phase.P1?.childPid)
    evidence.distinctFreshChildren = pids.every(Boolean) ? new Set(pids).size === pids.length : null
    if (dependencies.afterPhases)
      await dependencies.afterPhases(context, started, material, evidence)
    evidence.status = 'executed' // NOT a P1–P5 pass verdict.
  } catch (error) {
    evidence.failure = { reason: 'case_failed', code: error.code || error.rpcCode || null }
  } finally {
    if (client) {
      try {
        evidence.nativeShutdown = await client.stop()
        confirmedDead = true
      } catch {
        evidence.nativeShutdown = unsupported('native_death_unproven')
      }
    } else confirmedDead = true
    if (confirmedDead) {
      try {
        evidence.credentialRelease = await acquireResult.release()
      } catch {
        evidence.credentialRelease = unsupported('credential_writeback_failed_authority_retained')
      }
    } else evidence.credentialRelease = unsupported('retained_until_native_death_is_proven')
  }
  return evidence
}

async function runBrokerRestart(spec, options, manifest, dependencies) {
  if (!dependencies.restartBroker)
    return unsupported('interactive_broker_restart_callback_required')
  return runCase({ ...spec, id: 'broker-restart' }, options, manifest, {
    ...dependencies,
    async afterPhases(context, started, material, evidence) {
      const updated = await dependencies.restartBroker()
      validateLive(options, updated)
      if (updated.endpoint.instanceEpoch === manifest.endpoint.instanceEpoch) {
        evidence.brokerRestart = unsupported('broker_instance_epoch_did_not_change')
        return
      }
      const changed = materializeCase(spec, {
        ...updated,
        outputDir: manifest.outputDir,
        codeHome: options.codeHome
      })
      evidence.brokerRestart = { status: 'observed', phases: [] }
      for (let i = 0; i < started.length; i++) {
        const { nativeId } = started[i]
        const phase = changed.seats[i].lifecycles[1]
        const result = await context.client.request('thread/resume', {
          threadId: nativeId,
          config: phase.config,
          persistExtendedHistory: true
        })
        const after = await (dependencies.inspectPhase || inspectPhase)(
          { ...context, manifest: { ...updated, outputDir: manifest.outputDir } },
          changed.seats[i],
          phase,
          nativeId
        )
        evidence.brokerRestart.phases.push({
          ...after,
          sameThread: threadIdOf(result) === nativeId
        })
      }
    }
  })
}

async function runDualInstance(spec, options, manifest, dependencies) {
  if (!options.reuseExistingLogin || !options.secondCodeHome)
    return unsupported('dual_instance_requires_shared_source_consent_and_two_homes')
  const second = { ...options, codeHome: options.secondCodeHome }
  if (!manifest.secondInstance) return unsupported('second_real_app_instance_manifest_required')
  const secondManifest = { ...manifest, ...manifest.secondInstance, outputDir: manifest.outputDir }
  validateLive(second, secondManifest)
  if (
    secondManifest.endpoint.instanceEpoch === manifest.endpoint.instanceEpoch ||
    secondManifest.endpoint.socketPath === manifest.endpoint.socketPath
  ) {
    return unsupported('dual_instance_requires_distinct_broker_domains')
  }
  if (fs.realpathSync(second.codeHome) === fs.realpathSync(options.codeHome))
    throw new Error('dual_instance_requires_distinct_private_homes')
  let contention
  const first = await runCase({ ...spec, id: 'dual-instance/A' }, options, manifest, {
    ...dependencies,
    async afterPhases() {
      const lease = await (dependencies.acquireHome || acquireHome)(second)
      contention = {
        status: lease.ok ? 'unexpected-concurrent-acquisition' : 'refused',
        reason: lease.reason || null
      }
      if (lease.ok) contention.release = await lease.release() // B has not spawned.
    }
  })
  let afterRelease = unsupported('first_instance_release_not_proven')
  if (first.credentialRelease && first.credentialRelease.status !== 'inconclusive') {
    afterRelease = await runCase(
      { ...spec, id: 'dual-instance/B-after-release' },
      second,
      secondManifest,
      dependencies
    )
  }
  return {
    status: 'executed',
    first,
    contention: contention || unsupported('first_instance_did_not_reach_contention'),
    afterRelease
  }
}

async function runLive(options, manifest, dependencies = {}) {
  const validated = validateLive(options, manifest)
  const output = fs.mkdtempSync(path.join(validated.output, 'catalogue-proof-'))
  fs.chmodSync(output, 0o700)
  const redactor = createRedactor({
    secrets: collectSecrets(manifest),
    paths: [
      options.codeHome,
      options.secondCodeHome,
      options.loginSource,
      options.outputDir,
      manifest.workspace,
      manifest.bridgeCommand
    ]
  })
  const plan = createProofPlan({
    ...manifest,
    codeHome: options.codeHome,
    secondCodeHome: options.secondCodeHome,
    outputDir: output
  })
  const selected = options.caseId
    ? plan.cases.filter((item) => item.id === options.caseId)
    : plan.cases
  const special = ['broker-restart', 'dual-instance'].includes(options.caseId)
  if (!selected.length && !special) throw new Error('unknown_proof_case')
  writeEvidence(path.join(output, 'plan.json'), plan, redactor)
  const summaries = []
  const execute = async (id, callback) => {
    const directory = fs.mkdtempSync(path.join(output, 'case-'))
    fs.chmodSync(directory, 0o700)
    fs.writeFileSync(path.join(directory, 'events.jsonl'), '', { mode: 0o600, flag: 'wx' })
    const actualManifest = { ...manifest, outputDir: directory }
    const evidence = await callback(actualManifest)
    writeEvidence(path.join(directory, 'evidence.json'), evidence, redactor)
    summaries.push({
      caseId: id,
      evidenceDirectory: path.basename(directory),
      status: evidence.status
    })
  }
  for (const spec of selected)
    await execute(spec.id, (actual) => runCase(spec, options, actual, dependencies))
  const representative = plan.cases.find(
    (spec) => spec.registration === 'route-env' && spec.perThreadArgs && spec.bridgeEnabled
  )
  if (!options.caseId || options.caseId === 'broker-restart') {
    await execute('broker-restart', (actual) =>
      runBrokerRestart(representative, options, actual, dependencies)
    )
  }
  if (!options.caseId || options.caseId === 'dual-instance') {
    await execute('dual-instance', (actual) =>
      runDualInstance(representative, options, actual, dependencies)
    )
  }
  const report = {
    schemaVersion: 1,
    mode: 'live',
    status: 'evidence-collected',
    cases: summaries,
    verdict: 'Manual independent review required; no programme gate is asserted by this tool.'
  }
  writeEvidence(path.join(output, 'summary.json'), report, redactor)
  return { report, output }
}

module.exports = {
  resultSummary,
  statusTools,
  executeTurn,
  invokeProbe,
  inspectPhase,
  retainedTransition,
  runCase,
  runBrokerRestart,
  runDualInstance,
  runLive
}
