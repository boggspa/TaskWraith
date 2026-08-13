// swift-tools-version: 6.0
import PackageDescription

/// TaskWraithBridge — Mac-side daemon that bridges the TaskWraith Electron app
/// to native macOS Screen Watch, creative-app, editor, and stdio JSON-RPC
/// helpers.
///
/// Architecture:
///   - Electron main process spawns the `TaskWraithBridgeDaemon` executable
///     as a subprocess (mirrors the existing `CodexAppServerClient` spawn
///     pattern in `src/main/CodexAppServerClient.ts`).
///   - The daemon communicates with Electron over stdio JSON-RPC.
///   - The package is self-contained and has no sibling-checkout dependency.
let package = Package(
    name: "TaskWraithBridge",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "TaskWraithBridgeDaemon",
            targets: ["TaskWraithBridgeDaemon"]
        ),
        // NEW: Companion app bundle target (Mach-O → .app via assembly script)
        .executable(
            name: "TaskWraithStudioCompanion",
            targets: ["TaskWraithStudioCompanion"]
        )
    ],
    targets: [
        .target(name: "TaskWraithAudioKernel"),
        .executableTarget(
            name: "TaskWraithBridgeDaemon",
            dependencies: ["TaskWraithAudioKernel"]
        ),
        .testTarget(
            name: "TaskWraithBridgeDaemonTests",
            // TaskWraithAudioKernel is named so the audio-mix tests can call the
            // pure-C `tw_mix` kernel directly (it's already a transitive dep via
            // the daemon, but the test's `import TaskWraithAudioKernel` needs it
            // declared here).
            dependencies: ["TaskWraithBridgeDaemon", "TaskWraithAudioKernel"]
        ),
        // NEW: Core library (testable, no AppKit where avoidable)
        .target(
            name: "TaskWraithStudioCore",
            dependencies: []
        ),
        // NEW: Companion executable (depends on Core)
        .executableTarget(
            name: "TaskWraithStudioCompanion",
            dependencies: ["TaskWraithStudioCore"]
        ),
        // NEW: Core tests
        .testTarget(
            name: "TaskWraithStudioCoreTests",
            dependencies: ["TaskWraithStudioCore"]
        ),
        // Companion tests. Mirrors TaskWraithBridgeDaemonTests above, which
        // already proves this toolchain tests an .executableTarget carrying a
        // top-level main.swift — so the AppKit view needed no library refactor
        // and the executable product/target NAMES are unchanged, which is what
        // scripts/build-studio-companion.cjs builds by.
        .testTarget(
            name: "TaskWraithStudioCompanionTests",
            dependencies: ["TaskWraithStudioCompanion", "TaskWraithStudioCore"]
        )
    ]
)