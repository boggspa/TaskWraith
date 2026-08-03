import Foundation
import TaskWraithKit

/// Converts optional trust-aware wire summaries into the closed presentation
/// models used by the native Peer and People cards.
///
/// Presence of a structured summary is itself the containment signal. Unknown
/// enum values therefore choose conservative defaults (plain-text peer agent,
/// queued delivery; delivered People contribution with no draft action) instead
/// of falling back to generic Tools/System markdown rendering.
enum TrustAwareTranscriptRowAdapter {
    static func peerInput(
        for row: RemoteThreadSnapshot.Row
    ) -> PeerMessageCardInput? {
        guard let summary = row.threadMessage else { return nil }
        return PeerMessageCardInput(
            id: summary.threadMessageId ?? row.id,
            fromChatId: summary.fromChatId ?? "",
            fromChatTitle: summary.fromChatTitle ?? "",
            origin: summary.origin == "user" ? .user : .agent,
            body: row.preview ?? "",
            requestedDelivery: summary.requestedDelivery == "wake" ? .wake : .queue,
            createdAt: timestampMilliseconds(row.timestamp),
            truncated: summary.truncated == true || row.truncated == true
        )
    }

    static func peopleInput(
        for row: RemoteThreadSnapshot.Row
    ) -> PeopleContributionCardInput? {
        guard let summary = row.peopleContribution else { return nil }
        let delivery: PeopleContributionDelivery =
            summary.delivery == "queuedComment"
            ? .queuedComment
            : .deliveredExternalSeat
        return PeopleContributionCardInput(
            messageId: row.id,
            collaboratorDisplayName: summary.collaboratorDisplayName ?? "",
            body: row.preview ?? "",
            delivery: delivery,
            intent: summary.intent == "requestHostAction" ? .requestHostAction : .comment,
            outOfPosition: summary.outOfPosition == true,
            insertedAsDraft: summary.insertedAsDraft == true,
            truncated: row.truncated == true
        )
    }

    static func peopleModel(
        for row: RemoteThreadSnapshot.Row
    ) -> PeopleContributionCardModel? {
        peopleInput(for: row).map(peopleContributionCardModel)
    }

    private static func timestampMilliseconds(_ raw: String?) -> Double {
        guard let raw else { return 0 }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        return (date?.timeIntervalSince1970 ?? 0) * 1_000
    }
}
