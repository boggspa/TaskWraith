import { createThreadCatalogueUiPublisher } from './ThreadCatalogueUiPublisher'
import { app } from 'electron'
import { createDesktopThreadCatalogue } from '../ThreadCatalogueWorker'
import { currentEnsembleRuntimeInstanceId } from '../EnsembleRuntimeIdentity'
import { AppStore } from '../store'
import {
  ThreadCatalogueMirror,
  catalogueChatListItem,
  type ThreadCatalogueReadPort
} from '../store/ThreadCatalogueMirror'
import type { HostProjectionBroker } from '../host/HostProjectionBroker'
import { ThreadCatalogueRecoveryController } from '../store/ThreadCatalogueRecoveryController'
import {
  createCatalogueErasureCallbacks,
  type CatalogueErasureJoins
} from './ThreadCatalogueErasureCallbacks'
import { installThreadOwnership } from './installThreadOwnership'
import { withThreadCatalogueReadContext } from '../store/ThreadCatalogueReadContextPort'
import type { HostProfileAuthorityPort } from '../../host-runtime/HostProfileDomainStore'
import type {
  ThreadCatalogueReadQuery,
  ThreadCatalogueMaintenanceQuery,
  ThreadCatalogueRequestOptions,
  ThreadCatalogueWireReply
} from '../../shared/threadCatalogueProtocol'

export function createHostThreadCatalogueTransport(
  broker: HostProjectionBroker
): ThreadCatalogueReadPort {
  return {
    query: async <T>(
      query: ThreadCatalogueReadQuery,
      requestOptions?: { priority?: 'foreground' | 'background' }
    ): Promise<T> => {
      if (!broker.queryThreadCatalogue) throw new Error('Host history catalogue is unavailable')
      return broker.queryThreadCatalogue<T>(query, requestOptions)
    }
  }
}

export function installStartupThreadCatalogue(options: {
  quiesceRecovery?(): Promise<void>
  resumeRecovery?(): void
  /** Ownership-side writers erasure must join; absent until ownership activation is composed. */
  erasureJoins?: CatalogueErasureJoins
  externalHost: boolean
  profileAuthority?: HostProfileAuthorityPort
  broker: HostProjectionBroker
  onInventoryChanged?(): void
  onChat: (chat: ReturnType<typeof catalogueChatListItem>) => void
}): {
  launchAt: number
  ready: Promise<void>
  mirror: ThreadCatalogueMirror
  provider: (
    query: ThreadCatalogueReadQuery,
    options?: ThreadCatalogueRequestOptions
  ) => Promise<ThreadCatalogueWireReply>
  dispose(): Promise<void>
  maintain<T = unknown>(query: ThreadCatalogueMaintenanceQuery): Promise<T>
  setMutationGuard(chatId: string, guard: () => boolean): () => void
} {
  const launchAt = Date.now()
  // Wire the I7 thread-ownership activation: receipt store, save-intent
  // port, and erasure joins. The full activation coordinator is a
  // placeholder; a real `HostThreadOwnerRegistry` is the follow-up that
  // bridges `recovery.begin` to `activate(chatId)`.
  const ownership = installThreadOwnership({
    saveIntentQueue: AppStore.getSaveIntentQueue()
  })
  AppStore.installThreadOwnershipSavePort(ownership.port)
  void ownership.loadEvidence()
  const local = options.externalHost
    ? null
    : createDesktopThreadCatalogue(
        app.getPath('userData'),
        currentEnsembleRuntimeInstanceId(),
        AppStore.getSettings().activeProvider
      )
  const transport: ThreadCatalogueReadPort =
    local ?? createHostThreadCatalogueTransport(options.broker)
  // Forwards the request lane as well as the read context. It used to take one
  // parameter, which silently ate the recovery drain's `background` and left
  // the whole priority lane inert in production; see the extracted wrapper.
  const port: ThreadCatalogueReadPort = withThreadCatalogueReadContext(transport, () => ({
    runtimeInstanceId: currentEnsembleRuntimeInstanceId(),
    defaultProvider: AppStore.getSettings().activeProvider
  }))
  const mirror = new ThreadCatalogueMirror(port)
  const guards = new Map<string, () => boolean>()
  let recovery: ThreadCatalogueRecoveryController | null = null
  const maintain = async <T>(query: ThreadCatalogueMaintenanceQuery): Promise<T> => {
    if (local) {
      if (query.method === 'owner') recovery?.registerDesktop(query.owner)
      if (query.method === 'begin-recovery')
        return recovery!.begin(query.chatId, query.desktopWriterId) as T
      if (query.method === 'end-recovery')
        return recovery!.end(query.chatId, query.recoveryToken) as T
      if (query.method === 'adopt-prepared')
        return recovery!.adopt(query.chatId, query.recoveryToken, query.preparedId) as Promise<T>
      if (query.method === 'prepare' || query.method === 'fold-owned-log')
        recovery!.assertHeld(query.chatId, query.recoveryToken)
      // `reestablish-erasure` does not carry a recovery token: the fence
      // is identified by the recorded generation on disk. Asserting a
      // token here would be a type error and would not match the wire
      // contract; the host-node path documents the same in its comment.
      return local.query<T>(query)
    }
    if (!options.broker.maintainThreadCatalogue)
      throw new Error('Host history maintenance is unavailable')
    return options.broker.maintainThreadCatalogue<T>(query)
  }
  AppStore.installThreadCatalogue(mirror)
  const ui = createThreadCatalogueUiPublisher(options.onChat, () => options.onInventoryChanged?.())
  mirror.subscribe((row, id) => {
    if (row) ui.enqueue(catalogueChatListItem(row, mirror.sourceWitnessFor(id)))
    else ui.forget(id)
  })
  AppStore.installThreadCataloguePublisher(
    currentEnsembleRuntimeInstanceId(),
    (chatId) => {
      void maintain({ method: 'changed', chatId }).catch((error) =>
        console.warn('[thread-catalogue] repair notification deferred', error)
      )
    },
    Boolean(local),
    (chatId) => maintain<string>({ method: 'repair-source', chatId })
  )
  if (local)
    recovery = new ThreadCatalogueRecoveryController({
      client: local,
      publisher: AppStore.getThreadCataloguePublisher()!,
      reader: {
        profilePath: app.getPath('userData'),
        runtimeInstanceId: currentEnsembleRuntimeInstanceId(),
        segmented: process.env.TASKWRAITH_CHAT_STORE_V2 === '1'
      },
      incarnation: currentEnsembleRuntimeInstanceId(),
      assertAuthority: () => {
        if (!options.profileAuthority) throw new Error('History profile authority is unavailable')
        options.profileAuthority.assertProfileAuthority()
      },
      hasLiveWork: (chatId) => guards.get(chatId)?.() !== true
    })
  const erasure = createCatalogueErasureCallbacks({
    maintain,
    drainPublications: (chatIds) => AppStore.drainThreadCataloguePublications(chatIds),
    mirror,
    recovery: () => recovery,
    publisher: () => AppStore.getThreadCataloguePublisher(),
    saveIntents: AppStore.getSaveIntentQueue(),
    // Caller-supplied joins take precedence over the wired ones, so a
    // future HostThreadOwnerRegistry integration can override the
    // placeholder coordinator's no-op deactivate.
    ...(options.erasureJoins ? { joins: options.erasureJoins } : { joins: ownership.erasureJoins })
  })
  AppStore.installCatalogueErasureFinish(erasure.finish)
  AppStore.installCatalogueErasure(
    // Begin side: raises the fence and joins the writers. The fence is lifted by
    // the finish side, which the deletion runs only after it verified clean.
    erasure.begin,
    async (preparation) => {
      await options.quiesceRecovery?.()
      await AppStore.drainThreadCataloguePublications(
        preparation.kind === 'global' ? undefined : preparation.chatIds
      )
    },
    () => options.resumeRecovery?.()
  )
  mirror.start()
  const ready = maintain({
    method: 'owner',
    owner: { writer: 'desktop', writerId: currentEnsembleRuntimeInstanceId(), pid: process.pid }
  }).then(() => undefined)
  return {
    launchAt,
    ready,
    maintain,
    setMutationGuard(chatId, guard) {
      guards.set(chatId, guard)
      return () => {
        if (guards.get(chatId) === guard) guards.delete(chatId)
      }
    },
    mirror,
    provider: async (query, requestOptions) => {
      const data = await port.query(query, requestOptions)
      return {
        data:
          data instanceof Uint8Array
            ? { encoding: 'base64', bytes: Buffer.from(data).toString('base64') }
            : data
      }
    },
    async dispose() {
      ui.dispose()
      recovery?.dispose()
      await AppStore.disposeThreadCataloguePublisher()
      await mirror.dispose()
      await local?.dispose()
    }
  }
}
