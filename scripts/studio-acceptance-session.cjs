#!/usr/bin/env node
'use strict'

/**
 * Shared, tracked Studio acceptance session surface.
 *
 * Disposable launch, exact process/window custody, native capture, OCR, and
 * focus isolation were previously reachable only through two untracked
 * local-only runners. The reusable launch/capture implementation now lives in
 * the tracked LUT runner while this module exposes the outcome-neutral contract
 * and adds the resource probes shared by diagnostics and endurance. Artifacts
 * may still be written under .local-only; executable apparatus may not be
 * loaded from there.
 */

const crypto = require('node:crypto')
const path = require('node:path')

const lut = require('./studio-lut-acceptance-runner.cjs')

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function parseBytes(text) {
  const match = String(text)
    .trim()
    .match(/^([0-9]+(?:\.[0-9]+)?)([KMGT]?)$/i)
  if (!match) throw new Error('could not parse byte quantity: ' + String(text))
  const powers = {
    '': 1,
    K: 1024,
    M: 1_048_576,
    G: 1_073_741_824,
    T: 1_099_511_627_776
  }
  return Math.round(Number(match[1]) * powers[match[2].toUpperCase()])
}

function parseVmmapSummary(stdout) {
  const footprintMatch = stdout.match(/^Physical footprint:\s+([0-9.]+[KMGT]?)/m)
  const peakMatch = stdout.match(/^Physical footprint \(peak\):\s+([0-9.]+[KMGT]?)/m)
  const ioLine = stdout.split('\n').find((line) => /^IOSurface\s+[0-9.]+[KMGT]?\s+/.test(line))
  const zoneStart = stdout.indexOf('MALLOC ZONE')
  const zoneText = zoneStart >= 0 ? stdout.slice(zoneStart) : ''
  const zoneTotal = zoneText.split('\n').find((line) => /^TOTAL\s+/.test(line))
  if (!footprintMatch || !peakMatch || !ioLine || !zoneTotal) {
    throw new Error('vmmap summary omitted required allocation classes')
  }
  const ioTokens = ioLine.trim().split(/\s+/)
  const zoneTokens = zoneTotal.trim().split(/\s+/)
  if (zoneTokens.length < 7) throw new Error('vmmap malloc-zone total shape changed')
  return {
    physicalFootprintBytes: parseBytes(footprintMatch[1]),
    peakPhysicalFootprintBytes: parseBytes(peakMatch[1]),
    iosurfaceVirtualBytes: parseBytes(ioTokens[1]),
    iosurfaceResidentBytes: parseBytes(ioTokens[3]),
    iosurfaceRegionCount: Number(ioTokens.at(-1)),
    mallocAllocatedBytes: parseBytes(zoneTokens[6])
  }
}

function parseVmmapSurfaces(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    const range = line.match(/^IOSurface\s+([0-9a-f]+)-([0-9a-f]+)/i)
    if (!range) continue
    const explicitSurface = line.match(/\bSurfaceID:\s*(0x[0-9a-f]+)/i)
    const abbreviatedSurface = line.match(/\.\.\.\s+(0x[0-9a-f]+)\s+\d+x\d+/i)
    rows.push({
      addressRange: range[1] + '-' + range[2],
      surfaceId: explicitSurface?.[1] || abbreviatedSurface?.[1] || null,
      coreUi: line.includes('CoreUI image IOSurface')
    })
  }
  return {
    productSurfaceIds: rows
      .filter((row) => row.surfaceId && !row.coreUi)
      .map((row) => row.surfaceId)
      .sort(),
    mappedRegionIdentities: rows
      .filter((row) => !row.coreUi)
      .map((row) => row.surfaceId || row.addressRange)
      .sort()
  }
}

function parseTop(stdout, pid) {
  const line = stdout
    .split('\n')
    .find((candidate) => candidate.trim().startsWith(String(pid) + ' '))
  if (!line) throw new Error('top omitted exact companion pid ' + String(pid))
  const tokens = line.trim().split(/\s+/)
  return {
    pid: Number(tokens[0]),
    cpuPercent: Number(tokens[1]),
    memoryText: tokens[2],
    power: Number(tokens[3]),
    cpuTime: tokens[4],
    command: tokens.slice(5).join(' ')
  }
}

function parsePs(stdout, pid) {
  const match = stdout.trim().match(/^\s*(\d+)\s+([0-9.]+)\s+(\d+)\s+(\d+)\s+(.+)$/)
  if (!match || Number(match[1]) !== pid) throw new Error('ps omitted exact companion')
  return {
    pid,
    cpuPercent: Number(match[2]),
    rssKilobytes: Number(match[3]),
    virtualKilobytes: Number(match[4]),
    elapsedCpuTime: match[5].trim()
  }
}

function resourceSample(pid, index, elapsedSeconds, adapters = {}) {
  const run = adapters.runExact || lut.runExact
  const summary = run('/usr/bin/vmmap', ['-summary', String(pid)], {
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024
  })
  const detailed = run('/usr/bin/vmmap', [String(pid)], {
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024
  })
  const top = run(
    '/usr/bin/top',
    ['-l', '1', '-pid', String(pid), '-stats', 'pid,cpu,mem,power,time,command'],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
  )
  const ps = run('/bin/ps', ['-p', String(pid), '-o', 'pid=,%cpu=,rss=,vsz=,time='], {
    timeout: 5_000
  })
  return {
    index,
    recordedAt: new Date().toISOString(),
    elapsedSeconds,
    ...parseVmmapSummary(summary.stdout),
    ...parseVmmapSurfaces(detailed.stdout),
    top: parseTop(top.stdout, pid),
    ps: parsePs(ps.stdout, pid),
    rawReceipts: {
      vmmapSummarySha256: sha256Bytes(summary.stdout),
      vmmapDetailedSha256: sha256Bytes(detailed.stdout),
      topSha256: sha256Bytes(top.stdout),
      psSha256: sha256Bytes(ps.stdout),
      commands: [summary.command, detailed.command, top.command, ps.command]
    }
  }
}

function assertWindowServerSessionAvailable(sampleIndex, phase, state = lut.consoleSessionState()) {
  if (!state.windowServerEvidenceAvailable) {
    throw new Error(
      'Studio WindowServer session unavailable at sample ' +
        String(sampleIndex) +
        ' ' +
        phase +
        ': ' +
        JSON.stringify(state)
    )
  }
  return state
}

function hudContainsAsset(hud, assetId) {
  return lut.matchHudAssetIdentity(hud, assetId)
}

function assertSourceWindowFocusIsolation(before, after, targetPid) {
  return lut.assertFocusIsolation(before, after, targetPid, 'Studio workspace')
}

module.exports = {
  assertSourceWindowFocusIsolation,
  assertAcceptanceCustody: lut.assertCustody,
  assertWindowServerSessionAvailable,
  captureNative: lut.captureNative,
  consoleSessionState: lut.consoleSessionState,
  exactCompanionProcess: lut.exactCompanionProcess,
  focusSnapshot: lut.focusSnapshot,
  hudContainsAsset,
  invokeStudioOpen: lut.invokeStudioOpen,
  materializePortableInputs: lut.materializePortableInputs,
  ocrScreenshot: lut.ocrScreenshot,
  openMediaPane: lut.openMediaPane,
  parseBytes,
  parsePs,
  parseTop,
  parseVmmapSummary,
  parseVmmapSurfaces,
  prepareFreshRuntime: lut.prepareFreshRuntime,
  repoRoot: path.resolve(__dirname, '..'),
  resolveMediaTool: lut.resolveMediaTool,
  resourceSample,
  runExact: lut.runExact,
  sha256File: lut.sha256File,
  waitForSourceWindow: lut.waitForSourceWindow,
  windowBounds: lut.windowBounds,
  withIsolatedSession: lut.withIsolatedSession,
  writeJson: lut.writeJson
}
