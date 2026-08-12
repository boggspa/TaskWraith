import Foundation
import TaskWraithKit

struct PairedHostCommandDraft: Equatable {
  let name: HostCommandName
  let target: [String: String]
  let arguments: [String: HostJSONAny]
}

enum PairedHostActionRoute: Equatable {
  case host(PairedHostCommandDraft)
  case legacy
}

enum PairedHostActionRouting {
  static func commandsAvailable(
    phase: PairedHostProjectionPhase,
    capabilities: [HostCapability]?
  ) -> Bool {
    guard phase == .live, let capabilities else { return false }
    return capabilities.contains(.commands) && capabilities.contains(.receipts)
  }

  static func approval(
    approvalId: String,
    decision: String,
    commandsAvailable: Bool
  ) -> PairedHostActionRoute {
    guard commandsAvailable, !approvalId.isEmpty,
      ["accept", "acceptForSession", "acceptForWorkspace", "decline", "cancel"]
        .contains(decision)
    else { return .legacy }
    return .host(
      PairedHostCommandDraft(
        name: .approvalDecide,
        target: ["approvalId": approvalId],
        arguments: ["decision": .string(decision)]))
  }

  static func questionAnswer(
    questionId: String,
    answer: String,
    isCustom: Bool,
    commandsAvailable: Bool
  ) -> PairedHostActionRoute {
    guard commandsAvailable, !questionId.isEmpty,
      !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return .legacy }
    return .host(
      PairedHostCommandDraft(
        name: .questionAnswer,
        target: ["questionId": questionId],
        arguments: [
          "decision": .string("answer"),
          "answer": .string(answer),
          "isCustom": .bool(isCustom),
        ]))
  }

  static func questionDismiss(
    questionId: String,
    commandsAvailable: Bool
  ) -> PairedHostActionRoute {
    guard commandsAvailable, !questionId.isEmpty
    else { return .legacy }
    return .host(
      PairedHostCommandDraft(
        name: .questionAnswer,
        target: ["questionId": questionId],
        arguments: ["decision": .string("dismiss")]))
  }

  static func runCancel(
    threadId: String,
    commandsAvailable: Bool
  ) -> PairedHostActionRoute {
    guard commandsAvailable, !threadId.isEmpty else { return .legacy }
    return .host(
      PairedHostCommandDraft(
        name: .runCancel,
        target: ["threadId": threadId],
        arguments: [:]))
  }

  static func composerSend(
    threadId: String,
    text: String,
    model: String?,
    reasoningEffort: String?,
    hasUnsupportedArguments: Bool,
    commandsAvailable: Bool
  ) -> PairedHostActionRoute {
    guard commandsAvailable, !hasUnsupportedArguments, !threadId.isEmpty,
      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { return .legacy }
    var arguments: [String: HostJSONAny] = ["text": .string(text)]
    if let model, !model.isEmpty { arguments["model"] = .string(model) }
    if let reasoningEffort, !reasoningEffort.isEmpty {
      arguments["reasoningEffort"] = .string(reasoningEffort)
    }
    return .host(
      PairedHostCommandDraft(
        name: .composerSend,
        target: ["threadId": threadId],
        arguments: arguments))
  }

  /// The Host has durably accepted responsibility for this command. Pending is
  /// intentionally included so optimistic UI is not rolled back while the
  /// matching approval is open; it is not a terminal success.
  static func acceptedForProcessing(_ receipt: HostCommandReceipt) -> Bool {
    receipt.status == .succeeded || receipt.status == .pending
  }

  static func succeeded(_ receipt: HostCommandReceipt) -> Bool {
    receipt.status == .succeeded
  }

  static func isTerminal(_ receipt: HostCommandReceipt) -> Bool {
    receipt.status != .pending
  }

  static func alreadyResolvedApproval(_ receipt: HostCommandReceipt) -> Bool {
    receipt.errorCode == "approval_already_resolved"
  }

  static func message(
    for receipt: HostCommandReceipt,
    success: String
  ) -> String {
    switch receipt.status {
    case .succeeded: return success
    case .pending: return "Awaiting Host approval."
    case .failed, .denied, .cancelled, .indeterminate, .conflict:
      return receipt.errorMessage ?? receipt.resultSummary
        ?? "Host \(receipt.status.rawValue) the action."
    }
  }
}
