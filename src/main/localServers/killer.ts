/*
 * Process stop helpers. SIGTERM first (let servers flush), then SIGKILL after a
 * grace window if still alive. The signalling mechanism is abstracted behind a
 * KillController so the escalation algorithm is unit-testable and platform
 * specifics (unix process-group kill vs. Windows `taskkill /T`) live in the
 * controller.
 */

import { spawnSync } from 'child_process'

export interface KillController {
  /** Send a signal; throw if it cannot be delivered (e.g. no such process). */
  signal(sig: 'SIGTERM' | 'SIGKILL'): void
  /** Whether the target process is still alive. */
  isAlive(): boolean
}

export interface EscalateOptions {
  graceMs?: number
  /** Injectable delay (tests pass an immediate resolver). */
  wait?: (ms: number) => Promise<void>
}

export interface KillResult {
  ok: boolean
  escalated: boolean
}

const defaultWait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** SIGTERM → (grace) → SIGKILL escalation against a controller. */
export async function escalateKill(
  controller: KillController,
  options: EscalateOptions = {}
): Promise<KillResult> {
  const graceMs = options.graceMs ?? 2_500
  const wait = options.wait ?? defaultWait
  try {
    controller.signal('SIGTERM')
  } catch {
    // Already gone (or not signalable) — treat as success if it's not alive.
    return { ok: !controller.isAlive(), escalated: false }
  }
  await wait(graceMs)
  if (!controller.isAlive()) return { ok: true, escalated: false }
  try {
    controller.signal('SIGKILL')
  } catch {
    return { ok: !controller.isAlive(), escalated: true }
  }
  await wait(200)
  return { ok: !controller.isAlive(), escalated: true }
}

/** True if a pid exists (signal 0 probe). */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but we can't signal it; ESRCH means gone.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Unix controller: signals the process group when a pgid is known (clean tree
 * kill for our detached spawns), else the bare pid.
 */
export function createUnixKillController(pid: number, pgid?: number): KillController {
  const target = pgid && pgid > 0 ? -pgid : pid
  return {
    signal: (sig) => process.kill(target, sig),
    isAlive: () => processExists(pid)
  }
}

/**
 * Windows controller: `taskkill` with `/T` (tree) — `/F` (force) maps to
 * SIGKILL, the graceful close-request to SIGTERM. spawnSync keeps the
 * signal() contract synchronous.
 */
export function createWindowsKillController(pid: number): KillController {
  return {
    signal: (sig) => {
      const args = ['/PID', String(pid), '/T']
      if (sig === 'SIGKILL') args.push('/F')
      const result = spawnSync('taskkill', args, { windowsHide: true })
      if (result.status !== 0 && processExists(pid)) {
        throw new Error(`taskkill exited ${result.status ?? 'null'}`)
      }
    },
    isAlive: () => processExists(pid)
  }
}
