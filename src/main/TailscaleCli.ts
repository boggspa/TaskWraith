import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TailscaleCliOutput {
  stdout: string
  stderr: string
}

interface TailscaleCliExecOptions {
  timeout: number
  env: NodeJS.ProcessEnv
}

type TailscaleCliProcessExec = (
  command: string,
  args: string[],
  options: TailscaleCliExecOptions
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>

const defaultProcessExec: TailscaleCliProcessExec = async (command, args, options) => {
  const result = await execFileAsync(command, args, options)
  return { stdout: result.stdout, stderr: result.stderr }
}

/**
 * The macOS Tailscale app and CLI are the same executable. When it is launched
 * from Finder/a login item there may be no terminal-shaped environment, so the
 * binary can choose GUI mode instead of executing the requested command. The
 * documented TAILSCALE_BE_CLI override makes every TaskWraith invocation
 * deterministic without depending on how TaskWraith itself was launched.
 */
export function tailscaleCliEnvironment(
  processEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...processEnv, TAILSCALE_BE_CLI: '1' }
}

export async function execTailscaleCli(
  command: string,
  args: string[],
  options: {
    timeoutMs: number
    processEnv?: NodeJS.ProcessEnv
    processExec?: TailscaleCliProcessExec
  }
): Promise<TailscaleCliOutput> {
  const run = options.processExec ?? defaultProcessExec
  const result = await run(command, args, {
    timeout: options.timeoutMs,
    env: tailscaleCliEnvironment(options.processEnv)
  })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}
