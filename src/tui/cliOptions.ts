import { resolve } from 'node:path'

import {
  defaultTaskWraithDevUserDataPath,
  defaultTaskWraithUserDataPath
} from '../shared/taskWraithControlPaths.node'
import { detectAnsiColorMode, type AnsiColorMode } from './ansi'
import type { TuiHostLaunchProfile } from './hostProcessManager'

export interface TaskWraithTuiCliOptions {
  demo: boolean
  dev: boolean
  snapshot: boolean
  json: boolean
  force: boolean
  width: number
  height: number
  colorMode: AnsiColorMode
  animationEnabled: boolean
  startHost: boolean
  hostLaunchProfile: TuiHostLaunchProfile
  /** Force ASCII chrome; TASKWRAITH_TUI_ASCII is handled by detectTuiUnicode. */
  ascii: boolean
  threadId?: string
  userDataPath?: string
  exportPath?: string
  replayPath?: string
  help: boolean
  version: boolean
}

export function taskWraithTuiUsage(version: string): string {
  return `TaskWraith TUI ${version}

Usage:
  taskwraith [options]
  tw [options]

Options:
  --demo                 Run the self-contained presentation demo
  --dev                  Connect to TaskWraith Dev (honours TASKWRAITH_INSTANCE_ID)
  --snapshot             Render one terminal frame and exit
  --json                 Print the coherent Host projection as JSON and exit
  --export <file>        Write an integrity-checked .twmission flight recorder
  --replay <file>        Render a detached .twmission replay (never mutates Host)
  --force                Allow --export to replace an existing file
  --width <columns>      Snapshot/replay width (default: terminal or 80)
  --height <rows>        Snapshot/replay height (default: terminal or 24)
  --thread <id>          Open a specific TaskWraith thread
  --user-data <path>     Override Electron's TaskWraith userData directory
  --no-start-host        Connect only; do not start the app Host when offline
  --no-color             Disable ANSI colour
  --color <mode>         truecolor, ansi256, or none
  --ascii                Force ASCII chrome (also: TASKWRAITH_TUI_ASCII=1)
  --no-animation         Use the static working indicator
  --version              Print the TUI version
  --help                 Show this help

Interactive keys:
  Ctrl+O context  Ctrl+K threads  Ctrl+R missions  Ctrl+P commands
  PgUp/PgDn scroll  Enter send/open  Ctrl+C clear/quit  /cancel active run
  y/n             Answer a pending Host approval ask

The normal sidecar connects to the authenticated TaskWraith Host v2 socket.
Snapshots, ordered deltas, commands, receipts and .twmission export use that
same connection. Imported .twmission files are detached replay projections:
they cannot issue commands or write live Host state.`
}

function positiveInteger(raw: string | undefined, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} expects a positive integer.`)
  }
  return value
}

function parseColorMode(raw: string | undefined): AnsiColorMode {
  if (raw === 'truecolor' || raw === 'ansi256' || raw === 'none') return raw
  throw new Error('--color expects truecolor, ansi256, or none.')
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} expects a value.`)
  return [value, index + 1]
}

export function parseTaskWraithTuiArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): TaskWraithTuiCliOptions {
  const options: TaskWraithTuiCliOptions = {
    demo: false,
    dev: false,
    snapshot: false,
    json: false,
    force: false,
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
    colorMode: detectAnsiColorMode(),
    animationEnabled: true,
    startHost: true,
    hostLaunchProfile: 'production',
    ascii: false,
    help: false,
    version: false
  }
  let explicitUserData = Boolean(String(env.TASKWRAITH_USER_DATA || '').trim())
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const [flag, inline] = argument.includes('=')
      ? [argument.slice(0, argument.indexOf('=')), argument.slice(argument.indexOf('=') + 1)]
      : [argument, undefined]
    if (flag === '--demo') options.demo = true
    else if (flag === '--dev') options.dev = true
    else if (flag === '--snapshot') options.snapshot = true
    else if (flag === '--json') options.json = true
    else if (flag === '--force') options.force = true
    else if (flag === '--no-color') options.colorMode = 'none'
    else if (flag === '--ascii') options.ascii = true
    else if (flag === '--no-animation') options.animationEnabled = false
    else if (flag === '--no-start-host') options.startHost = false
    else if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--version' || flag === '-v') options.version = true
    else if (flag === '--width' || flag === '--height') {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, flag)
      options[flag === '--width' ? 'width' : 'height'] = positiveInteger(value, flag)
      index = consumed
    } else if (flag === '--color') {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, '--color')
      options.colorMode = parseColorMode(value)
      index = consumed
    } else if (
      flag === '--thread' ||
      flag === '--user-data' ||
      flag === '--export' ||
      flag === '--replay'
    ) {
      const [value, consumed] = inline ? [inline, index] : takeValue(args, index, flag)
      if (flag === '--thread') options.threadId = value
      else if (flag === '--user-data') {
        options.userDataPath = resolve(value)
        explicitUserData = true
      } else if (flag === '--export') options.exportPath = resolve(value)
      else options.replayPath = resolve(value)
      index = consumed
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }

  if (options.dev && !options.userDataPath) {
    options.userDataPath = defaultTaskWraithDevUserDataPath(process.platform, env)
  }
  if (!options.userDataPath)
    options.userDataPath = defaultTaskWraithUserDataPath(process.platform, env)
  const packageSmoke = env.TASKWRAITH_TUI_PACKAGE_SMOKE === '1'
  options.hostLaunchProfile =
    packageSmoke && explicitUserData
      ? 'package-smoke'
      : explicitUserData
        ? 'custom'
        : options.dev
          ? 'development'
          : 'production'
  if (options.json && options.snapshot) {
    throw new Error('--json and --snapshot select different output formats.')
  }
  if (options.exportPath && options.replayPath) {
    throw new Error('--export and --replay cannot be combined.')
  }
  if (
    options.exportPath &&
    (options.demo || options.snapshot || options.json || options.threadId)
  ) {
    throw new Error('--export cannot be combined with --demo, --snapshot, --json, or --thread.')
  }
  if (options.replayPath && (options.demo || options.dev)) {
    throw new Error('--replay cannot be combined with --demo or --dev.')
  }
  if (options.force && !options.exportPath) {
    throw new Error('--force is only valid with --export.')
  }
  return options
}
