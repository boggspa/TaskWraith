import Foundation

public enum OfflineComposerSendDecision: Equatable {
    case sendNormally
    case queueText(String)
    case refuseAttachments
}

/// Decides whether one composer submission can enter the durable text outbox.
/// Attachments are deliberately refused while offline: the current outbox does
/// not persist their bytes, so accepting them would silently split one user
/// send into queued text plus an image left behind in the composer.
public enum OfflineComposerSendPolicy {
    public static func decide(
        shouldQueue: Bool,
        threadId: String,
        text: String,
        attachmentCount: Int
    ) -> OfflineComposerSendDecision {
        guard shouldQueue else { return .sendNormally }
        guard attachmentCount == 0 else { return .refuseAttachments }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !threadId.isEmpty, !trimmed.isEmpty else { return .sendNormally }
        return .queueText(trimmed)
    }
}
