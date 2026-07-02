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
        )
    ],
    targets: [
        // Pure-C, framework-free offline-audio mix kernel for `audio.mixdown`.
        // Sources live in Sources/TaskWraithAudioKernel/*.c; the public header
        // in include/ is auto-exposed (SwiftPM synthesizes the modulemap), so
        // the daemon does `import TaskWraithAudioKernel` to get `tw_mix`.
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
        )
    ]
)
