/**
 * The one persistent, authenticated desktop connection thread ownership is
 * negotiated on.
 *
 * A Host grant belongs to the socket it was given on, so claims cannot go
 * through the projection broker, which opens a connection per request. This
 * owns a dedicated desktop-class `HostProjectionClient` and tells the
 * negotiation client about every welcome and every disconnect, including the
 * deliberate close the transport itself does not report. It never reconnects
 * on its own: the next claim asks for a connection, so a lost socket only
 * costs a claim that is asked again later.
 */
import { HostProjectionClient } from '../../host-client/HostProjectionClient'
import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import type { ThreadOwnershipClient } from './ThreadOwnershipClient'

/** Its own id: a grant is bound to the socket, so it must never share the lease's. */
export const DESKTOP_THREAD_OWNER_CLIENT_ID = 'taskwraith-desktop-thread-owner'

export interface DesktopThreadOwnerTransport {
  readonly connected: boolean
  connect(): Promise<Pick<HostBootstrapWelcome, 'bootEpoch'>>
  close(): void
  on(event: 'welcome', listener: (welcome: HostBootstrapWelcome) => void): unknown
  on(event: 'disconnected', listener: (error?: Error) => void): unknown
}

export function createDesktopThreadOwnerClient(input: {
  readonly userDataPath: string
  readonly appVersion: string
}): HostProjectionClient {
  return new HostProjectionClient({
    userDataPath: input.userDataPath,
    client: {
      clientId: DESKTOP_THREAD_OWNER_CLIENT_ID,
      clientClass: 'desktop',
      clientVersion: input.appVersion
    },
    capabilities: ['bootstrap']
  })
}

export class DesktopThreadOwnerConnection {
  private connecting: Promise<boolean> | null = null
  private closed = false

  constructor(
    private readonly transport: DesktopThreadOwnerTransport,
    private readonly client: Pick<ThreadOwnershipClient, 'onWelcome' | 'onDisconnected'>,
    private readonly log: (line: string) => void = () => undefined
  ) {
    // The welcome event is the one place a socket's life begins, whether this
    // module asked for it or not; the client fences every reply on it.
    transport.on('welcome', (welcome) => this.client.onWelcome(welcome))
    transport.on('disconnected', () => this.client.onDisconnected())
  }

  /** True once a welcomed socket is open. One connect at a time; never after `close`. */
  ensureConnected(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    if (this.transport.connected) return Promise.resolve(true)
    if (!this.connecting) {
      this.connecting = this.transport
        .connect()
        .then(
          () => !this.closed && this.transport.connected,
          (error: unknown) => {
            this.log(`thread owner connection failed: ${describe(error)}`)
            return false
          }
        )
        .finally(() => {
          this.connecting = null
        })
    }
    return this.connecting
  }

  /** Every grant on the socket is void from here; the Host revokes them as it closes. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
    this.client.onDisconnected()
  }
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}
