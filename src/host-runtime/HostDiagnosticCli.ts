import { isAbsolute, parse, resolve } from 'node:path'

export const HOST_DIAGNOSTIC_USAGE =
  'Usage: taskwraith-host serve --profile <absolute non-root path> --mode diagnostic [--parent-pid <pid>]'

export interface HostDiagnosticServeCommand {
  readonly command: 'serve'
  readonly profilePath: string
  readonly mode: 'diagnostic'
  readonly parentPid?: number
}

export class HostDiagnosticCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostDiagnosticCliError'
  }
}

export class HostDiagnosticModeUnavailableError extends HostDiagnosticCliError {
  constructor(mode: string) {
    super(`Host mode ${JSON.stringify(mode)} is unavailable; only diagnostic mode is implemented.`)
    this.name = 'HostDiagnosticModeUnavailableError'
  }
}

function requireOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new HostDiagnosticCliError(`${option} requires one value. ${HOST_DIAGNOSTIC_USAGE}`)
  }
  return value
}

function parseProfilePath(value: string): string {
  if (value.trim() !== value || value.includes('\u0000') || !isAbsolute(value)) {
    throw new HostDiagnosticCliError('--profile must be an absolute non-root path.')
  }
  const profilePath = resolve(value)
  if (profilePath === parse(profilePath).root) {
    throw new HostDiagnosticCliError('--profile must not be a filesystem root.')
  }
  return profilePath
}

function parseParentPid(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new HostDiagnosticCliError('--parent-pid must be a positive integer.')
  }
  const parentPid = Number(value)
  if (!Number.isSafeInteger(parentPid)) {
    throw new HostDiagnosticCliError('--parent-pid must be a safe positive integer.')
  }
  return parentPid
}

/** Strict parser for the intentionally narrow standalone diagnostic command. */
export function parseHostDiagnosticCli(argv: readonly string[]): HostDiagnosticServeCommand {
  if (argv[0] !== 'serve') {
    throw new HostDiagnosticCliError(HOST_DIAGNOSTIC_USAGE)
  }

  let profilePath: string | undefined
  let mode: string | undefined
  let parentPid: number | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]
    switch (option) {
      case '--profile':
        if (profilePath !== undefined)
          throw new HostDiagnosticCliError('--profile may appear once.')
        profilePath = parseProfilePath(requireOptionValue(argv, index, option))
        index += 1
        break
      case '--mode':
        if (mode !== undefined) throw new HostDiagnosticCliError('--mode may appear once.')
        mode = requireOptionValue(argv, index, option)
        index += 1
        break
      case '--parent-pid':
        if (parentPid !== undefined)
          throw new HostDiagnosticCliError('--parent-pid may appear once.')
        parentPid = parseParentPid(requireOptionValue(argv, index, option))
        index += 1
        break
      default:
        throw new HostDiagnosticCliError(
          `Unknown argument ${JSON.stringify(option)}. ${HOST_DIAGNOSTIC_USAGE}`
        )
    }
  }

  if (!profilePath || mode === undefined) {
    throw new HostDiagnosticCliError(HOST_DIAGNOSTIC_USAGE)
  }
  if (mode !== 'diagnostic') throw new HostDiagnosticModeUnavailableError(mode)
  return { command: 'serve', profilePath, mode, ...(parentPid ? { parentPid } : {}) }
}
