import { isAbsolute, parse, resolve } from 'node:path'

export const HOST_PRODUCTION_USAGE = [
  'Usage: taskwraith-host serve --profile <absolute canonical non-root path> --mode production [--muse-binary <absolute canonical path>]',
  '       taskwraith-host stop --profile <absolute canonical non-root path>',
  '       taskwraith-host status [--profile <absolute canonical non-root path>] [--scan-argv] [--json]',
  '       taskwraith-host stop-all [--all | --profile <absolute canonical non-root path> | --payload-root <absolute canonical non-root path>] [--scan-argv] [--sweep] [--json]',
  '       stop-all --profile also accepts the paired --expect-pid <positive integer> --expect-birth <64-hex digest>.'
].join('\n')

export interface HostProductionServeCommand {
  readonly command: 'serve'
  readonly profilePath: string
  readonly mode: 'production'
  readonly museBinary?: string
}

export interface HostProductionStopCommand {
  readonly command: 'stop'
  readonly profilePath: string
}

/** Lists the machine-wide Host registry; `--profile` narrows the listing to one profile. */
export interface HostProductionStatusCommand {
  readonly command: 'status'
  readonly profilePath?: string
  readonly scanArgv: boolean
  readonly json: boolean
}

/**
 * What `stop-all` may stop. No scope lists only (exit 3); the three scopes are
 * mutually exclusive so a typo can never widen `--profile` into `--all`, and
 * `--sweep` (a mutation) needs one of them: a listing changes nothing.
 */
export type HostProductionStopAllScope =
  | { readonly kind: 'list' }
  | { readonly kind: 'all' }
  | { readonly kind: 'profile'; readonly profilePath: string }
  | { readonly kind: 'payload-root'; readonly payloadRoot: string }

export interface HostProductionStopAllCommand {
  readonly command: 'stop-all'
  readonly scope: HostProductionStopAllScope
  readonly expected?: { readonly pid: number; readonly birthIdentity: string }
  readonly scanArgv: boolean
  readonly sweep: boolean
  readonly json: boolean
}

export type HostProductionCommand =
  | HostProductionServeCommand
  | HostProductionStopCommand
  | HostProductionStatusCommand
  | HostProductionStopAllCommand

export class HostProductionCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostProductionCliError'
  }
}

function value(argv: readonly string[], index: number, option: string): string {
  const result = argv[index + 1]
  if (!result || result.startsWith('--'))
    throw new HostProductionCliError(`${option} requires one value. ${HOST_PRODUCTION_USAGE}`)
  return result
}

function canonicalPath(value_: string, option: string, forbidRoot: boolean): string {
  if (
    value_.trim() !== value_ ||
    [...value_].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    }) ||
    !isAbsolute(value_)
  )
    throw new HostProductionCliError(`${option} must be an absolute canonical path.`)
  const result = resolve(value_)
  if (result !== value_ || (forbidRoot && result === parse(result).root))
    throw new HostProductionCliError(`${option} must be an absolute canonical non-root path.`)
  return result
}

function parseRegistryCommand(
  command: 'status' | 'stop-all',
  argv: readonly string[]
): HostProductionStatusCommand | HostProductionStopAllCommand {
  let profilePath: string | undefined
  let payloadRoot: string | undefined
  let expectedPid: number | undefined
  let expectedBirth: string | undefined
  let all = false
  let scanArgv = false
  let sweep = false
  let json = false
  const once = (seen: boolean, option: string): void => {
    if (seen) throw new HostProductionCliError(`${option} may appear once.`)
  }
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--profile') {
      once(profilePath !== undefined, option)
      profilePath = canonicalPath(value(argv, index, option), option, true)
      index += 1
    } else if (option === '--payload-root' && command === 'stop-all') {
      once(payloadRoot !== undefined, option)
      payloadRoot = canonicalPath(value(argv, index, option), option, true)
      index += 1
    } else if (option === '--all' && command === 'stop-all') {
      once(all, option)
      all = true
    } else if (option === '--expect-pid' && command === 'stop-all') {
      once(expectedPid !== undefined, option)
      const raw = value(argv, index, option)
      expectedPid = Number(raw)
      if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0 || String(expectedPid) !== raw)
        throw new HostProductionCliError('--expect-pid must be a positive safe integer.')
      index += 1
    } else if (option === '--expect-birth' && command === 'stop-all') {
      once(expectedBirth !== undefined, option)
      const raw = value(argv, index, option)
      if (raw.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(raw))
        throw new HostProductionCliError(
          '--expect-birth must be exactly 64 hexadecimal characters.'
        )
      expectedBirth = raw.toLowerCase()
      index += 1
    } else if (option === '--sweep' && command === 'stop-all') {
      once(sweep, option)
      sweep = true
    } else if (option === '--scan-argv') {
      once(scanArgv, option)
      scanArgv = true
    } else if (option === '--json') {
      once(json, option)
      json = true
    } else if (option === '--parent-pid') {
      throw new HostProductionCliError('--parent-pid is unavailable in production mode.')
    } else if (option === '--mode' || option === '--muse-binary') {
      throw new HostProductionCliError(`${option} is unavailable for ${command}.`)
    } else
      throw new HostProductionCliError(
        `Unknown argument ${JSON.stringify(option)}. ${HOST_PRODUCTION_USAGE}`
      )
  }
  if (command === 'status') {
    return { command, ...(profilePath ? { profilePath } : {}), scanArgv, json }
  }
  const scopes = [all, profilePath !== undefined, payloadRoot !== undefined].filter(Boolean)
  if (scopes.length > 1)
    throw new HostProductionCliError('--all, --profile and --payload-root are mutually exclusive.')
  const scope: HostProductionStopAllScope = all
    ? { kind: 'all' }
    : profilePath
      ? { kind: 'profile', profilePath }
      : payloadRoot
        ? { kind: 'payload-root', payloadRoot }
        : { kind: 'list' }
  if ((expectedPid === undefined) !== (expectedBirth === undefined))
    throw new HostProductionCliError('--expect-pid and --expect-birth must be supplied together.')
  if (expectedPid !== undefined && scope.kind !== 'profile')
    throw new HostProductionCliError('--expect-pid and --expect-birth require --profile.')
  if (sweep && scope.kind === 'list')
    throw new HostProductionCliError(
      '--sweep needs a scope: --all, --profile <path> or --payload-root <dir>.'
    )
  return {
    command,
    scope,
    ...(expectedPid !== undefined && expectedBirth !== undefined
      ? { expected: { pid: expectedPid, birthIdentity: expectedBirth } }
      : {}),
    scanArgv,
    sweep,
    json
  }
}

export function parseHostProductionCli(argv: readonly string[]): HostProductionCommand {
  if (argv[0] === 'status' || argv[0] === 'stop-all') return parseRegistryCommand(argv[0], argv)
  if (argv[0] !== 'serve' && argv[0] !== 'stop')
    throw new HostProductionCliError(HOST_PRODUCTION_USAGE)
  const command = argv[0]
  let profilePath: string | undefined
  let mode: string | undefined
  let museBinary: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--profile') {
      if (profilePath) throw new HostProductionCliError('--profile may appear once.')
      profilePath = canonicalPath(value(argv, index, option), option, true)
      index += 1
    } else if (option === '--mode') {
      if (command === 'stop') throw new HostProductionCliError('--mode is unavailable for stop.')
      if (mode !== undefined) throw new HostProductionCliError('--mode may appear once.')
      mode = value(argv, index, option)
      index += 1
    } else if (option === '--muse-binary') {
      if (command === 'stop')
        throw new HostProductionCliError('--muse-binary is unavailable for stop.')
      if (museBinary) throw new HostProductionCliError('--muse-binary may appear once.')
      museBinary = canonicalPath(value(argv, index, option), option, true)
      index += 1
    } else if (option === '--parent-pid') {
      throw new HostProductionCliError('--parent-pid is unavailable in production mode.')
    } else
      throw new HostProductionCliError(
        `Unknown argument ${JSON.stringify(option)}. ${HOST_PRODUCTION_USAGE}`
      )
  }
  if (!profilePath) throw new HostProductionCliError(HOST_PRODUCTION_USAGE)
  if (command === 'stop') return { command: 'stop', profilePath }
  if (mode !== 'production') throw new HostProductionCliError(HOST_PRODUCTION_USAGE)
  return {
    command: 'serve',
    profilePath,
    mode: 'production',
    ...(museBinary ? { museBinary } : {})
  }
}
