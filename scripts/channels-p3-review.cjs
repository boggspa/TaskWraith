#!/usr/bin/env node

const { execFileSync, spawnSync } = require('child_process')
const { createHash, randomUUID } = require('crypto')
const {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('fs')
const { tmpdir } = require('os')
const { basename, dirname, join, relative, resolve } = require('path')

const asar = require('@electron/asar')

const ROOT = resolve(__dirname, '..')
const DEFAULT_EVIDENCE = join(ROOT, '.local-only', 'channels-p3-review-evidence.json')
const REVIEW_ID = 'channels-p3-agent-participation-v1'

const EXPECTED_AGENT_IPC = [
  'channels:agent:enroll',
  'channels:agent:grant',
  'channels:agent:overview',
  'channels:agent:revoke',
  'channels:agent:rotate'
]

const PACKAGED_REQUIRED_MARKERS = {
  main: [
    REVIEW_ID,
    'channel_agent_review_required',
    'TaskWraith Channel agent turn envelope v',
    'Channel history is intentionally absent',
    'channels:agent:grant'
  ],
  preload: ['channels:agent:overview', 'channels:agent:rotate'],
  renderer: [
    'Automatic mention dispatch remains source-disabled',
    'P3 adversarial security review is accepted'
  ]
}

const PACKAGED_FORBIDDEN_MARKERS = {
  all: [
    'channels:agent:enable',
    'channels:agent:set-review',
    'TASKWRAITH_CHANNEL_AGENT_REVIEW',
    'channelAgentReviewOverride'
  ],
  preload: [
    'privateKeyDerB64',
    'ownerSignatureB64',
    'agentSignatureB64',
    'workspaceIdentityHash',
    'permissionPostureHash',
    'participationEnabled'
  ],
  renderer: [
    'privateKeyDerB64',
    'ownerSignatureB64',
    'agentSignatureB64',
    'workspaceIdentityHash',
    'permissionPostureHash',
    'participationEnabled'
  ]
}

const REVIEW_REQUIREMENTS = [
  {
    id: 'strict-signed-parser-fuzz',
    evidence: [
      {
        file: 'src/shared/collaboration/ChannelAgentProtocol.adversarial.test.ts',
        anchors: [
          'rejects deterministic structural fuzz and unknown fields for every raw and signed object',
          'enforces canonical base64, safe integers, byte ceilings, and bounded set sizes'
        ]
      }
    ]
  },
  {
    id: 'cross-language-canonical-vectors',
    evidence: [
      {
        file: 'scripts/channels-p3-vector-oracle.test.ts',
        anchors: [
          'verifies canonical bytes, ordering, base64, and RFC-seeded Ed25519 signatures in Swift',
          'is implementation-independent and carries no private signing material'
        ]
      },
      {
        file: 'src/shared/collaboration/ChannelAgentProtocol.adversarial.test.ts',
        anchors: ['matches Unicode, escape, ordering, array, maximum, and signature vectors']
      }
    ]
  },
  {
    id: 'domain-signature-and-binding-substitution',
    evidence: [
      {
        file: 'src/shared/collaboration/ChannelAgentProtocol.adversarial.test.ts',
        anchors: [
          'rejects every cross-domain signature and cross-object signature substitution',
          'rejects validly signed Channel, member, seat, key-generation, and delegation rebindings',
          'binds grant, trigger, run, and launch-authority bytes through the public message proof'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelAgentTerminalPostSigner.test.ts',
        anchors: ['rejects non-terminal, malformed, or rebound journal evidence']
      }
    ]
  },
  {
    id: 'expired-future-rotated-revoked-replayed-rollback-authority',
    evidence: [
      {
        file: 'src/main/collaboration/ChannelAgentAuthorityState.test.ts',
        anchors: [
          'applies grant, delegation, and key revocations only to their signed targets',
          'requires contiguous key generations and a signed prior-key revocation before rotation',
          'rejects hostile snapshot edits, mutation loss, order rollback, and key-generation replay'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelAgentIdentityStore.test.ts',
        anchors: [
          'refuses clock rollback and repeated key material without changing the durable identity'
        ]
      }
    ]
  },
  {
    id: 'mention-workspace-posture-budget-and-deduplication',
    evidence: [
      {
        file: 'src/main/collaboration/ChannelAgentDispatchAuthority.test.ts',
        anchors: [
          'recovers the posture from its hash and rejects workspace or posture drift',
          'rejects duplicate, exhausted, expired, future, revoked, and wrong-mentioner grants'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelAgentAuthorityStore.test.ts',
        anchors: [
          'durably consumes before returning, survives restart, deduplicates, and exhausts budget'
        ]
      }
    ]
  },
  {
    id: 'durable-crash-boundaries-and-recovery',
    evidence: [
      {
        file: 'src/main/collaboration/ChannelAgentDispatchJournalStore.test.ts',
        anchors: [
          'restores the exact recovery directive at every crash boundary without redispatching'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelAgentDispatchCoordinator.test.ts',
        anchors: ['leaves the exact durable phase for recovery at every post-launch crash point']
      },
      {
        file: 'src/main/collaboration/ChannelAgentDispatchRecovery.test.ts',
        anchors: [
          'never redispatches launching or launched work and retains uncertain runs',
          'retains a signed post across append failure and resumes idempotently',
          'retains terminal journals until replay-safe audit succeeds'
        ]
      }
    ]
  },
  {
    id: 'renderer-ipc-and-private-key-boundary',
    evidence: [
      {
        file: 'src/shared/collaboration/ChannelAgentReviewGate.test.ts',
        anchors: ['has no environment, settings, IPC, or caller-supplied bypass seam']
      },
      {
        file: 'src/main/ipc/channelAgentHandlers.test.ts',
        anchors: [
          'requires main-renderer authority before parsing or resolving controller state',
          'rejects unknown, duplicate, malformed, and out-of-bounds authority before mutation'
        ]
      },
      {
        file: 'src/preload/channelAgentIpcBridge.test.ts',
        anchors: ['exposes only the five closed invokes and preserves exact payload identity']
      }
    ]
  },
  {
    id: 'provider-history-and-session-isolation',
    evidence: [
      {
        file: 'src/main/ChannelProductionMainIntegration.test.ts',
        anchors: [
          'isolates exact Channel runs from parent sessions, raw history, and ordinary failover'
        ]
      },
      {
        file: 'src/main/GeminiApiProvider.test.ts',
        anchors: ['passes the exact run route to every history read and chat write callback']
      },
      {
        file: 'src/main/collaboration/ChannelAgentRunIsolationRegistry.test.ts',
        anchors: [
          'removes persisted prompt and response bodies without mutating numeric usage',
          'keeps isolation fail-closed when mutable route fields are rebound'
        ]
      }
    ]
  },
  {
    id: 'untrusted-framing-for-every-provider',
    evidence: [
      {
        file: 'src/main/collaboration/ChannelAgentRunComposer.test.ts',
        anchors: [
          'keeps the accepted contribution singly untrusted across every provider route',
          'rejects every routing, session, history, posture, and prompt widening'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelAgentDispatchAuthority.test.ts',
        anchors: ['frames only the accepted trigger as untrusted data']
      }
    ]
  },
  {
    id: 'closed-run-audience-and-no-live-steering',
    evidence: [
      {
        file: 'src/main/RunEventBus.test.ts',
        anchors: ['delivers a claimed run only to its closed main-owned sink audience']
      },
      {
        file: 'src/main/collaboration/ChannelAgentRunEventCollector.test.ts',
        anchors: [
          'ignores other runs and non-canonical mirror channels',
          'fails closed on routed provider, chat, or lifecycle workspace drift'
        ]
      }
    ]
  },
  {
    id: 'runtime-posture-never-widens-grant',
    evidence: [
      {
        file: 'src/main/collaboration/ChannelAgentRunLaunchRegistry.test.ts',
        anchors: ['rechecks expiry and payload drift before any durable consumption write']
      },
      {
        file: 'src/main/services/RunCoordinator.test.ts',
        anchors: [
          'runs one per-dispatch authorization after async global gates and directly before adapter.run'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelAgentSeatAuthority.test.ts',
        anchors: ['derives a selected read-only posture without participant override widening']
      }
    ]
  },
  {
    id: 'redaction-and-secret-exclusion',
    evidence: [
      {
        file: 'src/main/collaboration/ChannelAgentDispatchJournalStore.test.ts',
        anchors: ['creates a private no-clobber reservation with only hashed path components']
      },
      {
        file: 'src/main/collaboration/ChannelStore.test.ts',
        anchors: ['redacts secrets and local paths before hashing and durable persistence']
      },
      {
        file: 'src/main/ipc/channelAgentHandlers.test.ts',
        anchors: [
          'maps known domain failures, redacts their messages, and collapses unknown errors'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelAgentRunComposer.test.ts',
        anchors: ['bounds composer failures and rejects an unavailable dependency']
      }
    ]
  },
  {
    id: 'member-ceiling-revocation-and-p2-compatibility',
    evidence: [
      {
        file: 'src/main/collaboration/ChannelStore.test.ts',
        anchors: [
          'persists owner-signed agent membership while keeping relay sessions human-only',
          'enforces the eight-member ceiling, pins identities, and scopes revocation'
        ]
      },
      {
        file: 'src/main/collaboration/ChannelProductionService.agentExecution.test.ts',
        anchors: [
          'attaches the production composition while every external execution port stays inert'
        ]
      },
      {
        file: 'scripts/channels-p2-proof.test.ts',
        anchors: ['fails closed when any shipping main/preload/renderer marker is stale']
      }
    ]
  },
  {
    id: 'packaged-disabled-gate-has-no-toggle-surface',
    evidence: [
      {
        file: 'scripts/channels-p3-review.cjs',
        anchors: [
          'blocked_pending_adversarial_review',
          'PACKAGED_FORBIDDEN_MARKERS',
          'verifySourceBoundary'
        ]
      }
    ]
  }
]

const ATTACK_TEST_FILES = [
  'scripts/channels-p2-proof.test.ts',
  'scripts/channels-p3-vector-oracle.test.ts',
  'src/main/ChannelProductionMainIntegration.test.ts',
  'src/main/GeminiApiProvider.test.ts',
  'src/main/IpcValidation.test.ts',
  'src/main/RendererIpcPolicy.test.ts',
  'src/main/RunEventBus.test.ts',
  'src/main/collaboration/ChannelAgentAuthorityState.test.ts',
  'src/main/collaboration/ChannelAgentAuthorityStore.test.ts',
  'src/main/collaboration/ChannelAgentDispatchAuthority.test.ts',
  'src/main/collaboration/ChannelAgentDispatchCoordinator.test.ts',
  'src/main/collaboration/ChannelAgentDispatchJournalAuthority.test.ts',
  'src/main/collaboration/ChannelAgentDispatchJournalState.test.ts',
  'src/main/collaboration/ChannelAgentDispatchJournalStore.test.ts',
  'src/main/collaboration/ChannelAgentDispatchRecovery.test.ts',
  'src/main/collaboration/ChannelAgentIdentityStore.test.ts',
  'src/main/collaboration/ChannelAgentManagementController.test.ts',
  'src/main/collaboration/ChannelAgentManagementService.test.ts',
  'src/main/collaboration/ChannelAgentMentionAdmission.test.ts',
  'src/main/collaboration/ChannelAgentNativeConfirmation.test.ts',
  'src/main/collaboration/ChannelAgentProductionComposition.enabled.test.ts',
  'src/main/collaboration/ChannelAgentProductionComposition.test.ts',
  'src/main/collaboration/ChannelAgentProductionOrchestrator.test.ts',
  'src/main/collaboration/ChannelAgentProductionRunReconciler.test.ts',
  'src/main/collaboration/ChannelAgentProductionService.enabled.test.ts',
  'src/main/collaboration/ChannelAgentProductionService.test.ts',
  'src/main/collaboration/ChannelAgentRunComposer.test.ts',
  'src/main/collaboration/ChannelAgentRunEventCollector.test.ts',
  'src/main/collaboration/ChannelAgentRunIsolationRegistry.test.ts',
  'src/main/collaboration/ChannelAgentRunLaunchRegistry.test.ts',
  'src/main/collaboration/ChannelAgentSeatAuthority.test.ts',
  'src/main/collaboration/ChannelAgentTerminalPostSigner.test.ts',
  'src/main/collaboration/ChannelHostTransport.test.ts',
  'src/main/collaboration/ChannelMemberProductionBootstrap.test.ts',
  'src/main/collaboration/ChannelMemberProductionService.test.ts',
  'src/main/collaboration/ChannelMemberReplicaStore.test.ts',
  'src/main/collaboration/ChannelProductionBootstrap.test.ts',
  'src/main/collaboration/ChannelProductionService.agentExecution.enabled.test.ts',
  'src/main/collaboration/ChannelProductionService.agentExecution.test.ts',
  'src/main/collaboration/ChannelProductionService.test.ts',
  'src/main/collaboration/ChannelRuntime.test.ts',
  'src/main/collaboration/ChannelStore.test.ts',
  'src/main/ipc/channelAgentHandlers.test.ts',
  'src/main/ipc/channelMemberHandlers.test.ts',
  'src/main/run/RunDispatchFacade.test.ts',
  'src/main/services/RunCoordinator.test.ts',
  'src/preload/channelAgentIpcBridge.test.ts',
  'src/renderer/src/components/ChannelAgentManagement.test.tsx',
  'src/renderer/src/lib/channelAgentManagementModel.test.ts',
  'src/shared/collaboration/ChannelAgentMessageProof.test.ts',
  'src/shared/collaboration/ChannelAgentProtocol.adversarial.test.ts',
  'src/shared/collaboration/ChannelAgentProtocol.test.ts',
  'src/shared/collaboration/ChannelAgentReviewGate.test.ts'
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertReview(condition, message) {
  if (!condition) throw new Error(`P3 review assertion failed: ${message}`)
}

function parseArgs(argv) {
  let evidencePath = DEFAULT_EVIDENCE
  let packageInput = ''
  let candidateInput = ''
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--evidence') evidencePath = resolve(argv[++index])
    else if (argv[index] === '--package') packageInput = resolve(argv[++index])
    else if (argv[index] === '--candidate') candidateInput = argv[++index] || ''
    else throw new Error(`unknown argument ${argv[index]}`)
  }
  if (!packageInput) throw new Error('--package must name the packaged app, app.asar, or root')
  if (!/^[a-f0-9]{7,40}$/i.test(candidateInput)) {
    throw new Error('--candidate must name one exact Git commit')
  }
  return { evidencePath, packageInput, candidateInput }
}

function validateReviewRequirementSources(read = (file) => readFileSync(join(ROOT, file), 'utf8')) {
  const seen = new Set()
  for (const requirement of REVIEW_REQUIREMENTS) {
    assertReview(!seen.has(requirement.id), `duplicate requirement ${requirement.id}`)
    seen.add(requirement.id)
    assertReview(requirement.evidence.length > 0, `${requirement.id} has no evidence`)
    for (const item of requirement.evidence) {
      const source = read(item.file)
      for (const anchor of item.anchors) {
        assertReview(
          source.includes(anchor),
          `${requirement.id} is missing ${item.file}: ${anchor}`
        )
      }
    }
  }
  assertReview(seen.size === 14, `expected 14 review requirements, found ${seen.size}`)
  const uniqueTests = new Set(ATTACK_TEST_FILES)
  assertReview(
    uniqueTests.size === ATTACK_TEST_FILES.length,
    'attack test files contain duplicates'
  )
  for (const file of ATTACK_TEST_FILES) {
    assertReview(existsSync(join(ROOT, file)), `attack test file is missing: ${file}`)
  }
  for (const requirement of REVIEW_REQUIREMENTS) {
    for (const item of requirement.evidence) {
      if (item.file.includes('.test.')) {
        assertReview(
          uniqueTests.has(item.file),
          `${item.file} is not in the executable attack suite`
        )
      }
    }
  }
  return {
    requirementCount: REVIEW_REQUIREMENTS.length,
    testFileCount: ATTACK_TEST_FILES.length,
    manifestSha256: sha256(JSON.stringify(REVIEW_REQUIREMENTS))
  }
}

function trackedSourceFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
    .split('\n')
    .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    .filter((file) => existsSync(join(ROOT, file)))
}

function verifySourceBoundary(overrides = {}) {
  const read = (file) =>
    Object.prototype.hasOwnProperty.call(overrides, file)
      ? overrides[file]
      : readFileSync(join(ROOT, file), 'utf8')
  const gatePath = 'src/shared/collaboration/ChannelAgentReviewGate.ts'
  const gate = read(gatePath)
  for (const marker of [
    REVIEW_ID,
    "status: 'blocked_pending_adversarial_review'",
    'participationEnabled: false',
    'function channelAgentParticipationEnabled(): false',
    'return false',
    'function assertChannelAgentParticipationReviewed(): never',
    'channel_agent_review_required'
  ]) {
    assertReview(gate.includes(marker), `source gate is missing ${marker}`)
  }
  assertReview(
    !/process\.env|import\.meta\.env|localStorage|ipc(Main|Renderer)|settings|payload/i.test(gate),
    'source gate contains a runtime override seam'
  )

  const callers = trackedSourceFiles()
    .filter((file) => !file.includes('.test.'))
    .filter((file) => read(file).includes('channelAgentParticipationEnabled'))
    .sort()
  assertReview(
    JSON.stringify(callers) ===
      JSON.stringify(
        [
          'src/main/collaboration/ChannelAgentMentionAdmission.ts',
          'src/main/collaboration/ChannelAgentProductionService.ts',
          gatePath
        ].sort()
      ),
    `unexpected source-gate callers: ${callers.join(', ')}`
  )

  const boundaryFiles = [
    'src/shared/collaboration/ChannelAgentIpc.ts',
    'src/main/ipc/channelAgentHandlers.ts',
    'src/preload/channelAgentIpcBridge.ts',
    'src/renderer/src/lib/channelAgentManagementModel.ts'
  ]
  const boundary = boundaryFiles.map(read).join('\n')
  const ipcChannels = [...boundary.matchAll(/['"](channels:agent:[a-z-]+)['"]/g)]
    .map((match) => match[1])
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort()
  assertReview(
    JSON.stringify(ipcChannels) === JSON.stringify(EXPECTED_AGENT_IPC),
    `agent IPC catalogue changed: ${ipcChannels.join(', ')}`
  )
  assertReview(
    !/privateKey|ownerSignatureB64|agentSignatureB64|channels:agent:(?:enable|set-review)/.test(
      boundary
    ),
    'renderer/IPC boundary contains a private-key, signature, or review-toggle field'
  )
  return {
    reviewId: REVIEW_ID,
    status: 'blocked_pending_adversarial_review',
    participationEnabled: false,
    gateSourceSha256: sha256(gate),
    callers,
    ipcChannels,
    boundarySha256: sha256(boundary)
  }
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
  assertReview(existsSync(packageInput), `package path does not exist: ${packageInput}`)
  if (statSync(packageInput).isFile()) {
    assertReview(basename(packageInput) === 'app.asar', 'package file must be app.asar')
    return packageInput
  }
  const direct = packageInput.endsWith('.app')
    ? join(packageInput, 'Contents', 'Resources', 'app.asar')
    : join(packageInput, 'resources', 'app.asar')
  if (existsSync(direct)) return direct
  const candidates = findAppAsars(packageInput)
  assertReview(
    candidates.length === 1,
    `expected one app.asar below package path, found ${candidates.length}`
  )
  return candidates[0]
}

function verifyPackagedGroups(groups) {
  const summary = {}
  for (const group of Object.keys(PACKAGED_REQUIRED_MARKERS)) {
    const files = groups[group]
    assertReview(Array.isArray(files) && files.length > 0, `packaged ${group} bundle is missing`)
    const combined = files
      .map((file) =>
        Buffer.isBuffer(file.contents) ? file.contents.toString('utf8') : String(file.contents)
      )
      .join('\n')
    const required = PACKAGED_REQUIRED_MARKERS[group]
    const missing = required.filter((marker) => !combined.includes(marker))
    assertReview(missing.length === 0, `packaged ${group} is stale: ${missing.join(', ')}`)
    const forbiddenMarkers = [
      ...PACKAGED_FORBIDDEN_MARKERS.all,
      ...(PACKAGED_FORBIDDEN_MARKERS[group] || [])
    ]
    const forbidden = forbiddenMarkers.filter((marker) => combined.includes(marker))
    assertReview(
      forbidden.length === 0,
      `packaged ${group} exposes forbidden markers: ${forbidden.join(', ')}`
    )
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
      requiredMarkers: [...required],
      forbiddenMarkerCount: forbiddenMarkers.length,
      forbiddenMarkersSha256: sha256(forbiddenMarkers.join('\n'))
    }
  }
  return summary
}

function scanPackagedGate(packageInput, candidateCommitSeconds) {
  const appAsarPath = resolveAppAsar(packageInput)
  const archive = readFileSync(appAsarPath)
  const archiveStat = statSync(appAsarPath)
  assertReview(
    archiveStat.mtimeMs >= candidateCommitSeconds * 1_000,
    'packaged app predates the reviewed candidate commit'
  )
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
    builtAt: new Date(archiveStat.mtimeMs).toISOString(),
    bytes: archive.length,
    sha256: sha256(archive),
    groups: verifyPackagedGroups(groups)
  }
}

function runSwiftOracle() {
  const oracle = join(ROOT, 'scripts', 'channels-p3-vector-oracle.swift')
  const vectors = join(ROOT, 'scripts', 'fixtures', 'channels-p3-canonical-vectors.json')
  const result = spawnSync('swift', [oracle, vectors], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000
  })
  assertReview(!result.error, `Swift oracle failed to start: ${result.error?.message}`)
  assertReview(result.status === 0, `Swift oracle failed: ${result.stderr.slice(0, 2_000)}`)
  const evidence = JSON.parse(result.stdout)
  assertReview(evidence.language === 'swift', 'cross-language oracle did not identify Swift')
  assertReview(evidence.vectorCount === 4, 'cross-language oracle did not verify four vectors')
  assertReview(
    evidence.vectors.every((vector) => vector.signatureVerified === true),
    'cross-language oracle did not verify every signature'
  )
  return evidence
}

function runAttackSuite(workRoot) {
  const reportPath = join(workRoot, 'vitest-report.json')
  const vitestEntry = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  const startedAt = Date.now()
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', ...ATTACK_TEST_FILES, '--reporter=json', `--outputFile=${reportPath}`],
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 20 * 1024 * 1024 }
  )
  assertReview(!result.error, `attack suite failed to start: ${result.error?.message}`)
  assertReview(
    result.status === 0,
    `attack suite failed: ${(result.stderr || result.stdout).slice(0, 4_000)}`
  )
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assertReview(report.success === true, 'Vitest attack report is not successful')
  assertReview(report.numFailedTests === 0, 'Vitest attack report contains failures')
  assertReview(report.numPendingTests === 0, 'Vitest attack report contains pending tests')
  const files = report.testResults.map((entry) => relative(ROOT, entry.name)).sort()
  assertReview(
    JSON.stringify(files) === JSON.stringify([...ATTACK_TEST_FILES].sort()),
    'Vitest attack report did not execute the exact manifest'
  )
  const assertions = report.testResults
    .flatMap((entry) => entry.assertionResults.map((assertion) => assertion.fullName))
    .sort()
  return {
    fileCount: files.length,
    testCount: report.numTotalTests,
    passedTests: report.numPassedTests,
    durationMs: Date.now() - startedAt,
    filesSha256: sha256(files.join('\n')),
    assertionsSha256: sha256(assertions.join('\n'))
  }
}

function runP2CompatibilityMission(packageInput, candidateCommit, workRoot) {
  const evidencePath = join(workRoot, 'channels-p2-compatibility.json')
  const proof = join(ROOT, 'scripts', 'channels-p2-proof.cjs')
  const result = spawnSync(
    process.execPath,
    [proof, '--package', packageInput, '--runs', '1', '--evidence', evidencePath],
    { cwd: ROOT, encoding: 'utf8', timeout: 300_000, maxBuffer: 20 * 1024 * 1024 }
  )
  assertReview(!result.error, `P2 compatibility mission failed to start: ${result.error?.message}`)
  assertReview(
    result.status === 0,
    `P2 compatibility mission failed: ${(result.stderr || result.stdout).slice(0, 4_000)}`
  )
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assertReview(evidence.status === 'passed', 'P2 compatibility evidence did not pass')
  assertReview(evidence.sourceCommit === candidateCommit, 'P2 mission reviewed another commit')
  assertReview(evidence.runs.length === 1, 'P2 compatibility mission did not run exactly once')
  const run = evidence.runs[0]
  const failedAssertions = Object.entries(run.assertions)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name)
  assertReview(
    failedAssertions.length === 0,
    `P2 compatibility assertions failed: ${failedAssertions.join(', ')}`
  )
  return {
    status: evidence.status,
    packageSha256: evidence.packageSurface.sha256,
    workerBundleSha256: evidence.workerBundle.sha256,
    durationMs: run.durationMs,
    assertionCount: Object.keys(run.assertions).length,
    assertionsSha256: sha256(JSON.stringify(run.assertions)),
    finalHighWaterSequence: run.finalHost.highWaterSequence,
    finalDigest: run.finalHost.digest,
    noAgentOrProviderRouteObserved: run.assertions.noAgentOrProviderRouteObserved
  }
}

function exactCandidate(input) {
  const candidateCommit = execFileSync('git', ['rev-parse', `${input}^{commit}`], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  assertReview(candidateCommit === headCommit, 'review candidate must be exact current HEAD')
  for (const args of [
    ['diff', '--quiet'],
    ['diff', '--cached', '--quiet']
  ]) {
    const clean = spawnSync('git', args, { cwd: ROOT })
    assertReview(clean.status === 0, 'review candidate has tracked working-tree or index changes')
  }
  const tree = execFileSync('git', ['rev-parse', `${candidateCommit}^{tree}`], {
    cwd: ROOT,
    encoding: 'utf8'
  }).trim()
  const committedAtSeconds = Number(
    execFileSync('git', ['show', '-s', '--format=%ct', candidateCommit], {
      cwd: ROOT,
      encoding: 'utf8'
    }).trim()
  )
  assertReview(Number.isSafeInteger(committedAtSeconds), 'candidate commit time is invalid')
  return { candidateCommit, tree, committedAtSeconds }
}

function writePrivateEvidence(path, evidence) {
  const serialized = JSON.stringify(evidence, null, 2)
  for (const forbidden of [
    '/Users/',
    '/private/var/',
    'privateKeyDerB64',
    OWNER_SEED_SENTINEL,
    AGENT_SEED_SENTINEL,
    'DO-NOT-LEAK',
    'Previous Channel history bytes'
  ]) {
    assertReview(
      !serialized.includes(forbidden),
      `evidence contains forbidden material ${forbidden}`
    )
  }
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  assertReview((statSync(path).mode & 0o777) === 0o600, 'review evidence is not mode 0600')
}

const OWNER_SEED_SENTINEL = '9d61b19deffd5a60'
const AGENT_SEED_SENTINEL = '4ccd089b28ff96da'

async function main() {
  assertReview(process.platform === 'darwin', 'P3 packaged review requires macOS')
  const options = parseArgs(process.argv.slice(2))
  const candidate = exactCandidate(options.candidateInput)
  const requirementManifest = validateReviewRequirementSources()
  const sourceBoundary = verifySourceBoundary()
  const packageSurface = scanPackagedGate(options.packageInput, candidate.committedAtSeconds)
  const workRoot = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p3-review-'))
  try {
    const crossLanguageVectors = runSwiftOracle()
    const attackSuite = runAttackSuite(workRoot)
    const p2Compatibility = runP2CompatibilityMission(
      options.packageInput,
      candidate.candidateCommit,
      workRoot
    )
    assertReview(
      p2Compatibility.packageSha256 === packageSurface.sha256,
      'P2 compatibility mission scanned a different package artifact'
    )
    const evidence = {
      schemaVersion: 1,
      review: 'Channels P3 signed-agent adversarial evidence package',
      status: 'evidence_passed',
      decision: 'not_recorded_by_harness',
      reviewId: REVIEW_ID,
      candidateCommit: candidate.candidateCommit,
      candidateTree: candidate.tree,
      generatedAt: new Date().toISOString(),
      platform: { platform: process.platform, arch: process.arch, node: process.version },
      requirementManifest,
      requirements: REVIEW_REQUIREMENTS.map((requirement) => ({
        id: requirement.id,
        files: requirement.evidence.map((item) => item.file)
      })),
      sourceBoundary,
      crossLanguageVectors,
      attackSuite,
      packageSurface,
      p2Compatibility
    }
    writePrivateEvidence(options.evidencePath, evidence)
    process.stdout.write(
      `${JSON.stringify(
        {
          status: evidence.status,
          decision: evidence.decision,
          candidateCommit: evidence.candidateCommit,
          packageSha256: evidence.packageSurface.sha256,
          attackFiles: evidence.attackSuite.fileCount,
          attackTests: evidence.attackSuite.testCount,
          requirements: evidence.requirementManifest.requirementCount,
          p2Assertions: evidence.p2Compatibility.assertionCount,
          evidencePath: options.evidencePath
        },
        null,
        2
      )}\n`
    )
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

module.exports = {
  ATTACK_TEST_FILES,
  EXPECTED_AGENT_IPC,
  PACKAGED_FORBIDDEN_MARKERS,
  PACKAGED_REQUIRED_MARKERS,
  REVIEW_REQUIREMENTS,
  parseArgs,
  validateReviewRequirementSources,
  verifyPackagedGroups,
  verifySourceBoundary
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error.stack || error.message || error)}\n`)
    process.exitCode = 1
  })
}
