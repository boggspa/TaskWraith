import { parentPort } from 'node:worker_threads'
import * as fs from 'node:fs'
import { join } from 'node:path'
import {
  HostProfileAuthorityLease,
  HOST_PROFILE_AUTHORITY_LEASE_FILENAME
} from '../../host-runtime/HostProfileAuthorityLease'
import { ThreadCatalogueWorkerService } from '../store/ThreadCatalogueWorkerService'
import type { ThreadCatalogueOwner, ThreadCatalogueQuery } from '../store/ThreadCatalogueClient'
import type { ThreadCatalogueReaderOptions } from '../store/ThreadCatalogueDiskReader'

const utilityPort = (
  process as NodeJS.Process & {
    parentPort?: {
      postMessage(value: unknown): void
      on(event: 'message', callback: (event: { data: unknown }) => void): void
    }
  }
).parentPort
const send = (message: unknown): void => {
  if (parentPort) parentPort.postMessage(message)
  else utilityPort?.postMessage(message)
}
let service: ThreadCatalogueWorkerService | null = null
const owners = new Map<string, string>()

async function receive(value: unknown): Promise<void> {
  const request = value as {
    id: number
    /** Absent means foreground — see ThreadCatalogueClient. */
    priority?: 'foreground' | 'background'
    query:
      | ThreadCatalogueQuery
      | {
          method: 'initialize'
          reader: ThreadCatalogueReaderOptions
          decoderPath: string
          owner: ThreadCatalogueOwner
          sourceAuthorityPid: number
        }
      | { method: 'close' }
  }
  if (!request || !Number.isSafeInteger(request.id) || !request.query) return
  try {
    const query = request.query
    let result: unknown
    if (query.method === 'initialize') {
      if (service) throw new Error('History worker is already initialized')
      owners.set(query.owner.writer, query.owner.writerId)
      const authority = HostProfileAuthorityLease.peek({ profilePath: query.reader.profilePath })
      const authorityRecord =
        authority.kind === 'live' && authority.owner.pid === query.sourceAuthorityPid
          ? JSON.stringify(authority.owner)
          : null
      const authorityPath = join(query.reader.profilePath, HOST_PROFILE_AUTHORITY_LEASE_FILENAME)
      const authorityStat = authorityRecord ? fs.lstatSync(authorityPath, { bigint: true }) : null
      const assertSourceAuthority = (): void => {
        const current = HostProfileAuthorityLease.peek({ profilePath: query.reader.profilePath })
        const stat = authorityStat ? fs.lstatSync(authorityPath, { bigint: true }) : null
        if (
          !authorityRecord ||
          current.kind !== 'live' ||
          JSON.stringify(current.owner) !== authorityRecord ||
          !stat ||
          stat.ino !== authorityStat?.ino ||
          stat.dev !== authorityStat?.dev
        )
          throw new Error('History source authority is unavailable')
      }
      service = new ThreadCatalogueWorkerService({
        reader: query.reader,
        decoderPath: query.decoderPath,
        writer: query.owner.writer,
        writerId: query.owner.writerId,
        assertSourceAuthority,
        // The sole parent holds the existing profile lease or desktop singleton
        // authority. An unregistered lane remains unknown, never presumed dead.
        writerLifecycle: (lane, id) => {
          if (owners.has(lane)) return owners.get(lane) === id ? 'active' : 'retired'
          // An in-process profile lease excludes every older external Host.
          if (lane === 'host' && query.owner.writer === 'desktop' && authorityRecord)
            return 'retired'
          const registered = service?.catalogue.registeredWriter(lane, id)
          if (!registered) return 'unknown'
          try {
            process.kill(registered.pid, 0)
            return 'active'
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'retired' : 'unknown'
          }
        },
        onChanged: (entry) => send({ event: { type: 'changed', projection: entry.projection } }),
        onRemoved: (chatId) => send({ event: { type: 'removed', chatId } }),
        onProgress: (progress) => send({ event: { type: 'progress', ...progress } })
      })
      service.start()
      result = true
    } else {
      if (!service) throw new Error('History worker has not initialized')
      if (query.method === 'close') {
        await service.dispose()
        service = null
        result = true
      } else if (query.method === 'owner') {
        if (
          !['host', 'desktop'].includes(query.owner.writer) ||
          typeof query.owner.writerId !== 'string' ||
          !query.owner.writerId ||
          query.owner.writerId.length > 256
        )
          throw new Error('Invalid history writer')
        owners.set(query.owner.writer, query.owner.writerId)
        for (const id of service.catalogue.repairChatIds()) service.notifyChanged(id)
        result = true
      } else result = await service.query(query, request.priority)
    }
    send({ id: request.id, ok: true, value: result })
  } catch (error) {
    send({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : 'History request failed'
    })
  }
}
if (parentPort)
  parentPort.on('message', (message) => {
    void receive(message)
  })
else
  utilityPort?.on('message', (event) => {
    void receive(event.data)
  })
