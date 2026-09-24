import AppKit
import Metal
import XCTest

@testable import TaskWraithStudioCompanion
@testable import TaskWraithStudioCore

@MainActor
final class StudioResourceQueryTests: XCTestCase {
    private let nonce = String(repeating: "a", count: 48)

    private func line(_ object: [String: Any]) throws -> Data {
        var result = try JSONSerialization.data(withJSONObject: object)
        result.append(0x0A)
        return result
    }

    private func query(id: Int = -1, revision: Int = 4, params: [String: Any]? = nil) throws -> Data {
        try line([
            "jsonrpc": "2.0", "id": id, "method": "studio/getResourceSnapshot",
            "params": params ?? ["schemaVersion": 1, "nonce": nonce, "expectedRevision": revision],
        ])
    }

    private func hydratedSession() throws -> StudioCompanionSession {
        let session = StudioCompanionSession()
        _ = session.consume(chunk: try line(["jsonrpc": "2.0", "id": 1, "result": ["protocolVersion": 1]]))
        _ = session.consume(chunk: try line([
            "jsonrpc": "2.0", "id": 2,
            "result": ["revision": 4, "document": [
                "formatVersion": 3, "assets": [], "tracks": [], "proposals": [], "transcripts": [],
                "effectPreview": NSNull(),
            ]],
        ]))
        return session
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testNegativeRequestIDAndNativeObservedRevisionSurviveTheActualDecoder() throws {
        let session = try hydratedSession()
        let step = session.consume(chunk: try query(revision: 99))
        XCTAssertEqual(step.resourceQueries, [StudioResourceQueryRequest(
            id: -1, nonce: nonce, expectedRevision: 99, documentRevision: 4
        )])
        XCTAssertTrue(step.outboundLines.isEmpty)
        XCTAssertEqual(session.documentRevision, 4)
        XCTAssertEqual(session.editCommittedCount, 0)
    }

    func testMalformedOrUnsupportedParamsReturnExplicitErrorWithoutAQuery() throws {
        let malformed: [[String: Any]] = [
            ["schemaVersion": 2, "nonce": nonce, "expectedRevision": 4],
            ["schemaVersion": true, "nonce": nonce, "expectedRevision": 4],
            ["schemaVersion": 1, "nonce": nonce, "expectedRevision": true],
            ["schemaVersion": 1, "nonce": nonce, "expectedRevision": -1],
            ["schemaVersion": 1, "nonce": nonce, "expectedRevision": 9_007_199_254_740_992],
            ["schemaVersion": 1, "nonce": "short", "expectedRevision": 4],
            ["schemaVersion": 1, "nonce": String(repeating: "G", count: 48), "expectedRevision": 4],
            [:],
        ]
        let session = try hydratedSession()
        for params in malformed {
            let step = session.consume(chunk: try query(params: params))
            XCTAssertTrue(step.resourceQueries.isEmpty, "\(params)")
            let error = try XCTUnwrap(try object(XCTUnwrap(step.outboundLines.first))["error"] as? [String: Any])
            XCTAssertEqual(error["code"] as? Int, -32602)
        }
    }

    func testUnhydratedQueryIsUnavailableAndDoesNotStartHydration() throws {
        let session = StudioCompanionSession()
        let step = session.consume(chunk: try query())
        XCTAssertTrue(step.resourceQueries.isEmpty)
        XCTAssertEqual(step.outboundLines.count, 1)
        let error = try XCTUnwrap(try object(XCTUnwrap(step.outboundLines.first))["error"] as? [String: Any])
        let data = try XCTUnwrap(error["data"] as? [String: Any])
        XCTAssertEqual(data["studioCode"] as? String, "resource_snapshot_unavailable")
        XCTAssertNil(session.documentRevision)
    }

    func testFragmentedInterleavedWireReadKeepsEachQueryBehindItsPriorRevision() throws {
        let session = try hydratedSession()
        var cursor = StudioCompanionStdioPump.HydrationCursor()
        _ = StudioCompanionStdioPump.consume(chunk: Data(), session: session, hydration: &cursor)
        func edit(_ revision: Int) throws -> Data {
            try line(["jsonrpc": "2.0", "method": "studio/editCommitted", "params": [
                "revision": revision, "op": ["type": "open_media", "asset": [
                    "assetId": "frame-é-\(revision)", "path": "/unused.mov", "mediaKind": "video",
                ]],
            ]])
        }
        let bytes = try edit(5) + query(id: -1, revision: 5) + edit(6) + query(id: -2, revision: 6)
        let split = try XCTUnwrap(bytes.firstIndex(of: 0xC3)) + 1
        let first = StudioCompanionStdioPump.consumeOrdered(chunk: bytes.prefix(split), session: session, hydration: &cursor)
        let second = StudioCompanionStdioPump.consumeOrdered(chunk: bytes.suffix(from: split), session: session, hydration: &cursor)
        let updates = first + second
        let observed = updates.flatMap(\.step.resourceQueries)
        XCTAssertEqual(observed.map(\.documentRevision), [5, 6])
        XCTAssertEqual(observed.map(\.expectedRevision), [5, 6])
        XCTAssertEqual(updates.filter { !$0.step.resourceQueries.isEmpty }.map(\.latestRevision), [5, 6])
        XCTAssertEqual(updates.flatMap(\.step.openedAssets).map(\.assetId), ["frame-é-5", "frame-é-6"])
        XCTAssertEqual(session.editCommittedCount, 2)
    }

    func testAnExitWithinAReadStopsLaterWireMessages() throws {
        let session = StudioCompanionSession()
        var cursor = StudioCompanionStdioPump.HydrationCursor()
        let bytes = try line(["jsonrpc": "2.0", "id": 1, "error": ["code": -1, "message": "refused"]]) + query()
        let updates = StudioCompanionStdioPump.consumeOrdered(chunk: bytes, session: session, hydration: &cursor)
        XCTAssertEqual(updates.count, 1)
        XCTAssertEqual(updates.first?.step.exitCode, 2)
        XCTAssertTrue(updates.flatMap(\.step.resourceQueries).isEmpty)
    }

    func testRetainedWorkspaceGetterIsPureAndKeepsItsProcessAndWindowIdentityAfterClose() throws {
        _ = NSApplication.shared
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        let source = try StudioViewerRenderer(device: device)
        let review = try StudioViewerRenderer(device: device)
        let authority = StudioPlaybackAuthority(clock: StudioPlaybackClock(timebase: .ntsc2997, durationTicks: 300))
        let workspace = StudioWorkspaceWindowController(sourceRenderer: source, reviewRenderer: review, authority: authority)
        var presentations = 0
        let state = StudioViewerAppState(
            controller: workspace.sourceController, renderer: source,
            reviewController: workspace.reviewController, workspaceController: workspace,
            presentSource: { presentations += 1 }
        )
        let request = StudioResourceQueryRequest(id: -1, nonce: nonce, expectedRevision: 4, documentRevision: 4)
        func sample() throws -> [String: Any] {
            try XCTUnwrap(try object(state.resourceSnapshotResponse(to: request))["result"] as? [String: Any])
        }
        let before = try sample()
        XCTAssertFalse(workspace.window.isVisible)
        workspace.window.close()
        let closed = try sample()
        XCTAssertEqual(before["processInstanceId"] as? String, closed["processInstanceId"] as? String)
        XCTAssertEqual(closed["processPid"] as? Int, Int(ProcessInfo.processInfo.processIdentifier))
        XCTAssertGreaterThan(try XCTUnwrap(closed["sampleSequence"] as? Int), try XCTUnwrap(before["sampleSequence"] as? Int))
        XCTAssertGreaterThan(try XCTUnwrap(closed["monotonicMs"] as? Double), try XCTUnwrap(before["monotonicMs"] as? Double))
        let oldWorkspace = try XCTUnwrap(before["workspace"] as? [String: Any])
        let newWorkspace = try XCTUnwrap(closed["workspace"] as? [String: Any])
        XCTAssertEqual(oldWorkspace["windowIdentity"] as? String, newWorkspace["windowIdentity"] as? String)
        XCTAssertEqual(newWorkspace["windowVisible"] as? Bool, false)
        XCTAssertEqual(newWorkspace["sourcePresentationAttached"] as? Bool, false)
        XCTAssertEqual(newWorkspace["reviewPresentationAttached"] as? Bool, false)
        XCTAssertEqual(presentations, 0)
        XCTAssertEqual(before["activity"] as? [String: Int], closed["activity"] as? [String: Int])
        let resources = try XCTUnwrap(closed["resources"] as? [String: Any])
        let caches = try XCTUnwrap(resources["persistentCaches"] as? [String: Int])
        XCTAssertGreaterThan(caches["overlayAtlasTextures"]!, 0, "closed retained renderers still own their fixed caches")
        let stale = StudioResourceQueryRequest(id: -2, nonce: nonce, expectedRevision: 5, documentRevision: 4)
        XCTAssertNotNil(try object(state.resourceSnapshotResponse(to: stale))["error"])
        XCTAssertEqual(presentations, 0)
    }
}
