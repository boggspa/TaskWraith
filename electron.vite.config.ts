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
            index: resolve('src/main/index.ts'),
            // utilityProcess entry: the 90-day external-activity scan runs
            // off the main event loop (see ExternalActivityWorkerScan.ts).
            externalActivityWorker: resolve('src/main/workers/externalActivityWorker.ts')
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
