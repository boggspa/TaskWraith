import { defineConfig, configDefaults } from 'vitest/config'

const includeSwiftInterop = process.env.RUN_SWIFT_INTEROP === '1'

// Keep vitest's default discovery, but never recurse into ignored local
// worktrees. The Swift package is exercised by `swift test`; the live
// Swift<->Node driver is opt-in via RUN_SWIFT_INTEROP.
export default defineConfig({
  test: {
    // Coverage is opt-in (`npm run test:coverage:baseline`). This deliberately
    // records a measured baseline without imposing a threshold or PR ratchet.
    coverage: {
      provider: 'v8',
      reportsDirectory: 'artifacts/coverage',
      reporter: ['text-summary', 'json-summary', 'json', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/*.test.{ts,tsx}', 'src/**/*.live.test.{ts,tsx}']
    },
    exclude: [
      ...configDefaults.exclude,
      '.local-only/**',
      // Never discover test copies inside agent worktrees: they are redundant
      // with the main tree, and double-discovery breaks strict per-file
      // assertion validation (e.g. the provider-containment canary rejects
      // "live assertion titles were duplicated"). Implements the file header.
      '**/.claude/worktrees/**',
      // Fan-out lane worktrees are the same class of copy (their stale tests
      // read main-tree files via process.cwd() and rot as the main tree moves).
      '**/.taskwraith-worktrees/**',
      ...(includeSwiftInterop ? [] : ['ios/**'])
    ]
  }
})
