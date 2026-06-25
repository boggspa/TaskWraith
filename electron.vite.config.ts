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
  const channelGatewayEnabled =
    process.env.IOS_CHANNELS_TRUE === '1' || env.IOS_CHANNELS_TRUE === '1'
  return {
    // No build-time credential baking. Earlier Gemini login plumbing carried
    // public CLI OAuth client metadata via build-time defines; even non-secret
    // provider metadata does not belong in distributed bundles.
    main: {},
    preload: {},
    renderer: {
      define: {
        __IOS_REMOTE_TRUE__: JSON.stringify(iosRemoteEnabled),
        __CHANNELS_GATEWAY_ENABLED__: JSON.stringify(channelGatewayEnabled),
        __MESSAGES_BRIDGE_ENABLED__: JSON.stringify(channelGatewayEnabled)
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
