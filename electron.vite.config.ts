import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Load `.env` (gitignored) so build-time secrets stay out of source/git. The
  // empty-prefix arg loads non-`VITE_`-prefixed keys too.
  const env = loadEnv(mode, process.cwd(), '')
  // iOS remote is no longer hidden behind a positive build flag. Keep
  // IOS_REMOTE_TRUE=0/false as an emergency force-off override for local builds.
  const iosRemoteOverride = String(process.env.IOS_REMOTE_TRUE ?? env.IOS_REMOTE_TRUE ?? '')
    .trim()
    .toLowerCase()
  const iosRemoteEnabled = iosRemoteOverride !== '0' && iosRemoteOverride !== 'false'
  const activityReportingEndpoint = String(
    process.env.TASKWRAITH_ACTIVITY_ENDPOINT ?? env.TASKWRAITH_ACTIVITY_ENDPOINT ?? ''
  ).trim()
  if (activityReportingEndpoint) {
    const url = new URL(activityReportingEndpoint)
    const loopback =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    const pathname = url.pathname.replace(/\/+$/, '')
    if (
      (url.protocol !== 'https:' && !loopback) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (pathname && pathname !== '/v1/checkin' && pathname !== '/v1/presence')
    ) {
      throw new Error(
        'TASKWRAITH_ACTIVITY_ENDPOINT must be an HTTPS (or loopback HTTP) receiver URL without credentials, query, or fragment.'
      )
    }
  }
  return {
    // No build-time credential baking. Earlier Gemini login plumbing carried
    // public CLI OAuth client metadata via build-time defines; even non-secret
    // provider metadata does not belong in distributed bundles.
    main: {
      define: {
        __TASKWRAITH_ACTIVITY_ENDPOINT__: JSON.stringify(activityReportingEndpoint)
      },
      build: {
        rollupOptions: {
          input: {
            index: resolve('src/main/bootstrap.ts'),
            // utilityProcess entry: the 90-day external-activity scan runs
            // off the main event loop (see ExternalActivityWorkerScan.ts).
            externalActivityWorker: resolve('src/main/workers/externalActivityWorker.ts'),
            // Project-reference ownership is rebuilt from the append-only
            // run-event archive on startup. Keep that multi-gigabyte stream
            // away from Electron main just like the usage/activity scans.
            projectReferenceOwnershipWorker: resolve(
              'src/main/workers/projectReferenceOwnershipWorker.ts'
            ),
            // Workspace activity may need a cold git/filesystem walk too.
            // Bundle it as its own utilityProcess entry so the renderer's
            // 90-day heatmap only ever reads a main-process cache.
            workspaceActivityWorker: resolve('src/main/workers/workspaceActivityWorker.ts'),
            // Detailed status/numstat parsing must not share Electron main's
            // event loop with transcript delivery.
            gitSnapshotWorker: resolve('src/main/workers/gitSnapshotWorker.ts'),
            // Work-provenance sampling brackets Git state and fingerprints
            // dirty paths. Keep that synchronous audited core out of main.
            workProvenanceWorker: resolve('src/main/workers/workProvenanceWorker.ts'),
            // saveChat's durable write (write + fsync + rename + dir fsync) is
            // blocked-on-syscall wall time a V8 CPU profile cannot see, and a
            // hot chat record can be ~16 MB. Unlike the scan workers above this
            // one is LONG-LIVED: a fork per chat save would cost more than the
            // fsync it avoids. Off unless TASKWRAITH_UTILITY_WRITE=1.
            persistenceWriteWorker: resolve('src/main/workers/persistenceWriteWorker.ts')
          },
          output: {
            // bootstrap.ts deliberately defers the full main graph behind a
            // dynamic import. Keep that chunk beside index.js: main runtime
            // paths (preload, renderer, utility workers, dev Swift bridge)
            // are resolved from the out/main directory.
            chunkFileNames: '[name]-[hash].js'
          }
        }
      }
    },
    preload: {},
    renderer: {
      define: {
        __IOS_REMOTE_TRUE__: JSON.stringify(iosRemoteEnabled),
        __TASKWRAITH_ACTIVITY_REPORTING_CONFIGURED__: JSON.stringify(
          Boolean(activityReportingEndpoint)
        )
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react()]
    }
  }
})
