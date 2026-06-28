import { GEMINI_MCP_BRIDGE_ARG_SUFFIX, GEMINI_MCP_BRIDGE_ENV } from './geminiMcpConstants'

export function isTaskWraithHelperProcess(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return argv.some((arg) => arg.endsWith(GEMINI_MCP_BRIDGE_ARG_SUFFIX)) || env[GEMINI_MCP_BRIDGE_ENV] === '1'
}

export function shouldSuppressMacAppPresentation(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'darwin' && isTaskWraithHelperProcess(argv, env)
}
