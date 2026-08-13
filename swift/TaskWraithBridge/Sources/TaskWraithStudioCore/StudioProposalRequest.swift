import Foundation

/// Companion-originated `studio/proposeEdit`, encoded to the normative contract.
///
/// THE POINT OF THIS FILE IS THE METHOD NAME. A trim gesture emits
/// studio/proposeEdit — never studio/applyEdit. The host owns durable state and
/// already implements proposal-first insertion with stale-base CAS; a drag that
/// applied directly would bypass the ghost/approve flow entirely, and since the
/// drag is the only gesture that would ever exercise that flow, bypassing it
/// there means the flow is never used at all.
///
/// StudioProtocol.ts stays NORMATIVE: schemaVersion, baseRevision, proposalId
/// and the op shape all come from it. Nothing here re-derives the wire format.
public enum StudioProposalRequest {
    /// Ids used by the companion's outbound requests. hello is 1 and
    /// getDocument is 2, so proposals start above them and never collide.
    public static let firstProposalRequestId = 100

    /// Encodes one NDJSON request line.
    ///
    /// - Parameter baseRevision: the revision the operator was LOOKING AT. The
    ///   host rejects a stale base rather than rebasing silently, which is what
    ///   makes a concurrent edit surface as a conflict instead of quietly
    ///   overwriting someone.
    public static func proposeEdit(
        intent: StudioTrimIntent,
        baseRevision: Int,
        proposalId: String,
        itemId: String,
        requestId: Int,
        timebase: StudioTimebase
    ) -> Data {
        let timescale = Int(timebase.timescale)
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": requestId,
            "method": "studio/proposeEdit",
            "params": [
                "schemaVersion": StudioEditProposal.schemaVersion,
                "baseRevision": baseRevision,
                "proposalId": proposalId,
                "op": [
                    "type": "insert_range",
                    "itemId": itemId,
                    "assetId": intent.assetId,
                    "sourceIn": ["n": intent.sourceInTicks, "d": timescale],
                    "sourceOut": ["n": intent.sourceOutTicks, "d": timescale],
                    "at": ["n": intent.atTicks, "d": timescale],
                ],
            ],
        ]
        var data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
        data.append(0x0A)
        return data
    }

    /// Encodes studio/resolveProposal.
    ///
    /// Shape is taken from the NORMATIVE src/main/studio/StudioProtocol.ts
    /// (StudioResolveProposalParams): schemaVersion, baseRevision, proposalId,
    /// decision. Swift conforms to the host contract, never the reverse.
    ///
    /// The companion does NOT clear its own ghost on send. The host owns the
    /// document; the ghost clears when the resulting editCommitted arrives, so
    /// a rejected-by-stale-base resolve cannot leave the viewer showing an
    /// outcome that never happened.
    public static func resolveProposal(
        proposalId: String,
        accept: Bool,
        baseRevision: Int,
        requestId: Int
    ) -> Data {
        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": requestId,
            "method": "studio/resolveProposal",
            "params": [
                "schemaVersion": StudioEditProposal.schemaVersion,
                "baseRevision": baseRevision,
                "proposalId": proposalId,
                "decision": accept ? "accept" : "reject",
            ],
        ]
        var data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
        data.append(0x0A)
        return data
    }
}
