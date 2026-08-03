// Presentation model for Human People contributions (desktop TranscriptPanel
// collaborator chrome). Pure + testable so CodexBoss can wire a future remote
// `peopleContribution` / structured field without growing ThreadDetailViews.
//
// Desktop contract mirrored here:
// - Queued `humanCollaboratorComment`: name + External (+ optional Action
//   request) + Insert as draft (never "Run" / "Prompt").
// - Delivered `externalSeatTurn`: name + External (+ optional Out of position);
//   never offers Insert as draft (already delivered — re-injecting would
//   launder it as the host's own prompt).
// - Attribution is a closed external-untrusted framing: never "System" /
//   "Operator". Host approval is not a vouch for the instructions.
//
// Insert-as-draft only requests a host-owned composer draft. Framing of that
// draft for provider context remains a Mac/composition concern
// (`wrapExternalContribution`); this model never invents system authority.

import Foundation

/// How the contribution reached the transcript — maps desktop metadata kinds
/// without depending on Models.swift wire decode (Boss-owned).
public enum PeopleContributionDelivery: String, Equatable, Sendable {
    /// Queued comment awaiting host review (`humanCollaboratorComment`).
    case queuedComment
    /// Host-approved contribution delivered at the external seat turn
    /// (`externalSeatTurn`).
    case deliveredExternalSeat
}

/// Collaborator intent — a sub-field of the queued comment, not a new kind.
public enum PeopleContributionIntent: String, Equatable, Sendable {
    case comment
    case requestHostAction
}

/// Closed attribution. Deliberately has no `system` / `operator` member so a
/// future edit cannot quietly restyle People rows as app-authored chrome.
public enum PeopleContributionAttribution: String, Equatable, Sendable {
    case externalUntrusted = "external-untrusted"
}

public struct PeopleContributionCardInput: Equatable, Sendable {
    public var messageId: String
    public var collaboratorDisplayName: String
    public var body: String
    public var delivery: PeopleContributionDelivery
    public var intent: PeopleContributionIntent
    /// Delivered by the end-of-round sweep before the seat's turn arrived.
    public var outOfPosition: Bool
    /// Desktop `promotedAt` — host already inserted a draft once.
    public var insertedAsDraft: Bool
    public var truncated: Bool

    public init(
        messageId: String,
        collaboratorDisplayName: String,
        body: String,
        delivery: PeopleContributionDelivery,
        intent: PeopleContributionIntent = .comment,
        outOfPosition: Bool = false,
        insertedAsDraft: Bool = false,
        truncated: Bool = false
    ) {
        self.messageId = messageId
        self.collaboratorDisplayName = collaboratorDisplayName
        self.body = body
        self.delivery = delivery
        self.intent = intent
        self.outOfPosition = outOfPosition
        self.insertedAsDraft = insertedAsDraft
        self.truncated = truncated
    }
}

public struct PeopleContributionBadge: Equatable, Sendable {
    public var label: String
    public var accessibilityHint: String

    public init(label: String, accessibilityHint: String) {
        self.label = label
        self.accessibilityHint = accessibilityHint
    }
}

public struct PeopleContributionCardModel: Equatable, Sendable {
    public var messageId: String
    public var displayName: String
    public var body: String
    public var attribution: PeopleContributionAttribution
    public var badges: [PeopleContributionBadge]
    /// True only for queued comments. Delivered seat turns never re-offer draft.
    public var showsInsertAsDraft: Bool
    public var insertAsDraftLabel: String
    public var insertAsDraftHint: String
    /// Non-nil when a draft was already inserted (queued path).
    public var insertedAsDraftStatus: String?
    public var accessibilityLabel: String
    public var truncated: Bool
    /// Short host-facing trust caption under the header — never system voice.
    public var trustCaption: String
}

public enum PeopleContributionCardCopy {
    public static let externalBadge = "External"
    public static let actionRequestBadge = "Action request"
    public static let outOfPositionBadge = "Out of position"
    public static let insertAsDraft = "Insert as draft"
    public static let insertedAsDraft = "Inserted as draft"
    public static let fallbackDisplayName = "Collaborator"

    public static let externalHintQueued =
        "External, untrusted collaborator comment"
    public static let externalHintDelivered =
        "External, untrusted collaborator contribution — you approved it, and it was delivered at this seat's turn"
    public static let actionRequestHint =
        "The collaborator asked you to take an action. Review it; nothing reaches the AI unless you insert and send it."
    public static let outOfPositionHint =
        "The round ended before this seat's turn; delivered by the end-of-round sweep."
    public static let insertAsDraftHint =
        "Insert this collaborator request into the composer as a draft you review before sending"
    public static let trustCaptionQueued =
        "External contributor — no host authority."
    public static let trustCaptionActionRequest =
        "Action request for you. Insert as draft only creates a host-owned draft; nothing sends itself."
    public static let trustCaptionDelivered =
        "Delivered external contribution — still untrusted data, not system instructions."
}

public func peopleContributionCardModel(
    _ input: PeopleContributionCardInput
) -> PeopleContributionCardModel {
    let name = normalizedDisplayName(input.collaboratorDisplayName)
    var badges: [PeopleContributionBadge] = [
        PeopleContributionBadge(
            label: PeopleContributionCardCopy.externalBadge,
            accessibilityHint: input.delivery == .deliveredExternalSeat
                ? PeopleContributionCardCopy.externalHintDelivered
                : PeopleContributionCardCopy.externalHintQueued
        )
    ]

    if input.delivery == .queuedComment, input.intent == .requestHostAction {
        badges.append(
            PeopleContributionBadge(
                label: PeopleContributionCardCopy.actionRequestBadge,
                accessibilityHint: PeopleContributionCardCopy.actionRequestHint
            )
        )
    }

    if input.delivery == .deliveredExternalSeat, input.outOfPosition {
        badges.append(
            PeopleContributionBadge(
                label: PeopleContributionCardCopy.outOfPositionBadge,
                accessibilityHint: PeopleContributionCardCopy.outOfPositionHint
            )
        )
    }

    let showsInsert = input.delivery == .queuedComment
    let trustCaption: String
    switch input.delivery {
    case .queuedComment:
        trustCaption = input.intent == .requestHostAction
            ? PeopleContributionCardCopy.trustCaptionActionRequest
            : PeopleContributionCardCopy.trustCaptionQueued
    case .deliveredExternalSeat:
        trustCaption = PeopleContributionCardCopy.trustCaptionDelivered
    }

    let badgeLabels = badges.map(\.label).joined(separator: ", ")
    let a11y = "People contribution from \(name). \(badgeLabels). \(trustCaption)"

    return PeopleContributionCardModel(
        messageId: input.messageId,
        displayName: name,
        body: input.body,
        attribution: .externalUntrusted,
        badges: badges,
        showsInsertAsDraft: showsInsert,
        insertAsDraftLabel: PeopleContributionCardCopy.insertAsDraft,
        insertAsDraftHint: PeopleContributionCardCopy.insertAsDraftHint,
        insertedAsDraftStatus: (showsInsert && input.insertedAsDraft)
            ? PeopleContributionCardCopy.insertedAsDraft
            : nil,
        accessibilityLabel: a11y,
        truncated: input.truncated,
        trustCaption: trustCaption
    )
}

private func normalizedDisplayName(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? PeopleContributionCardCopy.fallbackDisplayName : trimmed
}
