import { isAbsolute, parse, resolve } from 'node:path'

export const HOST_PRODUCTION_USAGE =
  'Usage: taskwraith-host serve --profile <absolute canonical non-root path> --mode production [--muse-binary <absolute canonical path>]'

export interface HostProductionServeCommand {
  readonly command: 'serve'
  readonly profilePath: string
  readonly mode: 'production'
  readonly museBinary?: string
}

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

export function parseHostProductionCli(argv: readonly string[]): HostProductionServeCommand {
  if (argv[0] !== 'serve') throw new HostProductionCliError(HOST_PRODUCTION_USAGE)
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
      if (mode !== undefined) throw new HostProductionCliError('--mode may appear once.')
      mode = value(argv, index, option)
      index += 1
    } else if (option === '--muse-binary') {
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
  if (!profilePath || mode !== 'production') throw new HostProductionCliError(HOST_PRODUCTION_USAGE)
  return {
    command: 'serve',
    profilePath,
    mode: 'production',
    ...(museBinary ? { museBinary } : {})
  }
}
