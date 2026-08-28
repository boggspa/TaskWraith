import { spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import {
  HostGitReadService,
  type HostGitFsPort,
  type HostGitSpawnPort,
  type HostGitSpawnResult
} from '../host-shared/git/HostGitReadService'
import {
  HOST_GIT_SAFE_CONFIG_OVERRIDES,
  hostGitEnvironment
} from '../host-shared/git/HostGitSecurity'
import { loadOrCreateHostServerIdentity } from '../host-runtime/HostServerIdentity'
import {
  HostNodeMuseAuthHandoff,
  type HostNodeMuseTerminalLauncher
} from './HostNodeMuseAuthHandoff'
import { hostNodeMuseOffers } from './HostNodeMuseCatalog'
import { createHostNodeMuseResources } from './HostNodeMuseResources'
import { createHostNodeMuseProviderFactory } from './HostNodeMuseProvider'
import type { HostNodeTerminalLauncher } from './HostNodeTerminalLauncher'
import { createHostNodeClaudeProviderFactory } from './HostNodeClaudeProvider'
import { createHostNodeCodexProvider } from './HostNodeCodexProvider'
import { createHostNodeKimiProvider } from './HostNodeKimiProvider'
import { createHostNodeGrokProvider } from './HostNodeGrokProvider'
import { createHostNodeMistralProvider } from './HostNodeMistralProvider'
import { createHostNodeOllamaProviderFactory } from './HostNodeOllamaProvider'
import { createHostNodePiProviderFactory } from './HostNodePiProvider'
import { createHostNodeCursorProviderFactory } from './HostNodeCursorProvider'
import { HostNodeProductionServer } from './HostNodeProductionServer'

export interface HostNodeProductionFactoryOptions {
  readonly profilePath: string
  readonly museBinary?: string
  readonly gitExecutable?: string
  readonly env?: NodeJS.ProcessEnv
  readonly temporaryParent?: string
  readonly terminalLauncher?: HostNodeMuseTerminalLauncher
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; overflow: boolean },
  limit: number
): void {
  const remaining = Math.max(0, limit - state.bytes)
  if (chunk.byteLength > remaining) state.overflow = true
  if (remaining > 0) {
    const slice = chunk.subarray(0, remaining)
    chunks.push(slice)
    state.bytes += slice.byteLength
  }
}

function nodeHostGitSpawnPort(): HostGitSpawnPort {
  return {
    run: (input) =>
      new Promise<HostGitSpawnResult>((resolve) => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const stdoutState = { bytes: 0, overflow: false }
        const stderrState = { bytes: 0, overflow: false }
        const limit = input.maxBytes + 4
        let timedOut = false
        let settled = false
        const child = spawn(input.command, [...input.args], {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, input.timeoutMs)
        timer.unref?.()
        child.stdout?.on('data', (chunk: Buffer) =>
          appendBounded(stdout, chunk, stdoutState, limit)
        )
        child.stderr?.on('data', (chunk: Buffer) =>
          appendBounded(stderr, chunk, stderrState, limit)
        )
        const finish = (status: number | null, launchError?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const subcommand = input.args[HOST_GIT_SAFE_CONFIG_OVERRIDES.length]
          const truncatable = subcommand === 'diff' || subcommand === 'log'
          const overflowRefused = stderrState.overflow || (stdoutState.overflow && !truncatable)
          resolve({
            status: overflowRefused ? 1 : status,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: launchError
              ? launchError.message
              : overflowRefused
                ? 'git output exceeded the bounded read budget'
                : Buffer.concat(stderr).toString('utf8'),
            ...(timedOut ? { timedOut: true } : {})
          })
        }
        child.once('error', (error) => finish(null, error))
        child.once('close', (code) => finish(code))
      })
  }
}

function nodeHostGitFsPort(): HostGitFsPort {
  return {
    realpath: (path) => realpathSync.native(path),
    inspectGitMarker: (repositoryRoot) => {
      try {
        const stat = lstatSync(join(repositoryRoot, '.git'))
        return {
          exists: true,
          kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file'
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { exists: false, kind: 'dir' }
        }
        throw error
      }
    }
  }
}

function providerTerminalLauncher(
  launcher: HostNodeMuseTerminalLauncher | undefined
): Pick<HostNodeTerminalLauncher, 'launchForProvider'> | undefined {
  return launcher &&
    typeof (launcher as Partial<HostNodeTerminalLauncher>).launchForProvider === 'function'
    ? (launcher as unknown as Pick<HostNodeTerminalLauncher, 'launchForProvider'>)
    : undefined
}

/** Assemble the real pure-Node provider resources only after lifecycle lease acquisition. */
export function createHostNodeProductionServer(
  options: HostNodeProductionFactoryOptions
): HostNodeProductionServer {
  return new HostNodeProductionServer({
    profilePath: options.profilePath,
    mode: 'production',
    resolveIdentity: (profilePath, lease) =>
      loadOrCreateHostServerIdentity({
        profilePath,
        authority: { assertHeld: () => lease.assertHeld() }
      }),
    createDomainResources: async ({ profilePath }) => {
      const resources = createHostNodeMuseResources({
        executablePath: options.museBinary,
        ...(options.env ? { env: options.env } : {}),
        ...(options.temporaryParent ? { temporaryParent: options.temporaryParent } : {})
      })
      try {
        const binary = await resources.resolveBinary()
        const available = binary.binaryPath !== null
        const gitExecutable = options.gitExecutable ?? 'git'
        const gitSpawn = nodeHostGitSpawnPort()
        const gitEnvironment = hostGitEnvironment(options.env ?? process.env)
        const gitProbe = await gitSpawn.run({
          command: gitExecutable,
          args: ['--version'],
          cwd: profilePath,
          env: gitEnvironment,
          timeoutMs: 2_000,
          maxBytes: 4_096
        })
        const gitReadService =
          gitProbe.status === 0 && !gitProbe.timedOut
            ? new HostGitReadService({
                spawn: gitSpawn,
                fs: nodeHostGitFsPort(),
                gitExecutable,
                env: options.env ?? process.env
              })
            : undefined
        const handoff =
          binary.binaryPath && options.terminalLauncher
            ? new HostNodeMuseAuthHandoff(binary.binaryPath, options.terminalLauncher)
            : undefined
        const launcher = providerTerminalLauncher(options.terminalLauncher)
        return {
          domainOptions: {
            ...(gitReadService ? { gitReadService } : {}),
            providers: [
              createHostNodeMuseProviderFactory({
                offers: hostNodeMuseOffers(available),
                resources,
                ...(handoff ? { manualAuthHandoff: handoff } : {})
              }),
              createHostNodeClaudeProviderFactory({
                ...(launcher ? { terminalLauncher: launcher } : {})
              }),
              createHostNodeCodexProvider({
                ...(launcher ? { terminalLauncher: launcher } : {})
              }),
              createHostNodeKimiProvider({
                ...(launcher ? { terminalLauncher: launcher } : {})
              }),
              createHostNodeGrokProvider({
                ...(launcher ? { terminalLauncher: launcher } : {})
              }),
              createHostNodeMistralProvider({
                ...(launcher ? { terminalLauncher: launcher } : {})
              }),
              createHostNodeOllamaProviderFactory(),
              createHostNodePiProviderFactory(),
              createHostNodeCursorProviderFactory({
                ...(launcher ? { terminalLauncher: launcher } : {})
              })
            ],
            health: () => ({
              hostStatus: available ? ('ok' as const) : ('degraded' as const),
              connectionPhase: 'live' as const,
              supervised: false,
              freshness: 'live' as const
            })
          },
          dispose: () => resources.dispose()
        }
      } catch (error) {
        resources.dispose()
        throw error
      }
    }
  })
}

/** Backward-compatible factory alias. */
export const createHostNodeProductionFactory = createHostNodeProductionServer
