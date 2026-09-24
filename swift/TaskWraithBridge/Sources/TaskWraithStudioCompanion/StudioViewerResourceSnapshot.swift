import AppKit
import TaskWraithStudioCore

/// One process identity and sample sequence; one retained workspace identity.
/// This observes owners after preceding adoption tasks have settled. It never
/// shows a window, renders, loads media, or changes playback/cache state.
@MainActor
final class StudioViewerResourceSnapshotResponder {
    private static let processInstanceId = UUID().uuidString
    private static var sampleSequence = 0
    private static var lastMonotonicMs = -1.0
    let windowIdentity = UUID().uuidString

    func response(
        to request: StudioResourceQueryRequest,
        window: NSWindow,
        sourcePresentationAttached: Bool,
        reviewPresentationAttached: Bool,
        sourceAssetId: String?,
        reviewAssetId: String?,
        sequenceAssetIds: [String]
    ) -> Data {
        do {
            guard request.expectedRevision == request.documentRevision,
                Self.sampleSequence < 9_007_199_254_740_991,
                sequenceAssetIds.count <= 2048,
                Set(sequenceAssetIds).count == sequenceAssetIds.count,
                (sequenceAssetIds + [sourceAssetId, reviewAssetId].compactMap { $0 }).allSatisfy({
                    !$0.isEmpty && $0.utf8.count <= 256
                })
            else { throw SnapshotError.unavailable }
            let observed = try StudioResourceDiagnostics.snapshot()
            let monotonicMs = ProcessInfo.processInfo.systemUptime * 1000
            guard monotonicMs.isFinite, monotonicMs > Self.lastMonotonicMs,
                observed.ioSurfaceIds.count <= 2048
            else { throw SnapshotError.unavailable }
            var video: [String: Any] = observed.video.mapValues { $0 }
            video["ioSurfaceIds"] = observed.ioSurfaceIds
            let number = window.windowNumber
            let result: [String: Any] = [
                "schemaVersion": 1, "nonce": request.nonce,
                "processPid": Int(ProcessInfo.processInfo.processIdentifier),
                "processInstanceId": Self.processInstanceId,
                "sampleSequence": Self.sampleSequence + 1, "monotonicMs": monotonicMs,
                "documentRevision": request.documentRevision,
                "workspace": [
                    "windowIdentity": windowIdentity,
                    "windowNumber": number > 0 ? number as Any : NSNull(),
                    "windowVisible": window.isVisible,
                    "sourcePresentationAttached": sourcePresentationAttached,
                    "reviewPresentationAttached": reviewPresentationAttached,
                ],
                "assets": [
                    "sourceAssetId": sourceAssetId.map { $0 as Any } ?? NSNull(),
                    "reviewAssetId": reviewAssetId.map { $0 as Any } ?? NSNull(),
                    "sequenceAssetIds": sequenceAssetIds,
                ],
                "resources": [
                    "video": video, "audio": observed.audio,
                    "persistentCaches": observed.persistentCaches,
                ],
                "activity": observed.activity,
                "coverage": [
                    "resources": "application-owned",
                    "frameworkInternalCaches": "opaque", "gpuDriverRetentions": "opaque",
                ],
            ]
            var data = try JSONSerialization.data(withJSONObject: [
                "jsonrpc": "2.0", "id": request.id, "result": result,
            ], options: [.sortedKeys])
            guard data.count <= 64 * 1024 else { throw SnapshotError.unavailable }
            Self.sampleSequence += 1
            Self.lastMonotonicMs = monotonicMs
            data.append(0x0A)
            return data
        } catch {
            return StudioResourceQueryRequest.errorLine(
                id: request.id, reason: "Resource owners could not provide a complete, current, bounded observation."
            )
        }
    }

    private enum SnapshotError: Error { case unavailable }
}
