import { app } from 'electron'
import { join } from 'path'

// Dev (electron-vite, unpackaged) runs under the package.json name "taskwraith",
// which on macOS's case-INSENSITIVE filesystem resolves to the SAME userData
// directory as the packaged "TaskWraith" build. So a dev build and a release
// build on one Mac would otherwise share one userData — the remote identity key,
// the single-instance lock, and the relay/pairing state — making them
// indistinguishable to a paired phone (and the second instance exits on the
// shared `requestSingleInstanceLock`).
//
// Give the dev build its own name AND its own userData, so it:
//   - pairs as a fully separate host ("TaskWraith Dev on <hostname>" — the
//     pairing label is `${app.getName()} on …`), and
//   - can run at the same time as the release build (separate single-instance
//     lock, separate embedded relay state).
//
// This MUST be imported FIRST in the main entry (src/main/index.ts), before any
// module resolves `app.getPath('userData')` — Electron caches that path on first
// read, so a setName/setPath that runs after the import block (which transitively
// touches userData) would land too late to move the lock or the identity file.
// Mirrors the packaged debug build (electron-builder.debug.yml → productName
// "TaskWraith Debug", which already gets its own userData).
/**
 * `TASKWRAITH_INSTANCE_ID` — run SEVERAL dev instances side by side.
 *
 * One "TaskWraith Dev" identity is not enough for two jobs we actually do:
 *   - human-collaboration testing needs a host AND a collaborator on one Mac,
 *   - CDP-driven QA needs a disposable instance that can't disturb the dev
 *     instance a concurrent session may be mid-run in.
 *
 * Each id gets its own app name, its own userData (⇒ its own single-instance
 * lock and its own remote identity), and its own embedded relay port, so
 * instances neither evict nor race each other. Unpackaged builds ONLY — a
 * shipped release must never relocate its userData on an env var.
 *
 *   TASKWRAITH_INSTANCE_ID=1 npx electron .       → "TaskWraith Dev 1", relay 8789
 *   TASKWRAITH_INSTANCE_ID=2 npx electron .       → "TaskWraith Dev 2", relay 8790
 *   TASKWRAITH_INSTANCE_ID=verify npx electron .  → "TaskWraith Dev verify"
 */
function readDevInstanceId(): string {
  if (app.isPackaged) return ''
  // Filesystem- and display-safe: a userData directory name is built from this.
  return (process.env.TASKWRAITH_INSTANCE_ID || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 16)
}

export const devInstanceId = readDevInstanceId()

/**
 * Port shift for this instance's embedded relay, so two dev instances don't
 * fight over one port (the loser silently ends up with no relay and cannot be
 * dialled — which reads as "collaboration is broken", not "port collision").
 *
 * A numeric id maps to itself — `=1` → +1 — because a predictable port is what
 * makes a QA script writable. Non-numeric ids fall back to a deterministic hash
 * so `=verify` still lands on the same port every launch.
 * `TASKWRAITH_RELAY_PORT` overrides this entirely.
 */
export function devInstanceRelayPortOffset(): number {
  if (!devInstanceId) return 0
  const numeric = Number(devInstanceId)
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= 99) return numeric
  let hash = 0
  for (let index = 0; index < devInstanceId.length; index += 1) {
    hash = (hash * 31 + devInstanceId.charCodeAt(index)) % 99
  }
  return hash + 1
}

if (!app.isPackaged) {
  const instanceName = devInstanceId ? `TaskWraith Dev ${devInstanceId}` : 'TaskWraith Dev'
  app.setName(instanceName)
  // Pin userData explicitly too: setName drives the default path, but this is
  // the lock/identity-bearing key, so set it outright to be order-independent.
  app.setPath('userData', join(app.getPath('appData'), instanceName))
}
