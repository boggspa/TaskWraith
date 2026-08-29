#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { HostProjectionClient } from '../host-client/HostProjectionClient'
import {
  TW_MISSION_MAX_BUNDLE_BYTES,
  importTwMissionBundleBytes,
  type TwMissionManifest
} from '../host-shared/twmission'
import type { HostSnapshot } from '../shared/hostProtocol'
import { Ansi } from './ansi'
import {
  isAutoThemeName,
  resolveAutoTheme,
  resolveTuiTheme,
  tuiThemeForColorMode,
  type TuiTheme
} from './palette'
import { resolveTuiAppearance, type TuiAppearanceProbeIo } from './appearance'
import {
  readTuiProfileSettings,
  readTuiSettings,
  writeTuiProfileSettings,
  writeTuiSettings
} from './settings'
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
import {
  buildTaskWraithTuiJsonProjection,
  type TaskWraithTuiJsonProjectionSource
} from './jsonProjection'
import { ensureTuiHostAvailable } from './hostProcessManager'
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

/**
 * The theme this run paints in.
 *
 * Two steps, and the second is the one that matters: the named theme is chosen
 * first, then reconciled with what the terminal can actually render. A theme
 * whose depth needs 24-bit colour gives its ground up on a 256-colour terminal
 * rather than painting three surfaces that quantise to the same flat block.
 */
/**
 * Terminal I/O for the OSC 11 probe, or `undefined` when there is no tty to ask.
 *
 * Deliberately built fresh and used exactly once, at startup, before the
 * interactive TUI attaches its own input handling. Raw mode and the resume/pause
 * pair below would fight the TUI's reader if this ran any later.
 */
function nodeAppearanceProbe(): TuiAppearanceProbeIo | undefined {
  const input = process.stdin
  const output = process.stdout
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return undefined
  return {
    isTty: true,
    hasPendingInput: () => input.readableLength > 0,
    setRawMode: (raw) => {
      input.setRawMode(raw)
    },
    write: (data) => {
      output.write(data)
    },
    read: (timeoutMs) =>
      new Promise((resolve) => {
        let buffer = ''
        const finish = (): void => {
          clearTimeout(timer)
          input.off('data', onData)
          input.pause()
          resolve(buffer)
        }
        const onData = (chunk: Buffer): void => {
          // latin1 keeps every byte addressable: the reply is ASCII, but a
          // multi-byte decode would mangle any keystroke that arrives with it.
          buffer += chunk.toString('latin1')
          if (buffer.includes(OSC_REPLY_BEL) || buffer.includes(OSC_REPLY_ST)) finish()
        }
        const timer = setTimeout(finish, timeoutMs)
        input.on('data', onData)
        input.resume()
      })
  }
}

const OSC_REPLY_BEL = String.fromCharCode(7)
const OSC_REPLY_ST = `${String.fromCharCode(27)}\\`

/**
 * The theme this run paints in.
 *
 * Three steps, and the last is the one that matters: `auto` is measured, the
 * named theme is looked up, and either way the result is reconciled with what
 * the terminal can actually render. A theme whose depth needs 24-bit colour
 * gives its ground up on a 256-colour terminal rather than painting three
 * surfaces that quantise to the same flat block.
 */
async function resolveCliTheme(options: TaskWraithTuiCliOptions): Promise<TuiTheme> {
  const requested = resolveCliThemeName(options)
  let chosen: TuiTheme
  if (isAutoThemeName(requested)) {
    const probe = nodeAppearanceProbe()
    chosen = resolveAutoTheme(
      await resolveTuiAppearance({
        env: process.env,
        platform: process.platform,
        run: runForStdout,
        ...(probe ? { probe } : {})
      })
    )
  } else {
    chosen = resolveTuiTheme(requested)
  }
  return tuiThemeForColorMode(chosen, options.colorMode)
}

/**
 * Which theme this run was asked for: flag, then environment, then the saved
 * preference, then nothing — which downstream reads as "the default theme".
 *
 * The saved preference sits below the environment on purpose. `TASKWRAITH_TUI_THEME`
 * is how a script or a terminal profile states what it needs, and a preference
 * saved from an interactive session should not override the environment the
 * next session is launched into.
 */
function resolveCliThemeName(options: TaskWraithTuiCliOptions): string | undefined {
  return options.themeName ?? readTuiSettings().theme
}

/** Runs a probe command, treating any failure as "this source has no answer". */
function runForStdout(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 1000 })
  if (result.error || result.status !== 0) return undefined
  return result.stdout
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

function renderSnapshotState(
  state: TaskWraithTuiState,
  options: TaskWraithTuiCliOptions,
  theme: TuiTheme
): void {
  const output = renderTaskWraithTui(state, {
    width: options.width,
    height: options.height,
    ansi: new Ansi(options.colorMode),
    animationEnabled: options.animationEnabled,
    glyphs: resolveCliGlyphs(options),
    theme
  })
  process.stdout.write(`${output}\n`)
}

function printJsonProjection(
  state: TaskWraithTuiState,
  source: TaskWraithTuiJsonProjectionSource,
  manifest?: TwMissionManifest
): void {
  const projection = buildTaskWraithTuiJsonProjection(state, source, manifest)
  process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`)
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
  if (options.replayPath) {
    const replay = await loadReplay(options)
    if (options.json) printJsonProjection(replay.state, 'twmission-replay', replay.manifest)
    else renderSnapshotState(replay.state, options, await resolveCliTheme(options))
    return
  }
  const interactive = !options.exportPath && !options.json && !options.snapshot
  if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error(
      'Interactive mode requires a terminal. Use --snapshot, --json, --export, or --replay for redirected output.'
    )
  }
  if (!options.demo && options.startHost) {
    if (!options.userDataPath) throw new Error('TaskWraith Host userData path is unavailable.')
    await ensureTuiHostAvailable({
      userDataPath: options.userDataPath,
      profile: options.hostLaunchProfile
    })
  }
  if (options.exportPath) {
    await exportTwMission(options)
    return
  }
  if (options.json) {
    const state = options.demo ? createTaskWraithTuiDemoState() : await connectedSnapshot(options)
    printJsonProjection(state, options.demo ? 'demo' : 'host')
    return
  }
  if (options.snapshot) {
    const state = options.demo ? createTaskWraithTuiDemoState() : await connectedSnapshot(options)
    renderSnapshotState(state, options, await resolveCliTheme(options))
    return
  }
  activeTui = new TaskWraithTui({
    clientVersion: TUI_VERSION,
    demo: options.demo,
    colorMode: options.colorMode,
    animationEnabled: options.animationEnabled,
    glyphs: resolveCliGlyphs(options),
    theme: await resolveCliTheme(options),
    ...(resolveCliThemeName(options) ? { themeName: resolveCliThemeName(options) as string } : {}),
    persistTheme: (name: string) => writeTuiSettings({ theme: name }),
    ...(options.userDataPath
      ? {
          profileSettings: readTuiProfileSettings(options.userDataPath),
          persistProfileSettings: (changes) =>
            writeTuiProfileSettings(options.userDataPath as string, changes)
        }
      : {}),
    ...(options.threadId ? { initialThreadId: options.threadId } : {}),
    ...(options.userDataPath ? { userDataPath: options.userDataPath } : {}),
    ...(!options.demo && options.startHost && options.userDataPath
      ? {
          reviveHost: async () => {
            await ensureTuiHostAvailable({
              userDataPath: options.userDataPath as string,
              profile: options.hostLaunchProfile
            })
          }
        }
      : {})
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
