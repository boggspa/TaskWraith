/**
 * Durable capture for the standalone Host's stderr.
 *
 * WHY THIS EXISTS
 * ---------------
 * The TUI spawns the production Host detached and then `unref()`s it. Before
 * this module, that spawn used `stdio: 'ignore'`, so fd 2 pointed at
 * `/dev/null` for the entire life of the daemon. Every Host-side diagnostic —
 * a provider binary that failed to spawn, an ACP strict-model abort, a
 * persisted-start grace expiry, an auth failure, a raw stack trace — was
 * written into the void.
 *
 * That is not a small gap. It is the whole reason a failing turn looks like
 * "models and turns randomly fail when there's nothing evidently wrong": there
 * is nothing evidently wrong because the evidence was discarded at spawn time.
 * The Host writes no run events either, and its command-receipt checkpoint is
 * a bounded ring shared with (and in practice flooded by) the desktop
 * renderer, so stderr is the ONLY place a Host-side failure explains itself.
 *
 * WHY A FILE AND NOT THE TERMINAL
 * -------------------------------
 * `'ignore'` was not an oversight — inheriting fd 2 is actively wrong here.
 * The TUI paints a full-screen frame, and `escapedErrorPolicy.ts` documents
 * the consequence: "a stray stderr line punches a hole through the frame".
 * A detached daemon can write at any moment, including mid-render, so the
 * capture target must be a file descriptor the terminal never sees.
 *
 * FAIL-OPEN, ALWAYS
 * -----------------
 * Logging is a diagnostic aid, never a precondition for running. Every failure
 * mode here — unwritable profile, full disk, permission error — returns `null`
 * so the caller falls back to `'ignore'` and the Host still starts. A user who
 * cannot write a log file must still get their turn.
 */

import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Host-owned subdirectory of the profile; already holds the Host's checkpoints. */
export const HOST_STDERR_LOG_DIR = 'host-runtime'
/** Current generation. */
export const HOST_STDERR_LOG_FILE = 'host-stderr.log'
/** One previous generation, kept so a rotation mid-investigation is not fatal. */
export const HOST_STDERR_LOG_PREVIOUS_FILE = 'host-stderr.previous.log'

/**
 * Rotate at 4 MiB. A detached daemon runs for days and nothing else trims this
 * file, so an unbounded log is a slow disk-fill — and a full disk presents as
 * agents hallucinating, which is far worse than the failure we are diagnosing.
 * Two generations bound the total at ~8 MiB.
 */
export const HOST_STDERR_LOG_MAX_BYTES = 4 * 1024 * 1024

/** Absolute path of the current-generation Host stderr log for a profile. */
export function hostStderrLogPath(userDataPath: string): string {
  return join(userDataPath, HOST_STDERR_LOG_DIR, HOST_STDERR_LOG_FILE)
}

/** Absolute path of the previous-generation Host stderr log for a profile. */
export function hostStderrLogPreviousPath(userDataPath: string): string {
  return join(userDataPath, HOST_STDERR_LOG_DIR, HOST_STDERR_LOG_PREVIOUS_FILE)
}

/**
 * Rotate the current log aside once it exceeds the cap.
 *
 * Best effort by construction: if rotation fails we keep appending to the
 * existing file rather than losing the handle. An oversized log is a lesser
 * evil than no log.
 */
function rotateIfOversized(currentPath: string, previousPath: string): void {
  let size = 0
  try {
    size = statSync(currentPath).size
  } catch {
    // No current log yet (or it is unreadable) — nothing to rotate.
    return
  }
  if (size < HOST_STDERR_LOG_MAX_BYTES) return
  try {
    // Windows refuses a rename onto an existing file, so clear the target
    // first; `force` keeps a missing previous generation from throwing.
    rmSync(previousPath, { force: true })
    renameSync(currentPath, previousPath)
  } catch {
    // Keep appending to the oversized file rather than dropping diagnostics.
  }
}

/**
 * Open an append-mode fd for the Host's stderr, rotating first when oversized.
 *
 * Returns `null` — never throws — when the log cannot be opened, so the caller
 * can fall back to `'ignore'` and still launch the Host.
 *
 * The caller owns the returned fd: `spawn` dups it into the child, so the
 * parent must close its own copy afterwards or it leaks one fd per launch.
 */
export function openHostStderrLogFd(userDataPath: string): number | null {
  if (!userDataPath) return null
  try {
    const directory = join(userDataPath, HOST_STDERR_LOG_DIR)
    mkdirSync(directory, { recursive: true })
    const currentPath = join(directory, HOST_STDERR_LOG_FILE)
    rotateIfOversized(currentPath, join(directory, HOST_STDERR_LOG_PREVIOUS_FILE))
    return openSync(currentPath, 'a')
  } catch {
    return null
  }
}

/** Close a fd from {@link openHostStderrLogFd}, ignoring an already-closed one. */
export function closeHostStderrLogFd(fd: number | null): void {
  if (fd == null) return
  try {
    closeSync(fd)
  } catch {
    // Already closed, or never really open. Nothing to recover.
  }
}
