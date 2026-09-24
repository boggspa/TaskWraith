import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

/// The blue-banner class: a payload this device could not read surfaced as
/// Foundation's bare, unattributed copy and rendered as a calm informational
/// notice that auto-faded.
///
/// `Session.onEncrypted` parses a frame AFTER `TWCipher.open` has authenticated
/// it, so a throw there means the Mac sealed something this build cannot read —
/// a version-skew fault, not a network blip and not a Mac refusal.
@Suite("Unreadable payload banner")
struct UnreadablePayloadBannerTests {
    private struct Shape: Codable { let a: Int }

    /// Provoke the real errors rather than hand-copying Foundation's text:
    /// it localizes with a TYPOGRAPHIC apostrophe (U+2019), so an ASCII literal
    /// would silently compare unequal and the test would pass for the wrong
    /// reason.
    private func jsonParseFailure() throws -> Error {
        do {
            _ = try JSONSerialization.jsonObject(with: Data("not json".utf8))
            Issue.record("expected JSONSerialization to reject this payload")
            throw CancellationError()
        } catch { return error }
    }

    private func decoderFailure() throws -> Error {
        do {
            _ = try JSONDecoder().decode(Shape.self, from: Data("not json".utf8))
            Issue.record("expected JSONDecoder to reject this payload")
            throw CancellationError()
        } catch { return error }
    }

    @Test("transport copy never ships Foundation's unattributed decode text")
    func friendlyMessageAttributesDecodeFailures() throws {
        for error in [try jsonParseFailure(), try decoderFailure()] {
            let copy = TransportErrorCopy.friendlyMessage(for: error, relayUrl: nil)
            // `DecodingError` IS a LocalizedError whose errorDescription is nil,
            // so the `?? ns.localizedDescription` fallback hands the bare string
            // straight through to the banner.
            #expect(copy != (error as NSError).localizedDescription)
            #expect(!copy.contains("correct format"))
            // It must name whose message could not be read...
            #expect(copy.lowercased().contains("mac"))
            // ...and read as a fault rather than a notice.
            #expect(twBannerSeverity(for: copy) == .error)
        }
    }

    @Test("a genuine network error keeps its host-aware guidance")
    func urlErrorsAreUnaffected() {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        let copy = TransportErrorCopy.friendlyMessage(
            for: error, relayUrl: "https://mac.example.ts.net")
        #expect(copy.contains("Tailscale"))
    }

    @Test("Foundation's decode copy classifies as a fault, not a blue notice")
    func decodeCopyIsNotInformational() throws {
        // Defence in depth: any path that still leaks the bare string must at
        // least render red and stay until read.
        #expect(twBannerSeverity(for: (try jsonParseFailure() as NSError).localizedDescription) == .error)
        #expect(twBannerSeverity(for: (try decoderFailure() as NSError).localizedDescription) == .error)
        // The keyNotFound variant reads "...because it is missing."
        #expect(twBannerSeverity(for: "The data couldn\u{2019}t be read because it is missing.") == .error)
        // PairedHostSessionError.invalidResponse wraps decode failures in this
        // phrasing, which trips none of the original keywords either.
        #expect(twBannerSeverity(for: "The Host returned an invalid response: bad kind") == .error)
    }

    @Test("the existing severity vocabulary still classifies as before")
    func establishedSeverityUnchanged() {
        #expect(twBannerSeverity(for: "Denied.") == .error)
        #expect(twBannerSeverity(for: "The run did not dispatch.") == .error)
        #expect(twBannerSeverity(for: "Reconnecting — try Show more again in a moment.") == .warning)
        #expect(twBannerSeverity(for: "Notes saved.") == .success)
        #expect(twBannerSeverity(for: "Added to prompt.") == .info)
    }

    @Test("a superseded banner's timer does not dismiss its replacement")
    func cancelledWaitDoesNotDismiss() {
        // Timer ran to completion: transient feedback fades, faults stay.
        #expect(twBannerShouldAutoDismiss(severity: .info, waitCancelled: false))
        #expect(twBannerShouldAutoDismiss(severity: .success, waitCancelled: false))
        #expect(!twBannerShouldAutoDismiss(severity: .error, waitCancelled: false))
        #expect(!twBannerShouldAutoDismiss(severity: .warning, waitCancelled: false))
        // Cancellation means SUPERSEDED — `.task(id:)` restarted because a
        // DIFFERENT message arrived. `try? await Task.sleep` swallows that, so
        // dismissing on wake erased the banner that had just landed and two
        // banners in quick succession lost the second.
        #expect(!twBannerShouldAutoDismiss(severity: .info, waitCancelled: true))
        #expect(!twBannerShouldAutoDismiss(severity: .success, waitCancelled: true))
    }
}
