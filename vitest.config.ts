import { defineConfig, configDefaults } from 'vitest/config'

const includeSwiftInterop = process.env.RUN_SWIFT_INTEROP === '1'

// Keep vitest's default discovery, but never recurse into ignored local
// worktrees. The Swift package is exercised by `swift test`; the live
// Swift<->Node driver is opt-in via RUN_SWIFT_INTEROP.
export default defineConfig({
  // Align the test transform with the app's JSX runtime. tsconfig.web.json sets
  // "jsx": "react-jsx" (automatic), but esbuild only honors a *nearest*
  // tsconfig.json — it does not follow project references from the root
  // solution file, so without this explicit setting .tsx tests are transformed
  // with the classic runtime and any JSX evaluated without `import React`
  // throws "ReferenceError: React is not defined".
  esbuild: { jsx: 'automatic' },
  test: {
    // The Windows CI runner is materially slower than the other legs -- the same
    // suite takes ~505s there against ~150s elsewhere -- and tests that are
    // nowhere near the limit locally intermittently blow vitest's 5s default.
    // Six unrelated files timed out in a single run, all on timing rather than
    // on any assertion, which is noise that reads as a red matrix. Raised for
    // win32 only, so a genuine hang on the platforms we develop on still fails
    // fast rather than being masked.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
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
