import Foundation

/// Read-only host request. documentRevision is captured from the native
/// session's observed journal revision, independently of expectedRevision.
public struct StudioResourceQueryRequest: Sendable, Equatable {
    public let id: Int
    public let nonce: String
    public let expectedRevision: Int
    public let documentRevision: Int

    public init(id: Int, nonce: String, expectedRevision: Int, documentRevision: Int) {
        self.id = id
        self.nonce = nonce
        self.expectedRevision = expectedRevision
        self.documentRevision = documentRevision
    }

    static func decode(_ message: StudioMessage, documentRevision: Int?) -> StudioResourceQueryRequest? {
        let maximum = 9_007_199_254_740_991
        guard message.jsonrpc == "2.0", let id = message.id,
            id >= -maximum, id <= maximum,
            message.result == nil, message.error == nil,
            let params = message.params,
            let schema = params["schemaVersion"]?.value as? Int, schema == 1,
            let expected = params["expectedRevision"]?.value as? Int,
            expected >= 0, expected <= maximum,
            let nonce = params["nonce"]?.value as? String,
            nonce.utf8.count == 48,
            nonce.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
            let documentRevision, documentRevision >= 0, documentRevision <= maximum
        else { return nil }
        return Self(id: id, nonce: nonce, expectedRevision: expected, documentRevision: documentRevision)
    }

    public static func errorLine(id: Int?, invalid: Bool = false, reason: String) -> Data {
        let payload: [String: Any] = [
            "jsonrpc": "2.0", "id": id.map { $0 as Any } ?? NSNull(),
            "error": [
                "code": invalid ? -32602 : 4011,
                "message": String(reason.prefix(256)),
                "data": ["studioCode": invalid ? "invalid_params" : "resource_snapshot_unavailable"],
            ],
        ]
        var data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data()
        data.append(0x0A)
        return data
    }
}
