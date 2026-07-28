import XCTest
import CoreGraphics
import Darwin
@testable import TaskWraithBridgeDaemon

/// Metadata and lease-state tests. ScreenCaptureKit filters still require a
/// live picker/TCC grant, so the store exposes a filter-free test seam; it
/// exercises the security lifecycle without granting test code screen access.
final class AttachedWindowStoreTests: XCTestCase {
    func testMetaToJSONObjectShape() {
        let receipt = ProcessIdentityReceipt(
            pid: 1234,
            launchTimeMicros: 42,
            source: .procBSDInfo
        )
        let meta = AttachedWindowMeta(
            windowID: 99,
            title: "Hello",
            bundleID: "com.example.app",
            applicationName: "Example",
            pid: 1234,
            identityQuality: .exact,
            processIdentity: receipt,
            pgid: 99,
            bounds: AttachedWindowBounds(x: -12.5, y: 34.25, width: 640.5, height: 480)
        )
        let json = meta.toJSONObject()
        XCTAssertEqual(json["windowID"] as? Int, 99)
        XCTAssertEqual(json["title"] as? String, "Hello")
        XCTAssertEqual(json["bundleID"] as? String, "com.example.app")
        XCTAssertEqual(json["applicationName"] as? String, "Example")
        XCTAssertEqual(json["pid"] as? Int, 1234)
        XCTAssertEqual(json["identityQuality"] as? String, "exact")
        XCTAssertEqual(json["pgid"] as? Int, 99)
        let bounds = json["bounds"] as? [String: Any]
        XCTAssertEqual(bounds?["x"] as? Double, -12.5)
        XCTAssertEqual(bounds?["y"] as? Double, 34.25)
        XCTAssertEqual(bounds?["width"] as? Double, 640.5)
        XCTAssertEqual(bounds?["height"] as? Double, 480)
        XCTAssertEqual(json["processStartedAt"] as? String, "procBSDInfo:42")
        let identity = json["processIdentity"] as? [String: Any]
        XCTAssertEqual(identity?["pid"] as? Int, 1234)
        XCTAssertEqual(identity?["processStartedAt"] as? String, "procBSDInfo:42")
        XCTAssertEqual(json["actuationAuthority"] as? String, "none")
    }

    func testEmptyMetaJSONShapeStillContainsAllKeys() {
        // Window picked from an app that doesn't expose title / bundle id
        // (rare but legal — e.g. background helper processes). We still
        // emit all keys so the renderer pill renders consistently.
        let meta = AttachedWindowMeta(
            windowID: 1,
            title: "",
            bundleID: "",
            applicationName: "",
            pid: 0
        )
        let json = meta.toJSONObject()
        XCTAssertEqual(json["windowID"] as? Int, 1)
        XCTAssertEqual(json["title"] as? String, "")
        XCTAssertEqual(json["bundleID"] as? String, "")
        XCTAssertEqual(json["applicationName"] as? String, "")
        XCTAssertEqual(json["pid"] as? Int, 0)
    }

    func testAttachedWindowErrorDescriptionsAreUserReadable() {
        // Surfaced through JSON-RPC `error.message` and ultimately the
        // renderer toast, so these strings need to read as English.
        XCTAssertEqual(AttachedWindowError.cancelled.errorDescription, "Window pick was cancelled.")
        XCTAssertEqual(AttachedWindowError.noWindowSelected.errorDescription, "Pick must select a single window.")
        XCTAssertEqual(AttachedWindowError.windowGone.errorDescription, "Attached window is no longer available (likely closed).")
        XCTAssertEqual(AttachedWindowError.pngEncodingFailed.errorDescription, "Failed to encode captured frame as PNG.")
        XCTAssertEqual(
            AttachedWindowError.pickerFailed("nope").errorDescription,
            "Window picker failed: nope"
        )
    }

    func testProtectedOwnerResolutionUsesProcessStartReceipt() throws {
        let policy = try currentProtectedOwners()
        guard let receipt = policy.processes.first else {
            return XCTFail("Expected the current test process to resolve")
        }
        XCTAssertEqual(receipt.pid, Int(getpid()))
        XCTAssertTrue(receipt.matchesLiveProcess())
        XCTAssertFalse(receipt.processStartedAt.isEmpty)
        XCTAssertEqual(
            receipt.toJSONObject()["processStartedAt"] as? String,
            receipt.processStartedAt
        )
    }

    func testNewAttachmentRevokesPriorGenerationAndStopsItsStream() async throws {
        let store = AttachedWindowStore()
        let policy = try currentProtectedOwners()
        let scope = AttachedWindowScope(scopeID: "scope-a", chatID: "chat-a", consentEpoch: 1)
        let first = try await store._attachForTesting(
            meta: mockMeta(windowID: 101, pid: 99_001),
            scope: scope,
            protectedOwners: policy
        )

        let stream = AttachedWindowStream()
        await stream._configureForTesting(fps: 5, bufferSeconds: 2, maxDimensionPx: 256)
        try await store._setStreamForTesting(stream, for: first)

        let second = try await store._attachForTesting(
            meta: mockMeta(windowID: 102, pid: 99_002),
            scope: AttachedWindowScope(scopeID: "scope-a", chatID: "chat-a", consentEpoch: 2),
            protectedOwners: policy
        )

        XCTAssertGreaterThan(second.generation, first.generation)
        do {
            _ = try await store.authorize(first.access)
            XCTFail("Replaced lease must not remain usable")
        } catch let error as AttachmentAuthorizationError {
            guard case .revoked = error else {
                return XCTFail("Expected revoked error, got \(error)")
            }
        }
        let status = await stream.status()
        XCTAssertEqual(status.frameCapacity, 0, "Replacing attachment stops the prior stream")
    }

    func testDifferentChatIsDeniedInsteadOfDiscoveringActiveLease() async throws {
        let store = AttachedWindowStore()
        let policy = try currentProtectedOwners()
        let lease = try await store._attachForTesting(
            meta: mockMeta(windowID: 103, pid: 99_003),
            scope: AttachedWindowScope(scopeID: "scope-a", chatID: "chat-a", consentEpoch: 1),
            protectedOwners: policy
        )
        let wrongScope = AttachedWindowAccess(
            handleID: lease.handleID,
            scope: AttachedWindowScope(scopeID: "scope-b", chatID: "chat-b", consentEpoch: 1),
            generation: lease.generation
        )

        do {
            _ = try await store.authorize(wrongScope)
            XCTFail("A different chat must not use the attachment")
        } catch let error as AttachmentAuthorizationError {
            guard case .denied = error else {
                return XCTFail("Expected denied error, got \(error)")
            }
        }
    }

    func testMismatchedHandleOrGenerationIsRevokedWithoutDisclosingLiveLease() async throws {
        let store = AttachedWindowStore()
        let policy = try currentProtectedOwners()
        let lease = try await store._attachForTesting(
            meta: mockMeta(windowID: 103, pid: 99_003),
            scope: AttachedWindowScope(scopeID: "scope-a", chatID: "chat-a", consentEpoch: 1),
            protectedOwners: policy
        )
        let staleAccesses = [
            AttachedWindowAccess(
                handleID: "different-handle",
                scope: lease.scope,
                generation: lease.generation
            ),
            AttachedWindowAccess(
                handleID: lease.handleID,
                scope: lease.scope,
                generation: lease.generation + 1
            )
        ]

        for staleAccess in staleAccesses {
            do {
                _ = try await store.authorize(staleAccess)
                XCTFail("Mismatched scoped access must not resolve the live attachment")
            } catch let error as AttachmentAuthorizationError {
                guard case .revoked = error else {
                    return XCTFail("Expected revoked error, got \(error)")
                }
            }
        }
    }

    func testProtectedWindowIsRefusedBeforeItReplacesExistingAttachment() async throws {
        let store = AttachedWindowStore()
        let policy = try currentProtectedOwners()
        let existing = try await store._attachForTesting(
            meta: mockMeta(windowID: 104, pid: 99_004),
            scope: AttachedWindowScope(scopeID: "scope-a", chatID: "chat-a", consentEpoch: 1),
            protectedOwners: policy
        )
        let protectedPID = try XCTUnwrap(policy.processes.first?.pid)

        do {
            _ = try await store._attachForTesting(
                meta: mockMeta(windowID: 105, pid: protectedPID),
                scope: AttachedWindowScope(scopeID: "scope-a", chatID: "chat-a", consentEpoch: 2),
                protectedOwners: policy
            )
            XCTFail("Protected host selection must be denied")
        } catch let error as AttachmentAuthorizationError {
            guard case .denied = error else {
                return XCTFail("Expected denied error, got \(error)")
            }
        }

        _ = try await store.authorize(existing.access)
    }

    func testShutdownRevokesActiveLeaseAndRejectsLatePickerPublication() async throws {
        let store = AttachedWindowStore()
        let policy = try currentProtectedOwners()
        let scope = AttachedWindowScope(scopeID: "scope-a", chatID: "chat-a", consentEpoch: 1)
        let lease = try await store._attachForTesting(
            meta: mockMeta(windowID: 106, pid: 99_006),
            scope: scope,
            protectedOwners: policy
        )

        await store.shutdown()
        let countAfterShutdown = await store.count()
        XCTAssertEqual(countAfterShutdown, 0)

        do {
            _ = try await store.authorize(lease.access)
            XCTFail("Shutdown must revoke the active lease")
        } catch let error as AttachmentAuthorizationError {
            guard case .revoked = error else {
                return XCTFail("Expected revoked error, got \(error)")
            }
        }

        do {
            try await store.beginPicker(
                scope: AttachedWindowScope(scopeID: "scope-b", chatID: "chat-b", consentEpoch: 2)
            )
            XCTFail("Shutdown must reject a new picker")
        } catch let error as AttachmentAuthorizationError {
            guard case .revoked = error else {
                return XCTFail("Expected revoked error, got \(error)")
            }
        }

        do {
            _ = try await store._attachForTesting(
                meta: mockMeta(windowID: 107, pid: 99_007),
                scope: AttachedWindowScope(scopeID: "scope-b", chatID: "chat-b", consentEpoch: 2),
                protectedOwners: policy
            )
            XCTFail("A picker result arriving after shutdown must not publish a lease")
        } catch let error as AttachmentAuthorizationError {
            guard case .revoked = error else {
                return XCTFail("Expected revoked error, got \(error)")
            }
        }
    }

    private func currentProtectedOwners() throws -> ResolvedProtectedWindowOwners {
        return try ProtectedWindowOwners(pids: [Int(getpid())]).resolve()
    }

    private func mockMeta(windowID: CGWindowID, pid: Int) -> AttachedWindowMeta {
        return AttachedWindowMeta(
            windowID: windowID,
            title: "Test",
            bundleID: "com.example.test",
            applicationName: "Test",
            pid: pid
        )
    }
}
