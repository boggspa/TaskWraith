import { defineConfig, configDefaults } from 'vitest/config'

const includeSwiftInterop = process.env.RUN_SWIFT_INTEROP === '1'

// Keep vitest's default discovery, but never recurse into ignored local
// worktrees. The Swift package is exercised by `swift test`; the live
// Swift<->Node driver is opt-in via RUN_SWIFT_INTEROP.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.local-only/**',
      ...(includeSwiftInterop ? [] : ['ios/**'])
    ]
  }
})
