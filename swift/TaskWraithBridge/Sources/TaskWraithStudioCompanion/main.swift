import Foundation
import TaskWraithStudioCore

/// TaskWraith Studio companion entry point.
///
/// Two modes, one protocol:
/// * DEFAULT (headless) — the proven stdio pump. Emit studio/hello (numeric
///   protocolVersion), parse the hello response, emit studio/getDocument, parse
///   the document response, then stay resident consuming notifications until
///   stdin EOF -> exit 0. Handshake failures exit nonzero so
///   StudioCompanionSupervisor treats them as crashes. This path is unchanged
///   and is what the host-side interop test exercises.
/// * --viewer — additionally opens the AppKit + CAMetalLayer viewer window and
///   gives AppKit the main thread, moving the stdio pump to its own thread. The
///   protocol behaviour and exit codes are identical.
///
/// All protocol behaviour lives in StudioCompanionSession (TaskWraithStudioCore)
/// so tests cover it in-process; nothing here re-derives framing or error codes.
/// src/main/studio/StudioProtocol.ts is the normative wire contract.
///
/// --hydrate-once: exit 0 immediately after successful hydration. Used by the
/// host-side StudioCompanionSupervisor interop test to make the end-to-end
/// exercise self-verifying (exit 0 is unreachable without the full
/// hello -> getDocument path). Production launch omits the flag.

let arguments = CommandLine.arguments
let hydrateOnce = arguments.contains("--hydrate-once")

if arguments.contains("--viewer") {
    StudioViewerApp.run(hydrateOnce: hydrateOnce)
}

exit(StudioCompanionStdioPump.run(hydrateOnce: hydrateOnce))
