import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const runner =
  require('./studio-source-range-lifecycle-runner.cjs') as typeof import('./studio-source-range-lifecycle-runner.cjs')

const hash = 'a'.repeat(64)
const assetId = 'asset-exact'
const proposalId = 'proposal-exact'

function entry(revision: number, op: Record<string, unknown>) {
  return {
    format: 'taskwraith-studio-journal',
    v: 1,
    revision,
    committedAtIso: `2026-08-20T00:00:0${revision}Z`,
    op
  }
}

function materialPixel(beforeRestart = false) {
  return {
    region: 'review-host',
    beforeRestart,
    captureSha256: hash,
    referenceSha256: 'b'.repeat(64),
    comparison: {
      clean: true,
      metrics: {
        materialPixelCount: 100,
        meanAbsoluteChannelResidual: 1,
        p95ChannelResidual: 2,
        p99ChannelResidual: 3,
        maximumChannelResidual: 4,
        fractionAbove40: 0,
        fractionAbove80: 0
      },
      thresholds: {
        maximumMeanAbsoluteChannelResidual: 10,
        maximumP99ChannelResidual: 50,
        maximumFractionAbove40: 0.03,
        maximumFractionAbove80: 0.01
      }
    },
    referenceExecution: {
      command: ['/usr/local/bin/ffmpeg', '-i', '/exact/input.mp4'],
      exitCode: 0,
      stdoutSha256: hash,
      stderrSha256: hash
    }
  }
}

function ghostPixel() {
  return {
    region: 'review-host',
    captureSha256: hash,
    referenceSha256: 'b'.repeat(64),
    comparison: {
      ok: true,
      region: 'review-host',
      changedPixelCount: 100,
      changedPixelFraction: 0.1
    }
  }
}

function processTarget() {
  return {
    pid: 50,
    ppid: 1,
    pgid: 50,
    executable: '/exact/TaskWraith',
    command: '/exact/TaskWraith --inspect=9940',
    processTableReceipt: {
      command: ['/bin/ps', '-p', '50'],
      stdoutSha256: hash,
      stderrSha256: hash
    }
  }
}

function packageCustody() {
  const file = (name: string) => ({ path: `app/${name}`, sha256: hash })
  return {
    appRoot: 'app/TaskWraith Debug.app',
    bundleIdentityDigest: hash,
    files: {
      executable: file('TaskWraith Debug'),
      infoPlist: file('Info.plist'),
      appAsar: file('app.asar'),
      companion: file('TaskWraithStudioCompanion'),
      bridgeDaemon: file('TaskWraithBridgeDaemon'),
      bridgeInfoPlist: file('Bridge-Info.plist')
    },
    executablePath: 'app/TaskWraith Debug',
    executableSha256: hash,
    companionPath: 'app/TaskWraithStudioCompanion',
    companionSha256: hash,
    bridgeDaemonPath: 'app/TaskWraithBridgeDaemon',
    bridgeDaemonSha256: hash,
    speechUsageDescription: 'On-device transcript',
    bridgeSpeechUsageDescription: 'On-device transcript',
    bridgeBundleIdentifier: 'com.chrisizatt.taskwraith',
    codeSignatureVerified: true
  }
}

function sourceCustody() {
  const support = { 'scripts/exact.cjs': hash }
  return {
    head: 'a'.repeat(40),
    requiredProductAncestor: 'b'.repeat(40),
    productAncestorPresent: true,
    protectedPathScope: { runnerPath: 'scripts/studio-acceptance-harness.cjs' },
    wholeTrackedTreeClean: true,
    wholeWorkspaceClean: true,
    studioPathsClean: true,
    studioTrackedDirt: [],
    studioUntrackedDirt: [],
    foreignTrackedDirt: [],
    foreignUntrackedDirt: [],
    sourceDigest: hash,
    sourceCount: 1,
    buildEnvironmentCount: 0,
    buildEnvironmentDigest: hash,
    buildEnvironmentVariables: [],
    expectedSupportHashes: support,
    supportHashes: structuredClone(support),
    supportMatches: true,
    runnerSha256: hash,
    artifactDigest: hash,
    artifactCount: 1,
    outDigest: hash,
    outCount: 1,
    companionPath: 'swift/TaskWraithStudioCompanion',
    companionSha256: hash,
    bridgeDaemonPath: 'swift/TaskWraithBridgeDaemon',
    bridgeDaemonSha256: hash,
    fixtureSha256: hash,
    fixtureByteLength: 1
  }
}

function acceptedInsert() {
  return {
    type: 'insert_range',
    itemId: 'item-exact',
    assetId,
    sourceIn: { n: 30, d: 30 },
    sourceOut: { n: 60, d: 30 },
    at: { n: 90, d: 30 }
  }
}

function goodEvidence() {
  const before = [
    entry(6, { type: 'open_media' }),
    entry(7, {
      type: 'propose_edit',
      proposal: { proposalId, op: acceptedInsert() }
    })
  ]
  const after = [...before, entry(8, { type: 'resolve_proposal', proposalId, decision: 'accept' })]
  const self = {
    runner: { path: 'scripts/studio-source-range-lifecycle-runner.cjs', sha256: hash },
    test: { path: 'scripts/studio-source-range-lifecycle-runner.test.ts', sha256: hash }
  }
  const evidence = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-source-range-lifecycle',
    ok: true,
    instanceId: 'o7-exact',
    asset: { assetId, path: '/exact/asset.mp4', mediaKind: 'video' },
    selfCustodyBefore: self,
    selfCustodyAfter: structuredClone(self),
    packageBefore: packageCustody(),
    packageAfter: packageCustody(),
    sourceBefore: sourceCustody(),
    sourceAfter: sourceCustody(),
    proposal: {
      proposalId,
      proposalRevision: 7,
      op: acceptedInsert(),
      visibleGhost: true,
      ghostPixels: ghostPixel()
    },
    acceptance: {
      resolutionRevision: 8,
      journalBefore: before,
      journalAfter: after,
      staleControl: {
        proposalId,
        hostPaused: true,
        hostResumed: true,
        acceptRequests: 2,
        hostSignalTarget: {
          beforeStop: processTarget(),
          beforeContinue: processTarget()
        },
        responses: [
          { kind: 'accepted', proposalId, baseRevision: 7, revision: 8, requestId: 101 },
          {
            kind: 'stale_base',
            proposalId,
            baseRevision: 7,
            currentRevision: 8,
            requestId: 102
          }
        ]
      },
      immediateCurrent: materialPixel(true)
    },
    restart: {
      oldProcess: {
        pid: 100,
        ppid: 50,
        pgid: 50,
        executable: '/exact/Studio',
        command: '/exact/Studio --viewer'
      },
      beforeKillProcess: {
        pid: 100,
        ppid: 50,
        pgid: 50,
        executable: '/exact/Studio',
        command: '/exact/Studio --viewer',
        processTableReceipt: {
          command: ['/bin/ps', '-p', '100'],
          stdoutSha256: hash,
          stderrSha256: hash
        }
      },
      replacementProcess: {
        pid: 101,
        ppid: 50,
        pgid: 50,
        executable: '/exact/Studio',
        command: '/exact/Studio --viewer'
      },
      oldProcessDisappeared: true,
      hydration: {
        ordered: true,
        proposalsEmpty: true,
        windowCount: 0,
        journalBeforeSha256: hash,
        journalAfterSha256: hash,
        journalBeforeRevision: 8,
        journalAfterRevision: 8,
        assets: [{ assetId, path: '/exact/asset.mp4', mediaKind: 'video' }],
        tracks: [
          {
            trackId: 'V1',
            kind: 'video',
            items: [
              {
                itemId: 'item-exact',
                assetId,
                sourceIn: { n: 30, d: 30 },
                sourceOut: { n: 60, d: 30 },
                position: { n: 90, d: 30 },
                duration: { n: 30, d: 30 }
              }
            ]
          }
        ]
      },
      oldWindowId: 700,
      explicitReopen: {
        sameAsset: true,
        newVisibleWindow: true,
        journalEntry: entry(9, {
          type: 'open_media',
          asset: { assetId, path: '/exact/asset.mp4', mediaKind: 'video' }
        }),
        window: {
          pid: 101,
          windowId: 701,
          title: 'TaskWraith Studio',
          executable: '/exact/Studio'
        }
      },
      replayedCurrent: materialPixel(false)
    },
    supervisorBundle: {
      before: { bundlePath: '/exact/out/main/index.js', bundleSha256: hash },
      after: { bundlePath: '/exact/out/main/index.js', bundleSha256: hash },
      hits: []
    },
    harness: {
      path: '/exact/studio-acceptance-evidence.json',
      byteLength: 100,
      sha256: hash,
      verifiedFromDisk: true,
      watchdogReceiptPath: '/exact/watchdog-receipt.json',
      value: {
        asset: {},
        companion: {},
        companionCustody: {},
        custodyAfter: {},
        custodyBefore: {},
        custodyFixture: {},
        custodySource: {},
        durable: {},
        electron: {},
        instanceId: 'o7-exact',
        journey: {},
        kind: 'taskwraith-studio-in-product-acceptance',
        ok: true,
        openResult: {},
        packagedExecutionAfter: {},
        packagedExecutionBefore: {},
        priorOrphanScan: {},
        providerGuards: {},
        recordedAt: '2026-08-20T00:00:00Z',
        safety: {},
        schemaVersion: 1,
        speechFixture: {},
        speechFixtureCustody: {},
        watchdogReceiptPath: '/exact/watchdog-receipt.json',
        watchdogTerminal: {},
        window: {}
      }
    },
    watchdog: {
      path: '/exact/watchdog-receipt.json',
      byteLength: 100,
      sha256: hash,
      verifiedFromDisk: true,
      terminal: {
        type: 'terminal',
        status: 'reaped',
        childPid: 50,
        childPgid: 50,
        groupExitVerified: true,
        detachedGroupExitVerified: true,
        reason: 'owner_requested',
        receiptPath: '/exact/watchdog-receipt.json'
      },
      value: {
        schemaVersion: 2,
        kind: 'taskwraith-studio-acceptance-watchdog',
        instanceId: 'o7-exact',
        status: 'reaped',
        reason: 'owner_requested',
        childPid: 50,
        childPgid: 50,
        groupExitVerified: true,
        detachedGroupExitVerified: true,
        lostOwnershipGroups: [],
        mixedOwnershipGroups: [],
        protectedInstalledGroups: []
      }
    }
  }
  evidence.harness.value.journey = {
    proposal: structuredClone(evidence.proposal),
    acceptance: structuredClone(evidence.acceptance),
    restart: structuredClone(evidence.restart),
    inspector: structuredClone(evidence.supervisorBundle)
  }
  return evidence
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

describe('Outcome 7 evidence validator', () => {
  it('accepts only the complete immediate-plus-restart proof', () => {
    expect(runner.validateOutcome7Evidence(goodEvidence())).toMatchObject({ ok: true })
  })

  it('rejects the wrong operation, rationals, or asset', () => {
    const wrongOp = goodEvidence()
    wrongOp.proposal.op.type = 'move'
    expect(() => runner.validateOutcome7Evidence(wrongOp)).toThrow(/insert_range/)

    const wrongRational = goodEvidence()
    wrongRational.proposal.op.sourceOut.d = 24
    expect(() => runner.validateOutcome7Evidence(wrongRational)).toThrow(/timebase/)

    const wrongAsset = goodEvidence()
    wrongAsset.proposal.op.assetId = 'foreign'
    expect(() => runner.validateOutcome7Evidence(wrongAsset)).toThrow(/asset/)
  })

  it('rejects an absent or unadjudicated visible ghost', () => {
    const absent = goodEvidence()
    absent.proposal.visibleGhost = false
    expect(() => runner.validateOutcome7Evidence(absent)).toThrow(/ghost/)

    const red = goodEvidence()
    red.proposal.ghostPixels.comparison.ok = false
    expect(() => runner.validateOutcome7Evidence(red)).toThrow(/pixels/)
  })

  it('rejects acceptance that is not immediately visible before restart', () => {
    const missing = goodEvidence()
    missing.acceptance.immediateCurrent.comparison.clean = false
    expect(() => runner.validateOutcome7Evidence(missing)).toThrow(/immediate Current pixels/)

    const restartOnly = goodEvidence()
    restartOnly.acceptance.immediateCurrent.beforeRestart = false
    expect(() => runner.validateOutcome7Evidence(restartOnly)).toThrow(/only after restart/)
  })

  it('rejects permissive pixel status, metric schema drift, or a missing ffmpeg receipt', () => {
    const permissive = goodEvidence()
    permissive.acceptance.immediateCurrent.comparison.clean = false
    ;(permissive.acceptance.immediateCurrent.comparison as Record<string, unknown>).ok = true
    expect(() => runner.validateOutcome7Evidence(permissive)).toThrow(/pixels/)

    const metricDrift = goodEvidence()
    ;(metricDrift.acceptance.immediateCurrent.comparison.metrics as Record<string, unknown>).extra =
      1
    expect(() => runner.validateOutcome7Evidence(metricDrift)).toThrow(/metrics keys/)

    const noFfmpeg = goodEvidence()
    noFfmpeg.restart.replayedCurrent.referenceExecution.command[0] = '/usr/bin/true'
    expect(() => runner.validateOutcome7Evidence(noFfmpeg)).toThrow(/ffmpeg/)
  })

  it('rejects fake stale evidence and the wrong current revision', () => {
    const fake = goodEvidence()
    fake.acceptance.staleControl.responses[1].kind = 'accepted'
    expect(() => runner.validateOutcome7Evidence(fake)).toThrow(/one accept and one refusal/)

    const wrongRevision = goodEvidence()
    wrongRevision.acceptance.staleControl.responses[1].currentRevision = 9
    expect(() => runner.validateOutcome7Evidence(wrongRevision)).toThrow(/currentRevision/)
  })

  it('rejects an unsafe host-pause bracket', () => {
    const evidence = goodEvidence()
    evidence.acceptance.staleControl.hostResumed = false
    expect(() => runner.validateOutcome7Evidence(evidence)).toThrow(/safely bracketed/)
  })

  it('rejects process-table target drift before SIGCONT or an unsealed process receipt', () => {
    const drift = goodEvidence()
    drift.acceptance.staleControl.hostSignalTarget.beforeContinue.command += ' --foreign'
    expect(() => runner.validateOutcome7Evidence(drift)).toThrow(/target custody/)

    const unsealed = goodEvidence()
    unsealed.acceptance.staleControl.hostSignalTarget.beforeStop.processTableReceipt.stdoutSha256 =
      'bad'
    expect(() => runner.validateOutcome7Evidence(unsealed)).toThrow(/process-table/)
  })

  it('rejects any extra acceptance journal delta', () => {
    const evidence = goodEvidence()
    evidence.acceptance.journalAfter.push(entry(9, { type: 'open_media' }))
    expect(() => runner.validateOutcome7Evidence(evidence)).toThrow(/exactly one/)
  })

  it('rejects wrong replacement PID, parent, group, or executable identity', () => {
    for (const mutate of [
      (value: ReturnType<typeof goodEvidence>) => {
        value.restart.replacementProcess.pid = 100
      },
      (value: ReturnType<typeof goodEvidence>) => {
        value.restart.replacementProcess.ppid = 51
      },
      (value: ReturnType<typeof goodEvidence>) => {
        value.restart.replacementProcess.pgid = 51
      },
      (value: ReturnType<typeof goodEvidence>) => {
        value.restart.replacementProcess.executable = '/wrong/Studio'
      }
    ]) {
      const evidence = goodEvidence()
      mutate(evidence)
      expect(() => runner.validateOutcome7Evidence(evidence)).toThrow(/replacement/)
    }
  })

  it('rejects a stale or unsealed old-Companion SIGKILL target', () => {
    const reused = goodEvidence()
    reused.restart.beforeKillProcess.pid = 999
    expect(() => runner.validateOutcome7Evidence(reused)).toThrow(/SIGKILL target/)

    const unsealed = goodEvidence()
    unsealed.restart.beforeKillProcess.processTableReceipt.stdoutSha256 = 'bad'
    expect(() => runner.validateOutcome7Evidence(unsealed)).toThrow(/SIGKILL target/)
  })

  it('rejects a hydration window or journal mutation', () => {
    const windowed = goodEvidence()
    windowed.restart.hydration.windowCount = 1
    expect(() => runner.validateOutcome7Evidence(windowed)).toThrow(/window/)

    const mutated = goodEvidence()
    mutated.restart.hydration.journalAfterSha256 = 'c'.repeat(64)
    expect(() => runner.validateOutcome7Evidence(mutated)).toThrow(/durability/)
  })

  it('rejects missing or wrong hydrated track items', () => {
    const absent = goodEvidence()
    absent.restart.hydration.tracks[0].items = []
    expect(() => runner.validateOutcome7Evidence(absent)).toThrow(/target track V1/)

    const wrong = goodEvidence()
    wrong.restart.hydration.tracks[0].items[0].sourceIn.n = 31
    expect(() => runner.validateOutcome7Evidence(wrong)).toThrow(/range, duration/)
  })

  it('rejects incomplete hydration schema or changed asset path/media kind', () => {
    const extraItemField = goodEvidence()
    ;(extraItemField.restart.hydration.tracks[0].items[0] as Record<string, unknown>).extra = true
    expect(() => runner.validateOutcome7Evidence(extraItemField)).toThrow(/item keys/)

    const pathChanged = goodEvidence()
    pathChanged.restart.hydration.assets[0].path = '/wrong/asset.mp4'
    expect(() => runner.validateOutcome7Evidence(pathChanged)).toThrow(/asset path/)

    const kindChanged = goodEvidence()
    kindChanged.restart.hydration.assets[0].mediaKind = 'audio'
    expect(() => runner.validateOutcome7Evidence(kindChanged)).toThrow(/asset schema/)

    const unknownReference = goodEvidence()
    unknownReference.restart.hydration.tracks[0].items[0].assetId = 'not-hydrated'
    expect(() => runner.validateOutcome7Evidence(unknownReference)).toThrow(/item identity/)
  })

  it('optionally binds the external asset digest to the base64url id and fixture custody', () => {
    const evidence = goodEvidence()
    const digest = 'ab'.repeat(32)
    const pinnedId = Buffer.from(digest, 'hex').toString('base64url')
    evidence.asset.assetId = pinnedId
    ;(evidence.asset as Record<string, unknown>).sha256 = digest
    evidence.sourceBefore.fixtureSha256 = digest
    evidence.sourceAfter.fixtureSha256 = digest
    evidence.proposal.op.assetId = pinnedId
    evidence.restart.hydration.assets[0].assetId = pinnedId
    evidence.restart.hydration.tracks[0].items[0].assetId = pinnedId
    evidence.restart.explicitReopen.journalEntry.op.asset.assetId = pinnedId
    evidence.harness.value.journey = {
      proposal: structuredClone(evidence.proposal),
      acceptance: structuredClone(evidence.acceptance),
      restart: structuredClone(evidence.restart),
      inspector: structuredClone(evidence.supervisorBundle)
    }
    expect(runner.validateOutcome7Evidence(evidence)).toMatchObject({ ok: true })
    ;(evidence.asset as Record<string, unknown>).sha256 = 'cd'.repeat(32)
    expect(() => runner.validateOutcome7Evidence(evidence)).toThrow(/digest/)
  })

  it('rejects non-positive, inverted, or duration-mismatched hydrated items', () => {
    const zero = goodEvidence()
    zero.restart.hydration.tracks[0].items[0].duration.n = 0
    expect(() => runner.validateOutcome7Evidence(zero)).toThrow(/range, duration/)

    const inverted = goodEvidence()
    inverted.restart.hydration.tracks[0].items[0].sourceOut.n = 29
    expect(() => runner.validateOutcome7Evidence(inverted)).toThrow(/range, duration/)

    const mismatch = goodEvidence()
    mismatch.restart.hydration.tracks[0].items[0].duration.n = 31
    expect(() => runner.validateOutcome7Evidence(mismatch)).toThrow(/range, duration/)
  })

  it('rejects duplicate hydrated asset ids or canonical paths', () => {
    const duplicateId = goodEvidence()
    duplicateId.restart.hydration.assets.push({
      assetId,
      path: '/exact/other.mp4',
      mediaKind: 'video'
    })
    expect(() => runner.validateOutcome7Evidence(duplicateId)).toThrow(/asset id/)

    const duplicatePath = goodEvidence()
    duplicatePath.restart.hydration.assets.push({
      assetId: 'other-asset',
      path: '/exact/asset.mp4',
      mediaKind: 'video'
    })
    expect(() => runner.validateOutcome7Evidence(duplicatePath)).toThrow(/asset path/)

    const nonCanonical = goodEvidence()
    nonCanonical.restart.hydration.assets[0].path = '/exact/folder/../asset.mp4'
    expect(() => runner.validateOutcome7Evidence(nonCanonical)).toThrow(/asset schema/)
  })

  it('rejects duplicate tracks, global item ids, or the accepted item on the wrong track', () => {
    const duplicateTrack = goodEvidence()
    duplicateTrack.restart.hydration.tracks.push({
      trackId: 'V1',
      kind: 'video',
      items: []
    })
    expect(() => runner.validateOutcome7Evidence(duplicateTrack)).toThrow(/track id/)

    const duplicateItem = goodEvidence()
    duplicateItem.restart.hydration.tracks.push({
      trackId: 'V2',
      kind: 'video',
      items: [structuredClone(duplicateItem.restart.hydration.tracks[0].items[0])]
    })
    expect(() => runner.validateOutcome7Evidence(duplicateItem)).toThrow(/global item id/)

    const wrongTrack = goodEvidence()
    wrongTrack.restart.hydration.tracks[0].trackId = 'V2'
    expect(() => runner.validateOutcome7Evidence(wrongTrack)).toThrow(/target track V1/)
  })

  it('rejects overlapping hydrated items within a track', () => {
    const evidence = goodEvidence()
    evidence.restart.hydration.tracks[0].items.push({
      itemId: 'overlap',
      assetId,
      sourceIn: { n: 0, d: 30 },
      sourceOut: { n: 30, d: 30 },
      position: { n: 100, d: 30 },
      duration: { n: 30, d: 30 }
    })
    expect(() => runner.validateOutcome7Evidence(evidence)).toThrow(/overlapping/)
  })

  it('rejects wrong replay pixels, region, or missing same-asset reopen', () => {
    const red = goodEvidence()
    red.restart.replayedCurrent.comparison.clean = false
    expect(() => runner.validateOutcome7Evidence(red)).toThrow(/replayed Current pixels/)

    const region = goodEvidence()
    region.acceptance.immediateCurrent.region = 'whole-window'
    expect(() => runner.validateOutcome7Evidence(region)).toThrow(/pixel region/)

    const wrongAsset = goodEvidence()
    wrongAsset.restart.explicitReopen.sameAsset = false
    expect(() => runner.validateOutcome7Evidence(wrongAsset)).toThrow(/same asset/)
  })

  it('rejects stale reopen revisions, wrong target fields, or old window identity', () => {
    const staleRevision = goodEvidence()
    staleRevision.restart.explicitReopen.journalEntry.revision = 8
    expect(() => runner.validateOutcome7Evidence(staleRevision)).toThrow(/fresh journal revision/)

    const wrongPath = goodEvidence()
    wrongPath.restart.explicitReopen.journalEntry.op.asset.path = '/wrong/asset.mp4'
    expect(() => runner.validateOutcome7Evidence(wrongPath)).toThrow(/target identity/)

    const reusedWindow = goodEvidence()
    reusedWindow.restart.explicitReopen.window.windowId = reusedWindow.restart.oldWindowId
    expect(() => runner.validateOutcome7Evidence(reusedWindow)).toThrow(/window identity/)
  })

  it('rejects package, source, runner, or test mutation', () => {
    const packageMutation = goodEvidence()
    packageMutation.packageAfter.sha256 = 'c'.repeat(64)
    expect(() => runner.validateOutcome7Evidence(packageMutation)).toThrow(/package/)

    const sourceMutation = goodEvidence()
    sourceMutation.sourceAfter.sourceDigest = 'c'.repeat(64)
    expect(() => runner.validateOutcome7Evidence(sourceMutation)).toThrow(/source custody/)

    const runnerMutation = goodEvidence()
    runnerMutation.selfCustodyAfter.runner.sha256 = 'c'.repeat(64)
    expect(() => runner.validateOutcome7Evidence(runnerMutation)).toThrow(/runner or test/)
  })

  it('rejects incomplete package/source schemas even when before and after match', () => {
    const packageSchema = goodEvidence()
    delete (packageSchema.packageBefore.files as Record<string, unknown>).appAsar
    packageSchema.packageAfter = structuredClone(packageSchema.packageBefore)
    expect(() => runner.validateOutcome7Evidence(packageSchema)).toThrow(/files keys/)

    const sourceSchema = goodEvidence()
    sourceSchema.sourceBefore.supportMatches = false
    sourceSchema.sourceAfter = structuredClone(sourceSchema.sourceBefore)
    expect(() => runner.validateOutcome7Evidence(sourceSchema)).toThrow(/support boundary/)
  })

  it('rejects compiled supervisor bundle replacement during the run', () => {
    const evidence = goodEvidence()
    evidence.supervisorBundle.after.bundleSha256 = 'c'.repeat(64)
    expect(() => runner.validateOutcome7Evidence(evidence)).toThrow(/supervisor bundle custody/)
  })

  it('rejects an un-reaped watchdog or surviving process', () => {
    const live = goodEvidence()
    live.watchdog.value.status = 'running'
    expect(() => runner.validateOutcome7Evidence(live)).toThrow(/terminal schema/)

    const survivor = goodEvidence()
    survivor.watchdog.value.lostOwnershipGroups = [{ pgid: 90 }]
    expect(() => runner.validateOutcome7Evidence(survivor)).toThrow(/unresolved/)
  })

  it('rejects unsealed raw harness/watchdog receipts and terminal disagreement', () => {
    const harnessUnsealed = goodEvidence()
    harnessUnsealed.harness.verifiedFromDisk = false
    expect(() => runner.validateOutcome7Evidence(harnessUnsealed)).toThrow(/harness evidence file/)

    const watchdogUnsealed = goodEvidence()
    watchdogUnsealed.watchdog.sha256 = 'bad'
    expect(() => runner.validateOutcome7Evidence(watchdogUnsealed)).toThrow(/watchdog file/)

    const disagreement = goodEvidence()
    disagreement.watchdog.terminal.childPid = 51
    expect(() => runner.validateOutcome7Evidence(disagreement)).toThrow(/does not join/)
  })
})

describe('Outcome 7 plan and launch boundary', () => {
  it('is plan-only by default and never calls an injected live adapter', async () => {
    const runStudioAcceptance = vi.fn()
    const result = await runner.runLiveAcceptance(
      {
        instanceId: 'o7-plan',
        artifactRoot: path.join(process.cwd(), '.local-only/taskwraith-studio/acceptance/o7-plan')
      },
      { runStudioAcceptance }
    )
    expect(result).toMatchObject({ launched: false, safety: { planOnlyByDefault: true } })
    expect(runStudioAcceptance).not.toHaveBeenCalled()
  })

  it('requires all three explicit package launch interlocks', () => {
    const base = {
      launch: true,
      instanceId: 'o7-live',
      artifactRoot: path.join(process.cwd(), '.local-only/taskwraith-studio/acceptance/o7-live'),
      packagedExecutablePath: '/tmp/TaskWraith.app/Contents/MacOS/TaskWraith',
      generateSpeechFixture: true
    }
    expect(() => runner.normalizeOptions(base)).toThrow(/isolated-launch/)
    expect(() => runner.normalizeOptions({ ...base, acceptLaunch: true })).toThrow(/orphan/)
    expect(() =>
      runner.normalizeOptions({
        ...base,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        packagedExecutablePath: null
      })
    ).toThrow(/packaged/)
  })

  it('requires a fresh bounded root whose basename is the instance id', () => {
    const outside = path.join(os.tmpdir(), 'o7-outside')
    expect(() =>
      runner.normalizeOptions({ instanceId: 'o7-outside', artifactRoot: outside })
    ).toThrow(/escaped/)
    expect(() =>
      runner.normalizeOptions({
        instanceId: 'o7-a',
        artifactRoot: path.join(process.cwd(), '.local-only/taskwraith-studio/acceptance/o7-b')
      })
    ).toThrow(/basename/)

    const root = path.join(process.cwd(), '.local-only/taskwraith-studio/acceptance/o7-taken')
    fs.mkdirSync(root)
    try {
      expect(() =>
        runner.normalizeOptions({
          launch: true,
          acceptLaunch: true,
          ownerConfirmsOrphansCleared: true,
          instanceId: path.basename(root),
          artifactRoot: root,
          packagedExecutablePath: '/tmp/TaskWraith.app/Contents/MacOS/TaskWraith',
          generateSpeechFixture: true
        })
      ).toThrow(/fresh/)
    } finally {
      fs.rmdirSync(root)
    }
  })

  it('bounds timeouts, ports, and media shape', () => {
    const root = path.join(process.cwd(), '.local-only/taskwraith-studio/acceptance/o7-bounds')
    expect(() =>
      runner.normalizeOptions({ instanceId: 'o7-bounds', artifactRoot: root, timeoutMs: 59_999 })
    ).toThrow(/timeout/)
    expect(() =>
      runner.normalizeOptions({
        instanceId: 'o7-bounds',
        artifactRoot: root,
        timeoutMs: 60_000,
        transcriptTimeoutMs: 60_001
      })
    ).toThrow(/transcript-timeout/)
    expect(() =>
      runner.normalizeOptions({
        instanceId: 'o7-bounds',
        artifactRoot: root,
        mediaPath: '/tmp/a.mp4',
        mimeType: 'audio/mp3'
      })
    ).toThrow(/mime/)
    expect(() => runner.parseCli(['--remote-debugging-port=80'])).toThrow(/port/)
  })

  it('preserves the complete packaged executable in the equals-form CLI option', () => {
    const executable = '/tmp/TaskWraith Debug.app/Contents/MacOS/TaskWraith Debug'
    expect(runner.parseCli([`--packaged-executable=${executable}`]).packagedExecutablePath).toBe(
      executable
    )
  })

  it('forwards the bounded open timeout through the real harness option builder', () => {
    const artifactRoot = path.join(
      process.cwd(),
      '.local-only/taskwraith-studio/acceptance/o7-open'
    )
    const parsed = runner.parseCli([
      '--instance-id=o7-open',
      `--artifact-root=${artifactRoot}`,
      '--open-timeout-ms=240000'
    ])
    const normalized = runner.normalizeOptions(parsed)
    const invocation = runner.buildHarnessRunOptions(normalized, {
      openAdapters: { sentinel: 'preserved' }
    })
    expect(normalized.openTimeoutMs).toBe(240_000)
    expect(invocation.adapters.openAdapters).toEqual({ sentinel: 'preserved', timeoutMs: 240_000 })
    expect(invocation.args.timeoutMs).toBe(normalized.timeoutMs)

    expect(() =>
      runner.normalizeOptions({
        instanceId: 'o7-open',
        artifactRoot,
        timeoutMs: 120_000,
        transcriptTimeoutMs: 60_000,
        openTimeoutMs: 120_000
      })
    ).toThrow(/open-timeout/)
  })

  it('keeps injected adapters outside the live CLI surface', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts/studio-source-range-lifecycle-runner.cjs'),
      'utf8'
    )
    expect(source).toContain('async function main(argv = process.argv.slice(2))')
    expect(source).toContain('const result = await runLiveAcceptance(parsed)')
    expect(source).not.toContain('runLiveAcceptance(parsed,')
    expect(source).toContain("require('./studio-acceptance-harness.cjs')")
    expect(source).toContain("require('./studio-bounded-lifecycle-runner.cjs')")
    expect(source).toContain("require('./studio-pixel-evidence-verifier.cjs')")
  })

  it('refuses live adapter overrides outside the explicit test seam', async () => {
    const instanceId = 'o7-adapter'
    const artifactRoot = path.join(
      process.cwd(),
      `.local-only/taskwraith-studio/acceptance/${instanceId}`
    )
    await expect(
      runner.runLiveAcceptance(
        {
          launch: true,
          acceptLaunch: true,
          ownerConfirmsOrphansCleared: true,
          instanceId,
          artifactRoot,
          packagedExecutablePath: '/tmp/TaskWraith.app/Contents/MacOS/TaskWraith',
          generateSpeechFixture: true
        },
        { runStudioAcceptance: vi.fn() }
      )
    ).rejects.toThrow(/test-only/)
  })
})

describe('low-level exact joins', () => {
  it('normalizes only two raw resolve responses for one exact base', () => {
    const hits = [
      {
        kind: 'response',
        method: 'studio/resolveProposal',
        params: { proposalId, baseRevision: 7 },
        requestId: 1,
        response: { result: { revision: 8 } }
      },
      {
        kind: 'response',
        method: 'studio/resolveProposal',
        params: { proposalId, baseRevision: 7 },
        requestId: 2,
        response: { error: { data: { studioCode: 'stale_base', currentRevision: 8 } } }
      },
      {
        kind: 'response',
        method: 'studio/resolveProposal',
        params: { proposalId: 'foreign', baseRevision: 7 },
        response: { result: { revision: 9 } }
      }
    ]
    expect(
      runner.normalizedResolveHits(hits, proposalId, 7).map((item: { kind: string }) => item.kind)
    ).toEqual(['accepted', 'stale_base'])
  })

  it('refuses extra insert fields instead of accepting a shaped impostor', () => {
    const op = { ...acceptedInsert(), trackId: 'V1' }
    expect(() => runner.exactInsert(op, { assetId })).toThrow(/keys/)
  })
})
