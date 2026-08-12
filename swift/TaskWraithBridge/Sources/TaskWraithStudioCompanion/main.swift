import Foundation
import TaskWraithStudioCore

/// TaskWraith Studio companion entry point: a thin stdio pump around the
/// deterministic StudioCompanionSession state machine (TaskWraithStudioCore).
/// All protocol behaviour lives in the session so tests cover it in-process;
/// nothing here re-derives framing or error codes — src/main/studio/
/// StudioProtocol.ts is the normative wire contract.
///
/// Lifecycle: emit studio/hello (numeric protocolVersion), parse the hello
/// response, emit studio/getDocument, parse the document response, then stay
/// resident consuming notifications until stdin EOF -> exit 0. Handshake
/// failures exit nonzero so StudioCompanionSupervisor treats them as crashes.
///
/// --hydrate-once: exit 0 immediately after successful hydration. Used by the
/// host-side StudioCompanionSupervisor interop test to make the end-to-end
/// exercise self-verifying (exit 0 is unreachable without the full
/// hello -> getDocument path). Production launch omits the flag.

let hydrateOnce = CommandLine.arguments.contains("--hydrate-once")
let session = StudioCompanionSession(hydrateOnce: hydrateOnce)
let standardInput = FileHandle.standardInput
let standardOutput = FileHandle.standardOutput
let standardError = FileHandle.standardError

func writeLines(_ lines: [Data]) {
    for line in lines {
        standardOutput.write(line)
    }
}

func reportProtocolErrors(_ notes: [String]) {
    for note in notes {
        if let data = "taskwraith-studio-companion: \(note)\n".data(using: .utf8) {
            standardError.write(data)
        }
    }
}

writeLines(session.startLines())

while true {
    let chunk = standardInput.availableData
    if chunk.isEmpty {
        break // stdin EOF: the host closed us down.
    }
    let step = session.consume(chunk: chunk)
    reportProtocolErrors(step.protocolErrors)
    writeLines(step.outboundLines)
    if let code = step.exitCode {
        exit(code)
    }
}
exit(session.eofExitCode())
