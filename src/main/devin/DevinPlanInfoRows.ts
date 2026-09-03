/*
 * DevinPlanInfoRows — the production `readPlanInfoRows` query runner.
 *
 * DevinUsage is deliberately pure: it parses plan-info blobs and never opens a
 * database. This module is the one impure half — the read-only sqlite3 query
 * against the Devin desktop client's local state DB — and it lives beside the
 * parser rather than inside a host so that BOTH hosts can share it.
 *
 * Two consumers, one reader: the desktop quota lane
 * (TaskWraithQuotaSnapshotHook) and the plan-state cache (DevinPlanState) that
 * the picker gate and the dispatch clamp read. A second copy of this query in
 * the Host process would be free to drift from the one the desktop uses, and
 * the two would then disagree about whether a seat is on a free plan.
 *
 * It imports Node builtins and the pure DevinUsage constants only, so it is
 * legal inside the Host Node bundle (see hostNodeBoundary.test.ts).
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

import { DEVIN_PLAN_INFO_SQL, devinStateDbCandidates } from './DevinUsage'

const DEVIN_SQLITE_TIMEOUT_MS = 5_000
const DEVIN_SQLITE_MAX_BUFFER_BYTES = 4 * 1024 * 1024

/**
 * Production default for `readDevinPlanInfoRows`: query the first readable
 * Devin state DB candidate (live file, then its `.backup`) with the
 * reference app's plan-info key families, read-only, mirroring the
 * MuseSessionLog sqlite3 pattern (URI read-only first, `-readonly` flag
 * fallback). Never throws and never blocks a missing DB: anything unreadable
 * resolves to no rows, which the lane renders as an unconfigured tombstone and
 * the plan gate treats as ungated.
 */
export function defaultDevinPlanInfoRows(): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'darwin') {
        resolve([])
        return
      }
      const home = process.env.HOME || homedir() || ''
      if (!home) {
        resolve([])
        return
      }
      const candidate = devinStateDbCandidates(home).find((path) => {
        try {
          return existsSync(path)
        } catch {
          return false
        }
      })
      if (!candidate) {
        resolve([])
        return
      }
      const opts = { timeout: DEVIN_SQLITE_TIMEOUT_MS, maxBuffer: DEVIN_SQLITE_MAX_BUFFER_BYTES }
      const finish = (output: unknown): void => {
        resolve(
          String(output ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        )
      }
      execFile(
        '/usr/bin/sqlite3',
        [`file:${candidate}?mode=ro&immutable=1`, DEVIN_PLAN_INFO_SQL],
        opts,
        (uriErr, uriStdout) => {
          if (!uriErr) {
            finish(uriStdout)
            return
          }
          execFile(
            '/usr/bin/sqlite3',
            ['-readonly', candidate, DEVIN_PLAN_INFO_SQL],
            opts,
            (err, stdout) => {
              if (err) {
                resolve([])
                return
              }
              finish(stdout)
            }
          )
        }
      )
    } catch {
      resolve([])
    }
  })
}
