//
// TaskWraithStudioCompanion — Main entry point for the Studio companion app.
//
// Architecture:
//   - AppKit + Metal windowed app (separate process from TaskWraithBridgeDaemon).
//   - Communicates with Electron host via NDJSON/JSON-RPC over stdio/socket.
//   - Stateless projection of host-owned state (revisioned protocol).
//

import AppKit
import TaskWraithStudioCore

class StudioAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // TODO: AppKit lifecycle, window setup, and NDJSON decoder integration.
        // See StudioNdjsonDecoder.swift for protocol conformance.
    }
}

let app = NSApplication.shared
let delegate = StudioAppDelegate()
app.delegate = delegate
app.run()