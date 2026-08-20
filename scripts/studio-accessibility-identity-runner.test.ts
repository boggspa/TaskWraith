import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const runner =
  require('./studio-accessibility-identity-runner.cjs') as typeof import('./studio-accessibility-identity-runner.cjs')

const packageExecutable = '/tmp/TaskWraith Debug.app/Contents/MacOS/TaskWraith Debug'
const companionExecutable =
  '/tmp/TaskWraith Debug.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion'
const windowBounds = { x: 100, y: 200, width: 1280, height: 800 }
const probeRoot = mkdtempSync(path.join(tmpdir(), 'taskwraith-o10-probe-test-'))
let probeSequence = 0

afterAll(() => rmSync(probeRoot, { recursive: true, force: true }))

function target() {
  return {
    electronPgid: 41,
    asset: { sha256: 'a'.repeat(43) },
    companion: {
      pid: 43,
      ppid: 42,
      pgid: 41,
      command: `${companionExecutable} --viewer`
    },
    window: {
      pid: 43,
      visibleWindowCount: 1,
      windows: [
        {
          windowId: 44,
          title: 'TaskWraith Studio',
          ownerName: 'TaskWraith Studio',
          bounds: windowBounds
        }
      ]
    }
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return runner.normalizeOptions({
    dockOwner: 'host',
    instanceId: 'o10test',
    artifactRoot: probeRoot,
    packagedExecutablePath: packageExecutable,
    ...overrides
  })
}

function request(owner: 'host' | 'companion' = 'host') {
  return runner.buildProbeRequest(
    { packagedExecutablePath: packageExecutable },
    target(),
    config({ dockOwner: owner })
  )
}

function element(
  order: number,
  input: Partial<Record<string, unknown>> & { role: string; path?: string }
) {
  const resolvedPath = input.path ?? (order === 0 ? 'window' : `window/${order - 1}`)
  return {
    order,
    path: resolvedPath,
    depth: resolvedPath.split('/').length - 1,
    role: input.role,
    identifier: input.identifier ?? null,
    label: input.label ?? null,
    value: input.value ?? null,
    enabled: input.enabled ?? true,
    valueSettable: input.valueSettable ?? false,
    actions: input.actions ?? [],
    frame: { x: 100 + order, y: 200, width: 40, height: 20 }
  }
}

function elements(selected = false, playheadValue = '0') {
  const rows = [
    element(0, { role: 'AXWindow', label: 'TaskWraith Studio' }),
    element(1, {
      role: 'AXGroup',
      identifier: 'studio.workspace.root',
      label: 'Studio workspace'
    }),
    element(2, { role: 'AXGroup', label: 'Viewer deck controls' }),
    element(3, {
      role: 'AXCheckBox',
      identifier: 'studio.workspace.route.source',
      label: 'Source',
      value: 'selected',
      actions: ['AXPress']
    }),
    element(4, {
      role: 'AXCheckBox',
      identifier: 'studio.workspace.route.timeline',
      label: 'Timeline',
      value: 'not selected',
      actions: ['AXPress']
    }),
    element(5, {
      role: 'AXRadioButton',
      identifier: 'studio.workspace.review-version.current',
      label: 'Current',
      value: 'unavailable',
      enabled: false,
      actions: ['AXPress']
    }),
    element(6, {
      role: 'AXRadioButton',
      identifier: 'studio.workspace.review-version.proposed',
      label: 'Proposed',
      value: 'unavailable',
      enabled: false,
      actions: ['AXPress']
    }),
    element(7, {
      role: 'AXGroup',
      identifier: 'studio.workspace.viewer.source',
      label: 'Source viewer'
    }),
    element(8, { role: 'AXGroup', label: 'Studio viewer' }),
    element(9, { role: 'AXStaticText', label: 'Timecode', value: '00:00:00:00' }),
    element(10, { role: 'AXStaticText', label: 'Loop marked range', value: 'off' }),
    element(11, {
      role: 'AXButton',
      identifier: 'Playback',
      label: 'Playback',
      value: 'paused',
      actions: ['AXPress']
    }),
    element(12, {
      role: 'AXSlider',
      identifier: 'Playhead',
      label: 'Playhead',
      value: playheadValue,
      valueSettable: true,
      actions: ['AXDecrement', 'AXIncrement']
    }),
    element(13, {
      role: 'AXButton',
      label: 'Opening line',
      value: selected ? 'Selected' : 'Not selected',
      actions: []
    }),
    element(14, {
      role: 'AXGroup',
      identifier: 'studio.workspace.transcript',
      label: 'Transcript'
    })
  ]
  return rows
}

function probeReceipt(
  owner: 'host' | 'companion' = 'host',
  options: { selected?: boolean; playheadValue?: string; companionPolicy?: string } = {}
) {
  const expected = request(owner)
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-accessibility-identity-probe-receipt',
    dockOwner: owner,
    recordedAt: '2026-08-20T20:00:00Z',
    host: {
      ...expected.host,
      isActive: true
    },
    companion: {
      ...expected.companion,
      activationPolicy: options.companionPolicy ?? expected.companion.activationPolicy,
      isActive: false
    },
    window: {
      windowId: 44,
      title: 'TaskWraith Studio',
      ownerName: 'TaskWraith Studio',
      bounds: windowBounds,
      accessibilityRole: 'AXWindow',
      accessibilityTitle: 'TaskWraith Studio'
    },
    elements: elements(options.selected, options.playheadValue),
    dock: {
      requested: true,
      available: true,
      dockPid: 55,
      memberships: [
        { subject: 'host', label: 'TaskWraith', matchCount: owner === 'host' ? 1 : 0 },
        {
          subject: 'companion',
          label: 'TaskWraith Studio',
          matchCount: owner === 'companion' ? 1 : 0
        }
      ]
    },
    focus: {
      frontmostPid: 42,
      frontmostBundleIdentifier: 'com.chrisizatt.taskwraith',
      cursorX: 20,
      cursorY: 30,
      hostIsActive: true,
      companionIsActive: false
    }
  }
}

function probe(owner: 'host' | 'companion' = 'host', selected = false, playhead = '0') {
  const probeRequest = request(owner)
  const receipt = probeReceipt(owner, { selected, playheadValue: playhead })
  const identifier = String(++probeSequence)
  const requestDirectory = path.join(probeRoot, 'outcome10-probe-requests')
  const receiptDirectory = path.join(probeRoot, 'outcome10-probe-receipts')
  const requestPath = path.join(requestDirectory, `${identifier}.json`)
  const stdoutPath = path.join(receiptDirectory, `${identifier}.json`)
  const stdout = `${JSON.stringify(receipt)}\n`
  mkdirSync(requestDirectory, { recursive: true })
  mkdirSync(receiptDirectory, { recursive: true })
  writeFileSync(requestPath, `${JSON.stringify(probeRequest)}\n`)
  writeFileSync(stdoutPath, stdout)
  return {
    request: probeRequest,
    receipt,
    requestPath,
    stdoutPath,
    stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
    stdoutByteLength: Buffer.byteLength(stdout)
  }
}

function focus(targetPid: number) {
  return {
    recordedAt: '2026-08-20T20:00:00Z',
    frontmostPid: 42,
    frontmostBundleIdentifier: 'com.chrisizatt.taskwraith',
    targetPid,
    targetIsActive: false,
    cursorX: 20,
    cursorY: 30,
    stdoutSha256: 'b'.repeat(64)
  }
}

function journey() {
  const apparatus = runner.measureApparatusCustody()
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-accessibility-identity-journey',
    outcomeStatus: 'partial',
    outcomePromotionAuthorized: false,
    automated: { status: 'pass', promotionAuthorized: false },
    humanChecklist: { status: 'required-not-recorded', acceptedInlineVerdicts: false },
    apparatusCustody: {
      before: apparatus,
      after: structuredClone(apparatus),
      unchanged: true
    }
  }
}

describe('Outcome 10 plan and authority boundary', () => {
  it('requires an explicit Dock owner and remains plan-only by default', async () => {
    await expect(
      runner.runAccessibilityIdentityAcceptance({
        instanceId: 'o10none',
        artifactRoot: '/tmp/o10none'
      })
    ).rejects.toThrow(/dockOwner is required/)
    const plan = await runner.runAccessibilityIdentityAcceptance({
      dockOwner: 'host',
      instanceId: 'o10plan',
      artifactRoot: '/tmp/o10plan'
    })
    expect(plan).toMatchObject({
      launched: false,
      dockOwner: 'host',
      humanBoundary: { required: true, acceptedInlineVerdicts: false },
      safety: { planOnlyByDefault: true, explicitDockOwnerRequired: true }
    })
  })

  it('requires every live launch interlock and a fresh packaged target', async () => {
    await expect(
      runner.runAccessibilityIdentityAcceptance({
        dockOwner: 'host',
        launch: true,
        instanceId: 'o10live',
        artifactRoot: '/tmp/o10-live-missing'
      })
    ).rejects.toThrow(/i-accept-studio-isolated-launch/)
    expect(() =>
      runner.normalizeOptions({
        dockOwner: 'host',
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: false,
        instanceId: 'o10live2',
        artifactRoot: '/tmp/o10-live-missing2',
        packagedExecutablePath: packageExecutable
      })
    ).toThrow(/owner-confirms-existing-orphans-cleared/)
  })

  it('never accepts caller-shaped VoiceOver or Cmd-Tab pass booleans', () => {
    for (const field of runner.FORBIDDEN_HUMAN_FIELDS) {
      expect(() => runner.normalizeOptions({ dockOwner: 'host', [field]: true })).toThrow(
        /refuses inline human verdict/
      )
    }
    expect(() => runner.parseCli(['--dock-owner=host', '--voiceover-passed'])).toThrow(
      /unknown Outcome 10 argument/
    )
    expect(() =>
      runner.normalizeOptions({ dockOwner: 'host', humanChecklistReceipt: true })
    ).toThrow(/unknown field/)
  })
})

describe('Outcome 10 probe validation', () => {
  it('accepts one exact host-owned Dock identity and closed public AX tree', () => {
    const normalized = runner.validateProbeReceipt(probeReceipt(), request())
    expect(normalized.playback).toMatchObject({ value: 'paused', actions: ['AXPress'] })
    expect(normalized.playhead).toMatchObject({ valueSettable: true })
    expect(normalized.transcriptButtons).toHaveLength(1)
  })

  it('records an explicitly disabled Dock probe without manufacturing membership evidence', () => {
    const noDockConfig = config({ includeDock: false })
    const noDockRequest = runner.buildProbeRequest(
      { packagedExecutablePath: packageExecutable },
      target(),
      noDockConfig
    )
    const receipt = {
      ...probeReceipt(),
      dock: {
        requested: false,
        available: false,
        dockPid: null,
        memberships: [
          { subject: 'host', label: 'TaskWraith', matchCount: 0 },
          { subject: 'companion', label: 'TaskWraith Studio', matchCount: 0 }
        ]
      }
    }
    expect(runner.validateProbeReceipt(receipt, noDockRequest)).toMatchObject({
      playback: { value: 'paused' }
    })
  })

  it('fails the current accessory Companion when Companion owns Dock/Cmd-Tab', () => {
    expect(request('companion')).toMatchObject({
      host: { activationPolicy: 'accessory' },
      companion: { activationPolicy: 'regular' }
    })
    expect(() =>
      runner.validateProbeReceipt(
        probeReceipt('companion', { companionPolicy: 'accessory' }),
        request('companion')
      )
    ).toThrow(/companion identity or activation policy changed/)
  })

  it('rejects missing or duplicate exact AX identities', () => {
    const missing = probeReceipt()
    missing.elements = missing.elements.filter(
      (entry: Record<string, unknown>) => entry.identifier !== 'Playhead'
    )
    missing.elements.forEach((entry: Record<string, unknown>, index: number) => {
      entry.order = index
    })
    expect(() => runner.validateProbeReceipt(missing, request())).toThrow(/Playhead AX identity/)

    const duplicate = probeReceipt()
    duplicate.elements.push({
      ...duplicate.elements[11],
      order: duplicate.elements.length,
      path: 'window/dup'
    })
    expect(() => runner.validateProbeReceipt(duplicate, request())).toThrow(/Playback AX identity/)
  })

  it('binds adapter probe evidence to the runner-owned request and artifact root', () => {
    const evidence = probe()
    expect(runner.validateBoundProbe(evidence, config(), target(), config())).toMatchObject({
      playback: { value: 'paused' }
    })

    expect(() =>
      runner.validateBoundProbe(
        { ...evidence, request: { ...evidence.request, includeDock: false } },
        config(),
        target(),
        config()
      )
    ).toThrow(/not runner-bound/)
    expect(() =>
      runner.validateBoundProbe(
        { ...evidence, requestPath: '/tmp/foreign-request.json' },
        config(),
        target(),
        config()
      )
    ).toThrow(/outside the runner artifact root/)
    expect(() =>
      runner.validateBoundProbe(
        { ...evidence, stdoutSha256: 'b'.repeat(64) },
        config(),
        target(),
        config()
      )
    ).toThrow(/digest changed/)

    const replaced = probe()
    writeFileSync(replaced.stdoutPath, '{}\n')
    expect(() => runner.validateBoundProbe(replaced, config(), target(), config())).toThrow(
      /length is invalid|digest changed/
    )
  })

  it('pins the Swift probe to closed schemas, public AX traversal and activation policy', () => {
    const source = readFileSync(
      path.resolve(__dirname, 'studio-accessibility-identity-probe.swift'),
      'utf8'
    )
    expect(source).toContain('Set(object.keys) == expected')
    expect(source).toContain('AXUIElementCopyAttributeValue')
    expect(source).toContain('AXUIElementIsAttributeSettable')
    expect(source).toContain('NSWorkspace.shared.runningApplications')
    expect(source).toContain('application.activationPolicy')
    expect(source).toContain('AX tree exceeds the bounded traversal depth')
    expect(source).toContain('Dock AX tree exceeds the bounded element count')
    expect(source).not.toContain('CGEvent(')
    expect(source).not.toContain('.activate(')
  })
})

describe('Outcome 10 focus and keyboard adjudication', () => {
  it('rejects focus theft and cursor movement', () => {
    const stolen = { ...focus(43), frontmostPid: 43, targetIsActive: true }
    expect(() => runner.assertFocusPreserved(focus(43), stolen, 43, 'keyboard')).toThrow(
      /focus snapshot is invalid|stole focus/
    )
    expect(() =>
      runner.assertFocusPreserved(focus(43), { ...focus(43), cursorX: 99 }, 43, 'keyboard')
    ).toThrow(/moved the cursor/)
  })

  it('rejects delivered keys without an independently recomputed state transition', () => {
    const receipt = {
      actions: [
        { type: 'key', key: 'tab' },
        { type: 'key', key: 'a' }
      ]
    }
    expect(() =>
      runner.validateKeyboardCoverage(
        [receipt],
        [{ key: 'tab', effect: 'transcript-selection-changed' }]
      )
    ).toThrow(/no independently recomputed adjudication/)
  })

  it('rejects a Tab receipt that was not delivered through the explicit foreground bracket', () => {
    expect(() =>
      runner.adjudicateKeyboardEvidence(
        { inputDelivery: 'background-observation-only', actions: [{ type: 'key', key: 'tab' }] },
        probe('host', false),
        probe('host', true)
      )
    ).toThrow(/explicit foreground delivery/)
  })

  it('executes the bounded automated journey and keeps the outcome Partial', async () => {
    const focusQueue = [focus(43), focus(43), focus(43), focus(43), focus(43)]
    const probes = [probe('host', true, '0'), probe('host', false, '1'), probe('host', true, '1')]
    const runStudioUiDriver = vi.fn(
      async (_plan: unknown, _target: unknown, actions: Array<Record<string, unknown>>) => ({
        inputDelivery: actions.some((action) => action.type === 'key')
          ? 'foreground-global-explicit'
          : 'background-observation-only',
        actions: actions.map((action, index) => ({ index, ...action }))
      })
    )
    const result = await runner.runAutomatedJourney(
      { artifactRoot: probeRoot, packagedExecutablePath: packageExecutable },
      target(),
      config(),
      {
        focusBeforeOpen: focus(0),
        readTranscriptStatus: async () => ({ assetId: 'a'.repeat(43), state: 'available' })
      },
      {
        focusSnapshot: () => focusQueue.shift(),
        runProbe: async () => probes.shift(),
        runStudioUiDriver,
        waitFor: async (options: { probe: () => Promise<unknown> }) => options.probe()
      }
    )
    expect(result).toMatchObject({
      automated: { status: 'pass', promotionAuthorized: false },
      humanChecklist: { status: 'required-not-recorded', acceptedInlineVerdicts: false },
      outcomeStatus: 'partial',
      outcomePromotionAuthorized: false,
      keyboard: { coverage: { delivered: ['tab'], adjudicated: ['tab'] } }
    })
    expect(runStudioUiDriver).toHaveBeenCalledTimes(2)
  })
})

describe('Outcome 10 harness composition', () => {
  it('requires unchanged custody and exact watchdog reaping', () => {
    const custody = { sourceDigest: 'source', outDigest: 'out' }
    const packaged = { bundleIdentityDigest: 'package' }
    const good = {
      launched: true,
      evidence: {
        ok: true,
        journey: journey(),
        custodyBefore: custody,
        custodyAfter: { ...custody },
        packagedExecutionBefore: packaged,
        packagedExecutionAfter: { ...packaged },
        watchdogTerminal: {
          status: 'reaped',
          groupExitVerified: true,
          detachedGroupExitVerified: true
        }
      }
    }
    expect(runner.assertHarnessBoundary(good)).toBe(good.evidence)
    expect(() =>
      runner.assertHarnessBoundary({
        ...good,
        evidence: { ...good.evidence, watchdogTerminal: { status: 'running' } }
      })
    ).toThrow(/terminal reaping/)
    expect(() =>
      runner.assertHarnessBoundary({
        ...good,
        evidence: { ...good.evidence, custodyAfter: { sourceDigest: 'changed' } }
      })
    ).toThrow(/custody changed/)
    expect(() =>
      runner.assertHarnessBoundary({
        ...good,
        evidence: {
          ...good.evidence,
          journey: {
            ...journey(),
            humanChecklist: { status: 'passed', acceptedInlineVerdicts: true }
          }
        }
      })
    ).toThrow(/overclaimed/)
  })

  it('wires the signed disposable harness and cannot promote without human evidence', async () => {
    const custody = { digest: 'same' }
    const packaged = { digest: 'same-package' }
    const runStudioAcceptance = vi.fn(
      async (args: Record<string, unknown>, adapters: Record<string, unknown>) => {
        expect(args).toMatchObject({
          launch: true,
          acceptLaunch: true,
          ownerConfirmsOrphansCleared: true,
          generateSpeechFixture: true,
          packagedExecutablePath: packageExecutable
        })
        expect(adapters).toHaveProperty('invokeStudioOpen')
        expect(adapters).toHaveProperty('driveUiJourney')
        return {
          launched: true,
          evidence: {
            ok: true,
            journey: journey(),
            custodyBefore: custody,
            custodyAfter: { ...custody },
            packagedExecutionBefore: packaged,
            packagedExecutionAfter: { ...packaged },
            watchdogTerminal: {
              status: 'reaped',
              groupExitVerified: true,
              detachedGroupExitVerified: true
            }
          }
        }
      }
    )
    const result = await runner.runAccessibilityIdentityAcceptance(
      {
        dockOwner: 'host',
        launch: true,
        acceptLaunch: true,
        ownerConfirmsOrphansCleared: true,
        instanceId: 'o10wire',
        artifactRoot: '/tmp/o10-wire-fresh',
        packagedExecutablePath: packageExecutable
      },
      { runStudioAcceptance }
    )
    expect(result.outcome10).toEqual({
      schemaVersion: 1,
      kind: 'taskwraith-studio-accessibility-identity-result',
      status: 'partial',
      automatedStatus: 'pass',
      humanChecklistStatus: 'required-not-recorded',
      promotionAuthorized: false
    })
  })
})
