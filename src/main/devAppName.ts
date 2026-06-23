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
if (!app.isPackaged) {
  app.setName('TaskWraith Dev')
  // Pin userData explicitly too: setName drives the default path, but this is
  // the lock/identity-bearing key, so set it outright to be order-independent.
  app.setPath('userData', join(app.getPath('appData'), 'TaskWraith Dev'))
}
