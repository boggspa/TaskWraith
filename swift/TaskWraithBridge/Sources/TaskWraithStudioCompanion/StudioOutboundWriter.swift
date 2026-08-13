import Foundation

/// Serialises NDJSON writes to stdout.
///
/// WHY THIS EXISTS. Once the viewer can propose an edit, TWO threads write to
/// the same descriptor: the protocol pump (its own thread) answering host
/// requests, and the main thread emitting a trim proposal at mouse-up. NDJSON
/// has no framing beyond the newline, so an interleaved partial write does not
/// produce a rejected message — it produces a SYNTACTICALLY VALID line made of
/// two halves, which is far worse. One lock, one writer, no interleaving.
final class StudioOutboundWriter: @unchecked Sendable {
    static let shared = StudioOutboundWriter()

    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    func write(_ line: Data) {
        lock.lock()
        defer { lock.unlock() }
        handle.write(line)
    }

    func write(_ lines: [Data]) {
        lock.lock()
        defer { lock.unlock() }
        for line in lines {
            handle.write(line)
        }
    }
}
