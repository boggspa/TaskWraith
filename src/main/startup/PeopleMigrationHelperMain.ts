import { peopleMigrationDeletionKey } from './PeopleMigrationHelperLease'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { app, safeStorage } from 'electron'
import { assertPeopleMigrationLease, readPeopleMigrationLease } from './PeopleMigrationHelperLease'
import { runPeopleMigrationHelper } from './PeopleMigrationHelperCore'
import {
  PEOPLE_MIGRATION_HELPER_RESULT_LIMIT,
  type PeopleMigrationHelperRequest
} from './PeopleMigrationHelperProtocol'

/** Minimal Electron main: native safeStorage, private IPC, no application/store bootstrap. */
export async function startPeopleMigrationHelper(): Promise<void> {
  if (!process.send || !process.connected) {
    app.exit(1)
    return
  }
  if (process.platform === 'darwin') {
    app.setActivationPolicy('prohibited')
    app.dock?.hide()
  }
  const startupTimer = setTimeout(() => app.exit(1), 30_000)
  let initialized = false
  let running = false
  let finishing = false
  let watchdog: Worker | undefined
  process.on('disconnect', () => app.exit(1))
  process.once('message', async (value: unknown) => {
    try {
      const request = value as PeopleMigrationHelperRequest
      if (
        initialized ||
        request.type !== 'initialize' ||
        request.parentPid !== process.ppid ||
        typeof request.profilePath !== 'string' ||
        typeof request.appName !== 'string' ||
        (request.deletionScope !== undefined &&
          !peopleMigrationDeletionKey(request.deletionScope)) ||
        request.appName !== app.getName() ||
        fs.realpathSync(app.getPath('userData')) !== request.profilePath
      )
        throw new Error('Migration helper identity does not match its parent')
      const lease = readPeopleMigrationLease(request.profilePath)
      if (
        !lease ||
        lease.value.nonce !== request.nonce ||
        lease.value.parentPid !== process.ppid ||
        lease.value.childPid !== process.pid
      )
        throw new Error('Migration helper is not registered')
      initialized = true
      const assert = (): void => {
        if (process.ppid !== request.parentPid || !process.connected)
          throw new Error('Migration parent exited')
        assertPeopleMigrationLease(lease)
      }
      // A separate JS thread can stop synchronous JSON/crypto work after the
      // parent dies. Its durable lease keeps replacement migration/erasure out
      // until the OS confirms this process has exited.
      watchdog = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads')
        const fs = require('node:fs')
        const check = () => {
          let valid = process.ppid === workerData.parentPid
          try { process.kill(workerData.parentPid, 0) } catch (e) { if (e.code === 'ESRCH') valid = false }
          try {
            const stat = fs.lstatSync(workerData.path)
            const lease = JSON.parse(fs.readFileSync(workerData.path, 'utf8'))
            valid &&= stat.ino === workerData.inode && stat.dev === workerData.device && lease.nonce === workerData.nonce
            try {
              const deletionStat = fs.lstatSync(workerData.deletion)
              if (!workerData.deletionScope || !deletionStat.isFile() || deletionStat.isSymbolicLink() || deletionStat.size > 64 * 1024 * 1024) valid = false
              else {
                const deletion = JSON.parse(fs.readFileSync(workerData.deletion, 'utf8'))
                valid &&= Array.isArray(deletion.chatIds) && JSON.stringify([deletion.operationId, deletion.kind, [...deletion.chatIds].sort()]) === workerData.deletionScope
              }
            } catch (e) { if (e.code !== 'ENOENT' || workerData.deletionScope) valid = false }
          } catch { valid = false }
          if (!valid) process.kill(process.pid, 'SIGKILL')
        }
        check(); parentPort.postMessage('ready'); setInterval(check, 25)
      `,
        {
          eval: true,
          workerData: {
            parentPid: request.parentPid,
            path: lease.path,
            inode: lease.inode,
            device: lease.device,
            nonce: request.nonce,
            deletion: join(request.profilePath, 'history-deletion-intent.json'),
            deletionScope: peopleMigrationDeletionKey(request.deletionScope)
          }
        }
      )
      await new Promise<void>((resolve, reject) => {
        watchdog!.once('message', () => resolve())
        watchdog!.once('error', reject)
        watchdog!.once('exit', () => reject(new Error('Migration watchdog exited')))
      })
      watchdog.on('error', () => {
        if (!finishing) app.exit(1)
      })
      watchdog.on('exit', () => {
        if (!finishing) app.exit(1)
      })
      process.once('message', async (message: unknown) => {
        try {
          const begin = message as { type?: string; nonce?: string }
          if (running || begin.type !== 'run' || begin.nonce !== request.nonce)
            throw new Error('Invalid migration start')
          running = true
          assert()
          clearTimeout(startupTimer)
          await app.whenReady()
          assert()
          const result = runPeopleMigrationHelper(request, safeStorage, assert)
          if (Buffer.byteLength(JSON.stringify(result)) > PEOPLE_MIGRATION_HELPER_RESULT_LIMIT)
            throw new Error('Migration completion metadata exceeds its established storage bound')
          finishing = true
          process.send!({ type: 'complete', nonce: request.nonce, result }, () => app.exit(0))
        } catch {
          finishing = true
          process.send!({ type: 'failed', nonce: request.nonce }, () => app.exit(1))
        }
      })
      process.send!({ type: 'armed', nonce: request.nonce })
    } catch {
      app.exit(1)
    }
  })
  process.send({ type: 'ready', pid: process.pid })
}
