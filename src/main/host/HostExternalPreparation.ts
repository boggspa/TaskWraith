import { randomUUID } from 'node:crypto'
import { isAbsolute, parse, resolve } from 'node:path'

import { HostShutdownClient } from '../../host-client/HostShutdownClient'
import {
  legacyStoreWriterGate,
  type LegacyStoreWriterGateSnapshot
} from '../store/LegacyStoreWriterGate'
import {
  clearPreparedExternalHost,
  publishPreparedExternalHost,
  type PreparedExternalHost
} from './HostExternalRuntimeState'
import type { HostExternalEnsureResult, HostExternalSupervisor } from './HostExternalSupervisor'
import { persistLegacyStoreWriterGate } from './LegacyStoreWriterGatePersistence'

export type HostExternalPreparationPhase =
  | 'idle'
  | 'preparing'
  | 'prepared'
  | 'cleaning'
  | 'cleaned'
  | 'failed'

export interface HostExternalPreparationWriterGate {
  beginDrain(): boolean
  awaitDrained(): Promise<void>
  markHostOwned(input: { hostId: string; generation: number; cutoverId: string }): boolean
  rollbackDrain(): boolean
  snapshot(): LegacyStoreWriterGateSnapshot
}

export interface HostExternalPreparationOptions {
  readonly profilePath: string
  readonly migrateLegacyUserData: () => Promise<void> | void
  readonly createSupervisor: () => HostExternalSupervisor
  readonly writerGate?: HostExternalPreparationWriterGate
  readonly createCutoverId?: () => string
  readonly publishPrepared?: (input: PreparedExternalHost) => PreparedExternalHost
  readonly clearPrepared?: (expected: HostExternalSupervisor) => boolean
  readonly createShutdownClient?: (profilePath: string) => Pick<HostShutdownClient, 'shutdown'>
  readonly log?: (line: string) => void
}

export interface HostExternalPreparation {
  readonly phase: HostExternalPreparationPhase
  prepare(): Promise<PreparedExternalHost>
  /** Roll back a failed preparation/main import. Existing Hosts are detach-only. */
  cleanup(): Promise<void>
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  return (value.replace(/\s+/g, ' ').trim() || 'unknown failure').slice(0, 300)
}

export function createHostExternalPreparation(
  options: HostExternalPreparationOptions
): HostExternalPreparation {
  if (
    !options ||
    typeof options.migrateLegacyUserData !== 'function' ||
    typeof options.createSupervisor !== 'function' ||
    !isAbsolute(options.profilePath) ||
    resolve(options.profilePath) !== options.profilePath ||
    options.profilePath === parse(options.profilePath).root
  ) {
    throw new Error('External Host preparation requires migration and supervisor factories.')
  }
  const writerGate: HostExternalPreparationWriterGate =
    options.writerGate ?? persistLegacyStoreWriterGate(options.profilePath, legacyStoreWriterGate)
  const createCutoverId = options.createCutoverId ?? randomUUID
  const publishPrepared = options.publishPrepared ?? publishPreparedExternalHost
  const clearPrepared = options.clearPrepared ?? clearPreparedExternalHost
  const createShutdownClient =
    options.createShutdownClient ??
    ((profilePath: string) => new HostShutdownClient({ profilePath }))
  let phaseValue: HostExternalPreparationPhase = 'idle'
  let supervisor: HostExternalSupervisor | null = null
  let ensureResult: HostExternalEnsureResult | null = null
  let prepared: PreparedExternalHost | null = null
  let published = false
  let cleanupPromise: Promise<void> | null = null

  const cleanupOnce = async (): Promise<void> => {
    phaseValue = 'cleaning'
    let failure: unknown
    const capture = (error: unknown): void => {
      failure ??= error
    }
    try {
      if (ensureResult?.kind === 'launched') {
        await createShutdownClient(options.profilePath).shutdown()
      }
    } catch (error) {
      capture(error)
    }
    let detached = false
    try {
      if (published && supervisor) detached = clearPrepared(supervisor)
    } catch (error) {
      capture(error)
    }
    published = false
    if (!detached) {
      try {
        supervisor?.close()
      } catch (error) {
        capture(error)
      }
    }
    try {
      if (writerGate.snapshot().state === 'draining' && !writerGate.rollbackDrain()) {
        throw new Error('Legacy writer drain could not roll back during cleanup.')
      }
    } catch (error) {
      capture(error)
    }
    phaseValue = 'cleaned'
    if (failure) throw failure
  }

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= cleanupOnce()
    return cleanupPromise
  }

  const prepare = async (): Promise<PreparedExternalHost> => {
    if (phaseValue !== 'idle') throw new Error('External Host preparation is one-shot.')
    phaseValue = 'preparing'
    try {
      const cutoverId = createCutoverId()
      await options.migrateLegacyUserData()
      if (!writerGate.beginDrain()) {
        throw new Error('Legacy writer drain could not begin for external Host preparation.')
      }
      await writerGate.awaitDrained()
      supervisor = options.createSupervisor()
      ensureResult = await supervisor.ensureAvailable()
      if (
        !writerGate.markHostOwned({
          hostId: ensureResult.welcome.hostId,
          generation: ensureResult.welcome.generation,
          cutoverId
        })
      ) {
        throw new Error('Legacy writer ownership could not transfer to the external Host.')
      }
      published = true
      prepared = publishPrepared({
        profilePath: options.profilePath,
        cutoverId,
        supervisor,
        createSupervisor: options.createSupervisor,
        result: ensureResult
      })
      phaseValue = 'prepared'
      return prepared
    } catch (error) {
      try {
        await cleanup()
      } catch (cleanupError) {
        options.log?.(`[external-host-preparation] cleanup failed: ${boundedError(cleanupError)}`)
      }
      phaseValue = 'failed'
      throw error
    }
  }

  return {
    get phase() {
      return phaseValue
    },
    prepare,
    cleanup
  }
}
