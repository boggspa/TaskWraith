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
import { withThreadCatalogueReadContext } from '../store/ThreadCatalogueReadContextPort'
import type { HostProfileAuthorityPort } from '../../host-runtime/HostProfileDomainStore'
import type {
  ThreadCatalogueReadQuery,
  ThreadCatalogueMaintenanceQuery,
  ThreadCatalogueWireReply
} from '../../shared/threadCatalogueProtocol'

export function installStartupThreadCatalogue(options: {
  quiesceRecovery?(): Promise<void>
  resumeRecovery?(): void
  externalHost: boolean
  profileAuthority?: HostProfileAuthorityPort
  broker: HostProjectionBroker
  onInventoryChanged?(): void
  onChat: (chat: ReturnType<typeof catalogueChatListItem>) => void
}): {
  launchAt: number
  ready: Promise<void>
  mirror: ThreadCatalogueMirror
  provider: (query: ThreadCatalogueReadQuery) => Promise<ThreadCatalogueWireReply>
  dispose(): Promise<void>
  maintain<T = unknown>(query: ThreadCatalogueMaintenanceQuery): Promise<T>
  setMutationGuard(chatId: string, guard: () => boolean): () => void
} {
  const launchAt = Date.now()
  const local = options.externalHost
    ? null
    : createDesktopThreadCatalogue(
        app.getPath('userData'),
        currentEnsembleRuntimeInstanceId(),
        AppStore.getSettings().activeProvider
      )
  // NOTE: the external-Host transport carries no lane. `queryThreadCatalogue`
  // takes the decoded query alone, and the wire has no envelope to put a
  // priority on, so an external-Host install still runs its recovery drain in
  // the fast lane. The Host has its own drain and its own worker, so this is a
  // gap rather than a regression — closing it needs the broker to carry the
  // field, which is a protocol change and not this one.
  const transport: ThreadCatalogueReadPort = local ?? {
    query: async <T>(query: ThreadCatalogueReadQuery): Promise<T> => {
      if (!options.broker.queryThreadCatalogue)
        throw new Error('Host history catalogue is unavailable')
      return options.broker.queryThreadCatalogue<T>(query)
    }
  }
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
      if (query.method === 'prepare') recovery!.assertHeld(query.chatId, query.recoveryToken)
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
  AppStore.installCatalogueErasure(
    async (preparation) => {
      const scopes = preparation.kind === 'global' ? [undefined] : preparation.chatIds
      for (const chatId of scopes) {
        const generation = await maintain<string>({
          method: 'erase',
          ...(chatId ? { chatId } : {})
        })
        if (chatId) mirror.forget(chatId)
        else mirror.forgetAll()
        if (
          !(await maintain<boolean>({
            method: 'finish-erasure',
            generation,
            ...(chatId ? { chatId } : {})
          }))
        )
          throw new Error('History catalogue erasure was not acknowledged')
        recovery?.forgetErased(chatId)
        AppStore.getThreadCataloguePublisher()?.forgetErased(chatId)
      }
    },
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
    provider: async (query) => {
      const data = await port.query(query)
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
