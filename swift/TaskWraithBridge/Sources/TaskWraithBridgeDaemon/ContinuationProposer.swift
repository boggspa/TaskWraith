import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// The deliberately text-free protocol used for on-device continuation
/// ranking. `id` is a host-generated opaque token; `kind` is a fixed enum.
/// Neither user prompts nor run/agent telemetry cross this boundary.
struct ContinuationProposalCandidateParam: Decodable {
    let id: String
    let kind: String
}

struct ContinuationProposalParams: Decodable {
    let checkpointId: String
    let phase: String
    let roundState: String
    let candidates: [ContinuationProposalCandidateParam]
}

enum ContinuationProposer {
    static func propose(_ params: Any) throws -> [String: Any] {
        let request: ContinuationProposalParams
        do {
            request = try decodeParams(params, as: ContinuationProposalParams.self)
        } catch {
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: "Invalid continuation proposal params: \(error.localizedDescription)"
            )
        }

        try validate(request)

        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            return try FoundationModelsContinuationProposer.propose(request)
        }
        #endif

        throw JSONRPCError(
            code: JSONRPCErrorCode.bridgeUnavailable,
            message: "Apple Foundation Models are unavailable on this host or SDK."
        )
    }

    private static func validate(_ request: ContinuationProposalParams) throws {
        guard isSafeIdentifier(request.checkpointId) else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: "Continuation checkpoint id is invalid."
            )
        }
        guard ["none", "working", "blocked"].contains(request.phase) else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: "Continuation phase is invalid."
            )
        }
        guard ["none", "completed", "partial-success", "all-failed"].contains(request.roundState) else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: "Continuation round state is invalid."
            )
        }
        guard !request.candidates.isEmpty, request.candidates.count <= 8 else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.invalidParams,
                message: "Continuation proposal requires one to eight candidates."
            )
        }

        let allowedKinds: Set<String> = [
            "picker-dismissed",
            "task-continuation",
            "lane-failed",
            "uncommitted-changes"
        ]
        var ids = Set<String>()
        for candidate in request.candidates {
            guard isSafeIdentifier(candidate.id), allowedKinds.contains(candidate.kind) else {
                throw JSONRPCError(
                    code: JSONRPCErrorCode.invalidParams,
                    message: "Continuation candidate is invalid."
                )
            }
            guard ids.insert(candidate.id).inserted else {
                throw JSONRPCError(
                    code: JSONRPCErrorCode.invalidParams,
                    message: "Continuation candidate ids must be unique."
                )
            }
        }
    }

    private static func isSafeIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 180 else { return false }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._,:")
            .union(CharacterSet(charactersIn: "-"))
        return value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

#if canImport(FoundationModels)
@available(macOS 26.0, *)
private enum FoundationModelsContinuationProposer {
    static func propose(_ request: ContinuationProposalParams) throws -> [String: Any] {
        let candidateId = try runBlocking {
            try await proposeAsync(request)
        }
        return [
            "candidateId": candidateId,
            "model": "Apple Foundation Models"
        ]
    }

    private static func proposeAsync(_ request: ContinuationProposalParams) async throws -> String {
        let model = SystemLanguageModel.default
        guard case .available = model.availability else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.bridgeUnavailable,
                message: "Apple Foundation Models are not available: \(model.availability)"
            )
        }

        let session = LanguageModelSession(
            instructions: """
            You rank TaskWraith's host-approved composer candidates. You never
            receive a transcript, user prompt, tool output, telemetry, agent
            prose, or candidate display text. Choose the one opaque candidate
            ID that best fits the supplied phase, round state, and fixed
            candidate kinds. Output exactly one ID from the allowed list, with
            no punctuation, explanation, markdown, or new identifier. When
            every seat failed, favor a lane-failed candidate; when work is
            still progressing or partially succeeded, favor a
            task-continuation candidate when present.
            """
        )
        let prompt = buildPrompt(from: request)
        let response = try await session.respond(to: prompt)
        let candidateId = String(describing: response.content)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard request.candidates.contains(where: { $0.id == candidateId }) else {
            throw JSONRPCError(
                code: JSONRPCErrorCode.bridgeUnavailable,
                message: "Foundation Models returned an unknown continuation candidate."
            )
        }
        return candidateId
    }

    /// The model sees only enum values and opaque IDs. This is intentionally
    /// not marked as telemetry: it contains no user- or agent-authored prose
    /// capable of injecting an instruction into the selection prompt.
    private static func buildPrompt(from request: ContinuationProposalParams) -> String {
        let candidates = request.candidates
            .map { "- \($0.id) [\($0.kind)]" }
            .joined(separator: "\n")
        return """
        Phase: \(request.phase)
        Round state: \(request.roundState)
        Allowed candidates:
        \(candidates)
        Return one allowed candidate ID only.
        """
    }
}
#endif
