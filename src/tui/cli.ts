#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { HostProjectionClient } from '../main/host/HostProjectionClient'
import {
  TW_MISSION_MAX_BUNDLE_BYTES,
  importTwMissionBundleBytes,
  type TwMissionManifest
} from '../main/host/twmission'
import type { HostSnapshot } from '../shared/hostProtocol'
import { Ansi } from './ansi'
import { TaskWraithTui } from './TaskWraithTui'
import {
  parseTaskWraithTuiArgs,
  taskWraithTuiUsage,
  type TaskWraithTuiCliOptions
} from './cliOptions'
import {
  mapHostSnapshotToControlSnapshot,
  mapHostSnapshotToThreadDetail
} from './hostProjectionMap'
import { renderTaskWraithTui } from './render'
import { createTaskWraithTuiDemoState, type TaskWraithTuiState } from './state'
import { detectTuiUnicode, resolveTuiGlyphs, type TuiGlyphSet } from './theme'

const TUI_VERSION = '0.2.0'

function pickThread(
  snapshot: { threads: Array<{ id: string; archived: boolean; updatedAt: number }> },
  threadId?: string
): string | undefined {
  if (threadId && snapshot.threads.some((thread) => thread.id === threadId)) return threadId
  return [...snapshot.threads]
    .filter((thread) => !thread.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id
}

function resolveCliGlyphs(options: TaskWraithTuiCliOptions): TuiGlyphSet {
  return resolveTuiGlyphs(options.ascii ? false : detectTuiUnicode())
}

function stateFromHostSnapshot(
  hostSnapshot: HostSnapshot,
  options: {
    connection: 'connected' | 'replay'
    threadId?: string
    hostVersion?: string
  }
): TaskWraithTuiState {
  const snapshot = mapHostSnapshotToControlSnapshot(hostSnapshot)
  const threadId = pickThread(snapshot, options.threadId)
  const detail = threadId ? mapHostSnapshotToThreadDetail(hostSnapshot, threadId) : null
  return {
    connection: options.connection,
    ...(options.hostVersion ? { hostVersion: options.hostVersion } : {}),
    snapshot,
    hostProjection: hostSnapshot,
    ...(detail ? { thread: detail.thread, selectedThreadId: detail.thread.thread.id } : {}),
    input: '',
    inputCursor: 0,
    overlay: 'none',
    overlayIndex: 0,
    missionFilter: 'active',
    missionParticipantOffset: 0,
    scrollOffset: 0,
    animationFrame: 0,
    tuneEffortIndex: 0,
    ...(options.connection === 'replay'
      ? {
          notice: {
            text: 'Detached replay · commands disabled',
            tone: 'neutral' as const
          }
        }
      : {})
  }
}

async function connectedSnapshot(options: TaskWraithTuiCliOptions): Promise<TaskWraithTuiState> {
  const client = new HostProjectionClient({
    client: {
      clientId: `tui-snapshot-${randomUUID()}`,
      clientClass: 'tui',
      clientVersion: TUI_VERSION,
      displayName: 'TaskWraith TUI'
    },
    capabilities: ['bootstrap', 'snapshot', 'health'],
    userDataPath: options.userDataPath
  })
  try {
    const welcome = await client.connect()
    const frame = await client.getSnapshot()
    return stateFromHostSnapshot(frame.snapshot, {
      connection: 'connected',
      hostVersion: welcome.hostVersion,
      ...(options.threadId ? { threadId: options.threadId } : {})
    })
  } finally {
    client.close()
  }
}

async function loadReplay(
  options: TaskWraithTuiCliOptions
): Promise<{ state: TaskWraithTuiState; manifest: TwMissionManifest }> {
  const replayPath = options.replayPath
  if (!replayPath) throw new Error('Replay path is required.')
  const metadata = await stat(replayPath)
  if (!metadata.isFile()) throw new Error('Replay path must name a regular file.')
  if (metadata.size > TW_MISSION_MAX_BUNDLE_BYTES) {
    throw new Error('Replay bundle exceeds the size ceiling.')
  }
  const bytes = await readFile(replayPath)
  const imported = importTwMissionBundleBytes(bytes)
  if (!imported.ok) throw new Error(`Replay rejected: ${imported.error}`)
  return {
    state: stateFromHostSnapshot(imported.replay.snapshot, {
      connection: 'replay',
      ...(options.threadId ? { threadId: options.threadId } : {})
    }),
    manifest: imported.replay.manifest
  }
}

function renderSnapshotState(state: TaskWraithTuiState, options: TaskWraithTuiCliOptions): void {
  const output = renderTaskWraithTui(state, {
    width: options.width,
    height: options.height,
    ansi: new Ansi(options.colorMode),
    animationEnabled: options.animationEnabled,
    glyphs: resolveCliGlyphs(options)
  })
  process.stdout.write(`${output}\n`)
}

function printJsonProjection(
  state: TaskWraithTuiState,
  source: 'host' | 'demo' | 'twmission-replay',
  manifest?: TwMissionManifest
): void {
  const snapshot = state.hostProjection
  if (!snapshot) throw new Error('No coherent Host projection is available for JSON output.')
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        source,
        ...(state.hostVersion ? { hostVersion: state.hostVersion } : {}),
        generation: snapshot.generation,
        cursor: snapshot.cursor,
        freshness: snapshot.freshness,
        ...(state.selectedThreadId ? { selectedThreadId: state.selectedThreadId } : {}),
        ...(manifest ? { manifest } : {}),
        snapshot
      },
      null,
      2
    )}\n`
  )
}

async function exportTwMission(options: TaskWraithTuiCliOptions): Promise<void> {
  const exportPath = options.exportPath
  if (!exportPath) throw new Error('Export path is required.')
  const client = new HostProjectionClient({
    client: {
      clientId: `tui-export-${randomUUID()}`,
      clientClass: 'tui',
      clientVersion: TUI_VERSION,
      displayName: 'TaskWraith TUI export'
    },
    capabilities: ['bootstrap', 'snapshot', 'compact-export', 'health'],
    userDataPath: options.userDataPath
  })
  try {
    const welcome = await client.connect()
    if (!welcome.capabilities.includes('compact-export')) {
      throw new Error('This TaskWraith Host does not offer compact export.')
    }
    const exported = await client.exportTwMission()
    await writeFile(exportPath, exported.bytes, {
      flag: options.force ? 'w' : 'wx',
      mode: 0o600
    })
    await chmod(exportPath, 0o600)
    process.stdout.write(
      `Exported ${exported.bytes.byteLength} bytes to ${exportPath}\n${exported.bundle.manifest.integrityDigest}\n`
    )
  } finally {
    client.close()
  }
}

let activeTui: TaskWraithTui | null = null

async function main(): Promise<void> {
  const options = parseTaskWraithTuiArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${taskWraithTuiUsage(TUI_VERSION)}\n`)
    return
  }
  if (options.version) {
    process.stdout.write(`${TUI_VERSION}\n`)
    return
  }
  if (options.exportPath) {
    await exportTwMission(options)
    return
  }
  if (options.replayPath) {
    const replay = await loadReplay(options)
    if (options.json) printJsonProjection(replay.state, 'twmission-replay', replay.manifest)
    else renderSnapshotState(replay.state, options)
    return
  }
  if (options.json) {
    const state = options.demo ? createTaskWraithTuiDemoState() : await connectedSnapshot(options)
    printJsonProjection(state, options.demo ? 'demo' : 'host')
    return
  }
  if (options.snapshot) {
    const state = options.demo ? createTaskWraithTuiDemoState() : await connectedSnapshot(options)
    renderSnapshotState(state, options)
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Interactive mode requires a terminal. Use --snapshot, --json, --export, or --replay for redirected output.'
    )
  }
  activeTui = new TaskWraithTui({
    clientVersion: TUI_VERSION,
    demo: options.demo,
    colorMode: options.colorMode,
    animationEnabled: options.animationEnabled,
    glyphs: resolveCliGlyphs(options),
    ...(options.threadId ? { initialThreadId: options.threadId } : {}),
    ...(options.userDataPath ? { userDataPath: options.userDataPath } : {})
  })
  await activeTui.start()
}

process.once('SIGINT', () => {
  activeTui?.stop()
  process.exitCode = 130
})
process.once('SIGTERM', () => {
  activeTui?.stop()
  process.exitCode = 143
})
process.once('SIGHUP', () => {
  activeTui?.stop()
  process.exitCode = 129
})
// A last line of defence: an escaped exception anywhere in the run loop must
// still restore raw mode / the alternate screen before the process ends.
process.once('uncaughtException', (error) => {
  activeTui?.stop()
  process.stderr.write(
    `TaskWraith TUI: unexpected error — ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
})
process.once('unhandledRejection', (reason) => {
  activeTui?.stop()
  process.stderr.write(
    `TaskWraith TUI: unexpected rejection — ${reason instanceof Error ? reason.message : String(reason)}\n`
  )
  process.exitCode = 1
})
process.on('exit', () => {
  activeTui?.stop()
})

void main().catch((error) => {
  activeTui?.stop()
  process.stderr.write(
    `TaskWraith TUI: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
})
