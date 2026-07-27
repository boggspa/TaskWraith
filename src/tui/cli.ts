#!/usr/bin/env node

import { resolve } from 'node:path'
import type { TaskWraithControlSnapshot } from '../shared/taskWraithControlProtocol'
import { defaultTaskWraithDevUserDataPath } from '../shared/taskWraithControlPaths.node'
import { Ansi, detectAnsiColorMode, type AnsiColorMode } from './ansi'
import { TaskWraithTui } from './TaskWraithTui'
import { TaskWraithControlClient } from './client/TaskWraithControlClient'
import { renderTaskWraithTui } from './render'
import { createTaskWraithTuiDemoState, type TaskWraithTuiState } from './state'
import { detectTuiUnicode, resolveTuiGlyphs, type TuiGlyphSet } from './theme'

const TUI_VERSION = '0.1.0'

interface CliOptions {
  demo: boolean
  dev: boolean
  snapshot: boolean
  width: number
  height: number
  colorMode: AnsiColorMode
  animationEnabled: boolean
  /** Force ASCII chrome; also set by TASKWRAITH_TUI_ASCII=1 via detectTuiUnicode. */
  ascii: boolean
  threadId?: string
  userDataPath?: string
  help: boolean
  version: boolean
}

function usage(): string {
  return `TaskWraith TUI ${TUI_VERSION}

Usage:
  taskwraith [options]
  tw [options]

Options:
  --demo                 Run the self-contained presentation demo
  --dev                  Connect to TaskWraith Dev (honours TASKWRAITH_INSTANCE_ID)
  --snapshot             Render one frame and exit
  --width <columns>      Snapshot width (default: terminal or 80)
  --height <rows>        Snapshot height (default: terminal or 24)
  --thread <id>          Open a specific TaskWraith thread
  --user-data <path>     Override Electron's TaskWraith userData directory
  --no-color             Disable ANSI colour
  --color <mode>         truecolor, ansi256, or none
  --ascii                Force ASCII chrome (also: TASKWRAITH_TUI_ASCII=1)
  --no-animation         Use the static working indicator
  --version              Print the TUI version
  --help                 Show this help

Interactive keys:
  Ctrl+O context  Ctrl+K threads  Ctrl+P commands  PgUp/PgDn scroll
  Enter send      Ctrl+C clear/quit               /cancel active run

The normal sidecar connects to a running TaskWraith Electron host. Nothing in
the TUI reads provider credentials or the AppStore directly.`
}

function positiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} expects a positive integer.`)
  }
  return value
}

function colorMode(raw: string | undefined): AnsiColorMode {
  if (raw === 'truecolor' || raw === 'ansi256' || raw === 'none') return raw
  throw new Error('--color expects truecolor, ansi256, or none.')
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} expects a value.`)
  return [value, index + 1]
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    demo: false,
    dev: false,
    snapshot: false,
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
    colorMode: detectAnsiColorMode(),
    animationEnabled: true,
    ascii: false,
    help: false,
    version: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const [flag, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined]
    if (flag === '--demo') options.demo = true
    else if (flag === '--dev') options.dev = true
    else if (flag === '--snapshot') options.snapshot = true
    else if (flag === '--no-color') options.colorMode = 'none'
    else if (flag === '--ascii') options.ascii = true
    else if (flag === '--no-animation') options.animationEnabled = false
    else if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--version' || flag === '-v') options.version = true
    else if (flag === '--width') {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, '--width')
      options.width = positiveInteger(value, '--width')
      index = consumed
    } else if (flag === '--height') {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, '--height')
      options.height = positiveInteger(value, '--height')
      index = consumed
    } else if (flag === '--color') {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, '--color')
      options.colorMode = colorMode(value)
      index = consumed
    } else if (flag === '--thread') {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, '--thread')
      options.threadId = value
      index = consumed
    } else if (flag === '--user-data') {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, '--user-data')
      options.userDataPath = resolve(value)
      index = consumed
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }
  if (options.dev && !options.userDataPath) {
    options.userDataPath = defaultTaskWraithDevUserDataPath()
  }
  return options
}

function pickThread(snapshot: TaskWraithControlSnapshot, threadId?: string): string | undefined {
  if (threadId && snapshot.threads.some((thread) => thread.id === threadId)) return threadId
  return [...snapshot.threads]
    .filter((thread) => !thread.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id
}

function resolveCliGlyphs(options: CliOptions): TuiGlyphSet {
  return resolveTuiGlyphs(options.ascii ? false : detectTuiUnicode())
}

async function connectedSnapshot(options: CliOptions): Promise<TaskWraithTuiState> {
  const client = new TaskWraithControlClient({
    clientVersion: TUI_VERSION,
    ...(options.userDataPath ? { userDataPath: options.userDataPath } : {})
  })
  try {
    const welcome = await client.connect()
    const snapshot = await client.getSnapshot()
    const threadId = pickThread(snapshot, options.threadId)
    const thread = threadId ? await client.selectThread(threadId) : undefined
    return {
      connection: 'connected',
      hostVersion: welcome.hostVersion,
      snapshot,
      ...(thread ? { thread, selectedThreadId: thread.thread.id } : {}),
      input: '',
      inputCursor: 0,
      overlay: 'none',
      overlayIndex: 0,
      scrollOffset: 0,
      animationFrame: 0
    }
  } finally {
    client.close()
  }
}

async function renderSnapshot(options: CliOptions): Promise<void> {
  const state = options.demo ? createTaskWraithTuiDemoState() : await connectedSnapshot(options)
  const output = renderTaskWraithTui(state, {
    width: options.width,
    height: options.height,
    ansi: new Ansi(options.colorMode),
    animationEnabled: options.animationEnabled,
    glyphs: resolveCliGlyphs(options)
  })
  process.stdout.write(`${output}\n`)
}

let activeTui: TaskWraithTui | null = null

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (options.version) {
    process.stdout.write(`${TUI_VERSION}\n`)
    return
  }
  if (options.snapshot) {
    await renderSnapshot(options)
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Interactive mode requires a terminal. Use --snapshot (or --demo --snapshot) for redirected output.'
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
// still restore raw mode / the alternate screen before the process ends, or
// the user's shell is left broken after the sidecar crashes.
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
// Synchronous last-resort restoration: `stop()` is idempotent, so this is a
// no-op whenever an earlier handler already restored the terminal.
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
