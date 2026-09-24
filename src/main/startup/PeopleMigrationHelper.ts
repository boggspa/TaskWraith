import type { PeopleMigrationDeletionScope } from './PeopleMigrationHelperLease'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import { app } from 'electron'
import { instanceLaunchBootstrapArgs } from '../devAppName'
import { PeopleToChannelMigrationLegacyWriteGate } from '../collaboration/PeopleToChannelMigrationLegacyWriteGate'
import type { PeopleToChannelMigrationFinalizationProductionRunResult } from '../collaboration/PeopleToChannelMigrationFinalizationProductionRunner'
import {
  acquirePeopleMigrationLease,
  assertPeopleMigrationLease,
  bindPeopleMigrationChild,
  releasePeopleMigrationLease
} from './PeopleMigrationHelperLease'
import { assertNoPeopleMigrationDeletion } from './PeopleMigrationHelperLease'
import {
  PEOPLE_MIGRATION_HELPER_ARG,
  type PeopleMigrationHelperRequest,
  type PeopleMigrationResult
} from './PeopleMigrationHelperProtocol'

export async function runPeopleMigrationIsolated(options: {
  runtimeInstanceId: string
  defaultProvider?: string
  deletionScope?: PeopleMigrationDeletionScope
}): Promise<PeopleToChannelMigrationFinalizationProductionRunResult> {
  const profilePath = fs.realpathSync(app.getPath('userData'))
  assertNoPeopleMigrationDeletion(profilePath, options.deletionScope)
  const lease = await acquirePeopleMigrationLease(profilePath)
  let child: ChildProcess | undefined
  let exited = false
  const stop = (): void => {
    if (child && !exited) child.kill('SIGKILL')
  }
  app.once('before-quit', stop)
  try {
    const result = await new Promise<PeopleMigrationResult>((resolve, reject) => {
      let completed: PeopleMigrationResult | undefined
      let failure: Error | undefined
      const timer = setTimeout(() => {
        failure = new Error('Migration helper did not initialize')
        stop()
      }, 30_000)
      timer.unref?.()
      let phase: 'starting' | 'initializing' | 'running' | 'complete' = 'starting'
      try {
        child = spawn(
          process.execPath,
          [
            ...(app.isPackaged ? [] : [app.getAppPath()]),
            ...instanceLaunchBootstrapArgs,
            PEOPLE_MIGRATION_HELPER_ARG
          ],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' }
        )
      } catch (error) {
        clearTimeout(timer)
        throw error
      }
      child.once('spawn', () => {
        try {
          bindPeopleMigrationChild(lease, child!.pid!)
          assertNoPeopleMigrationDeletion(profilePath, options.deletionScope)
        } catch (error) {
          failure = error as Error
          stop()
        }
      })
      child.on('message', (message: unknown) => {
        try {
          const value = message as {
            type?: string
            pid?: number
            nonce?: string
            result?: PeopleMigrationResult
          }
          assertPeopleMigrationLease(lease)
          if (
            phase === 'starting' &&
            value.type === 'ready' &&
            value.pid === child!.pid &&
            lease.value.childPid === child!.pid
          ) {
            const request: PeopleMigrationHelperRequest = {
              type: 'initialize',
              nonce: lease.value.nonce,
              parentPid: process.pid,
              profilePath,
              appName: app.getName(),
              runtimeInstanceId: options.runtimeInstanceId,
              segmented: process.env.TASKWRAITH_CHAT_STORE_V2 === '1',
              defaultProvider: options.defaultProvider,
              deletionScope: options.deletionScope
            }
            phase = 'initializing'
            child!.send(request)
          } else if (value.nonce !== lease.value.nonce)
            throw new Error('Migration helper response identity changed')
          else if (phase === 'initializing' && value.type === 'armed') {
            assertNoPeopleMigrationDeletion(profilePath, options.deletionScope)
            clearTimeout(timer)
            phase = 'running'
            child!.send({ type: 'run', nonce: lease.value.nonce })
          } else if (phase === 'running' && value.type === 'complete' && value.result) {
            phase = 'complete'
            completed = value.result
          } else throw new Error('Collaboration migration did not complete')
        } catch (error) {
          failure = error as Error
          stop()
        }
      })
      child.once('error', (error) => {
        failure = error
        clearTimeout(timer)
        if (!child?.pid) {
          exited = true
          reject(error)
        } else stop()
      })
      child.once('exit', (code) => {
        exited = true
        clearTimeout(timer)
        if (!failure && code === 0 && completed) resolve(completed)
        else
          reject(
            failure ?? new Error('Collaboration migration was interrupted; checkpoints retained')
          )
      })
    })
    assertPeopleMigrationLease(lease)
    assertNoPeopleMigrationDeletion(profilePath, options.deletionScope)
    if (
      result.schemaVersion !== 1 ||
      result.migration?.phase !== 'committed' ||
      result.finalization?.phase !== 'committed' ||
      !Array.isArray(result.finalization.retainedWorkspaceBootstrapShareIds) ||
      !result.terminalPlanId
    )
      throw new Error('Migration helper returned an invalid completion')
    const legacyWriteGate = new PeopleToChannelMigrationLegacyWriteGate()
    legacyWriteGate.quiesce({
      retainedWorkspaceBootstrapShareIds: result.finalization.retainedWorkspaceBootstrapShareIds
    })
    return { ...result, legacyWriteGate }
  } finally {
    app.removeListener('before-quit', stop)
    // Never release authority on a result/disconnect alone. The exit event is
    // the boundary that excludes every later helper filesystem operation.
    if (!child || exited) releasePeopleMigrationLease(lease)
    else stop()
  }
}
