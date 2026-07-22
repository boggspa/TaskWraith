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
  return {
    // No build-time credential baking. Earlier Gemini login plumbing carried
    // public CLI OAuth client metadata via build-time defines; even non-secret
    // provider metadata does not belong in distributed bundles.
    main: {
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
        __IOS_REMOTE_TRUE__: JSON.stringify(iosRemoteEnabled)
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
