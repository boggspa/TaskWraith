import * as fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RendererDiagnosticRecorder,
  RendererDiagnosticRing,
  type RendererDiagnosticTarget
} from './RendererDiagnosticRing'
import {
  RENDERER_DIAGNOSTIC_SCHEMA_VERSION,
  type RendererDiagnosticSample
} from '../shared/rendererDiagnostics'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function testPath(name = 'renderer-diagnostics.json'): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-renderer-diagnostics-'))
  roots.push(root)
  return join(root, name)
}

function sample(index: number): RendererDiagnosticSample {
  return {
    schemaVersion: RENDERER_DIAGNOSTIC_SCHEMA_VERSION,
    sampledAt: new Date(index * 1_000).toISOString(),
    cause: 'interval',
    windowId: 1,
    webContentsId: 2,
    rendererPid: 3,
    activeChatMessageCount: index,
    chatUpdates: {
      rendererReceived: index,
      rendererSnapshots: 0,
      rendererPatches: 0,
      rendererApplyFailures: 0,
      rendererAcksSent: 0,
      mainSnapshots: 0,
      mainPatches: 0,
      mainBaselineDrops: 0,
      mainTrackedChats: 0,
      mainInFlight: 0,
      mainPending: 0,
      mainRetainedMessages: 0,
      mainRetainedBytes: 0
    }
  }
}

describe('RendererDiagnosticRing', () => {
  it('persists only its fixed-capacity tail and reloads it', () => {
    const filePath = testPath()
    const ring = new RendererDiagnosticRing(filePath, { capacity: 8 })
    for (let index = 0; index < 12; index += 1) ring.append(sample(index))

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    expect(persisted.capacity).toBe(8)
    expect(persisted.samples).toHaveLength(8)
    expect(persisted.samples[0].activeChatMessageCount).toBe(4)

    const reloaded = new RendererDiagnosticRing(filePath, { capacity: 8 }).snapshot()
    expect(reloaded.samples.map((entry) => entry.activeChatMessageCount)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11
    ])
  })

  it('combines renderer heap with RSS, persisted chat bytes, and transport counters', () => {
    const filePath = testPath()
    const chatPath = join(filePath, '..', 'chat.json')
    fs.writeFileSync(chatPath, 'x'.repeat(321))
    const now = new Date('2026-08-14T21:00:00.000Z')
    const recorder = new RendererDiagnosticRecorder({
      filePath,
      now: () => now,
      getAppMetrics: () => [
        {
          pid: 44,
          type: 'Tab',
          creationTime: 1,
          cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0, cumulativeCPUUsage: 0 },
          memory: { workingSetSize: 1_024, peakWorkingSetSize: 2_048, privateBytes: 512 },
          sandboxed: true,
          integrityLevel: 'unknown'
        }
      ],
      getChatRecordPath: (chatId) => (chatId === 'chat-sensitive-id' ? chatPath : null),
      getChatUpdateTargetStats: () => ({
        trackedChats: 2,
        inFlight: 1,
        pending: 1,
        retainedMessages: 90,
        retainedBaselineBytes: 4_096
      }),
      getChatUpdateProtocolCounters: () => ({ snapshots: 3, patches: 12, baselineDrops: 1 })
    })
    const target: RendererDiagnosticTarget = {
      windowId: 7,
      webContentsId: 8,
      rendererPid: 44
    }

    const recorded = recorder.recordClientSample(target, {
      activeChatId: 'chat-sensitive-id',
      activeChatMessageCount: 11_574,
      v8HeapUsedBytes: 1_500_000_000,
      v8HeapTotalBytes: 1_700_000_000,
      v8HeapLimitBytes: 2_000_000_000,
      chatUpdates: {
        received: 15,
        snapshots: 3,
        patches: 12,
        applyFailures: 1,
        acksSent: 14
      }
    })

    expect(recorded).toMatchObject({
      sampledAt: now.toISOString(),
      rendererRssBytes: 1_048_576,
      rendererPeakRssBytes: 2_097_152,
      rendererPrivateBytes: 524_288,
      v8HeapUsedBytes: 1_500_000_000,
      activeChatMessageCount: 11_574,
      activeChatPersistedBytes: 321,
      chatUpdates: {
        rendererReceived: 15,
        rendererPatches: 12,
        mainSnapshots: 3,
        mainPatches: 12,
        mainBaselineDrops: 1,
        mainRetainedBytes: 4_096
      }
    })
    expect(recorded.activeChatIdHash).toMatch(/^[a-f0-9]{16}$/)
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('chat-sensitive-id')
  })

  it('writes a terminal crash sample with the last-known renderer measurements', () => {
    const filePath = testPath()
    let metricsAvailable = true
    const recorder = new RendererDiagnosticRecorder({
      filePath,
      getAppMetrics: () =>
        metricsAvailable
          ? ([
              {
                pid: 44,
                type: 'Tab',
                creationTime: 1,
                cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0, cumulativeCPUUsage: 0 },
                memory: { workingSetSize: 900, peakWorkingSetSize: 950 },
                sandboxed: true,
                integrityLevel: 'unknown'
              }
            ] as Electron.ProcessMetric[])
          : []
    })
    recorder.recordClientSample(
      { windowId: 1, webContentsId: 2, rendererPid: 44 },
      {
        v8HeapUsedBytes: 777,
        activeChatMessageCount: 99,
        chatUpdates: { received: 5 }
      }
    )
    metricsAvailable = false

    const terminal = recorder.recordLifecycleSample(
      { windowId: 1, webContentsId: 2, rendererPid: 0 },
      'render-process-gone',
      { reason: 'oom', exitCode: 9 }
    )

    expect(terminal).toMatchObject({
      cause: 'render-process-gone',
      rendererPid: 44,
      rendererRssBytes: 900 * 1024,
      v8HeapUsedBytes: 777,
      activeChatMessageCount: 99,
      crashReason: 'oom',
      crashExitCode: 9
    })
  })
})
