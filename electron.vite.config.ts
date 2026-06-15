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
  const debugBuild = process.env.TASKWRAITH_DEBUG_BUILD === '1' || env.TASKWRAITH_DEBUG_BUILD === '1'
  // Gemini Google-login refresh needs the maintainer's OAuth client secret.
  // It must NEVER bake into a distributed (production/notarized) build — a
  // security review found the literal baked into the 1.4.9 app.asar. Bake it
  // ONLY for dev + debug builds (where the maintainer exercises the login
  // flow); public builds get an empty string, which just disables that one
  // refresh path — exactly like a fresh clone with no `.env`. Escape hatch:
  // TASKWRAITH_BUNDLE_GEMINI_SECRET=1 force-bundles for an unusual build.
  const bundleGeminiSecret =
    mode === 'development' ||
    debugBuild ||
    process.env.TASKWRAITH_BUNDLE_GEMINI_SECRET === '1'
  const geminiOauthClientSecret = bundleGeminiSecret ? (env.GEMINI_OAUTH_CLIENT_SECRET ?? '') : ''
  return {
    main: {
      define: {
        'process.env.GEMINI_OAUTH_CLIENT_SECRET': JSON.stringify(geminiOauthClientSecret)
      }
    },
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
