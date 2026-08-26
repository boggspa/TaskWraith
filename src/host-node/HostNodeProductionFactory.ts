import { loadOrCreateHostServerIdentity } from '../host-runtime/HostServerIdentity'
import {
  HostNodeMuseAuthHandoff,
  type HostNodeMuseTerminalLauncher
} from './HostNodeMuseAuthHandoff'
import { hostNodeMuseOffers } from './HostNodeMuseCatalog'
import { createHostNodeMuseResources } from './HostNodeMuseResources'
import { createHostNodeMuseProviderFactory } from './HostNodeMuseProvider'
import { HostNodeProductionServer } from './HostNodeProductionServer'

export interface HostNodeProductionFactoryOptions {
  readonly profilePath: string
  readonly museBinary?: string
  readonly env?: NodeJS.ProcessEnv
  readonly temporaryParent?: string
  readonly terminalLauncher?: HostNodeMuseTerminalLauncher
}

/** Assemble the real pure-Node Muse resources only after lifecycle lease acquisition. */
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
    createDomainResources: async () => {
      const resources = createHostNodeMuseResources({
        executablePath: options.museBinary,
        ...(options.env ? { env: options.env } : {}),
        ...(options.temporaryParent ? { temporaryParent: options.temporaryParent } : {})
      })
      try {
        const binary = await resources.resolveBinary()
        const available = binary.binaryPath !== null
        const handoff =
          binary.binaryPath && options.terminalLauncher
            ? new HostNodeMuseAuthHandoff(binary.binaryPath, options.terminalLauncher)
            : undefined
        return {
          domainOptions: {
            providers: [
              createHostNodeMuseProviderFactory({
                offers: hostNodeMuseOffers(available),
                resources,
                ...(handoff ? { manualAuthHandoff: handoff } : {})
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
