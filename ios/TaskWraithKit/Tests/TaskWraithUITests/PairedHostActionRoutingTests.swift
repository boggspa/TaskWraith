import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

@Suite("Paired Host action routing")
struct PairedHostActionRoutingTests {
  @Test("Host routing requires a live command and receipt capability pair")
  func capabilityGate() {
    #expect(
      PairedHostActionRouting.commandsAvailable(
        phase: .live,
        capabilities: [.commands, .receipts]))
    #expect(
      !PairedHostActionRouting.commandsAvailable(
        phase: .reconnecting,
        capabilities: [.commands, .receipts]))
    #expect(
      !PairedHostActionRouting.commandsAvailable(
        phase: .live,
        capabilities: [.commands]))
  }

  @Test("matching attention cards compose exact governed Host commands")
  func attentionCommands() throws {
    let approval = try #require(
      hostDraft(
        PairedHostActionRouting.approval(
          approvalId: "approval-1",
          decision: "acceptForSession",
          commandsAvailable: true)))
    #expect(approval.name == .approvalDecide)
    #expect(approval.target == ["approvalId": "approval-1"])
    #expect(approval.arguments == ["decision": .string("acceptForSession")])

    let answer = try #require(
      hostDraft(
        PairedHostActionRouting.questionAnswer(
          questionId: "question-1",
          answer: "Ship it",
          isCustom: true,
          commandsAvailable: true)))
    #expect(answer.name == .questionAnswer)
    #expect(answer.target == ["questionId": "question-1"])
    #expect(
      answer.arguments == [
        "decision": .string("answer"),
        "answer": .string("Ship it"),
        "isCustom": .bool(true),
      ])

    let dismiss = try #require(
      hostDraft(
        PairedHostActionRouting.questionDismiss(
          questionId: "question-1",
          commandsAvailable: true)))
    #expect(dismiss.arguments == ["decision": .string("dismiss")])
  }

  @Test("legacy fallback is chosen only before a Host-capable dispatch")
  func compatibilityFallback() {
    #expect(
      PairedHostActionRouting.approval(
        approvalId: "legacy-only",
        decision: "accept",
        commandsAvailable: false) == .legacy)
    #expect(
      PairedHostActionRouting.questionAnswer(
        questionId: "legacy-only",
        answer: "Yes",
        isCustom: false,
        commandsAvailable: false) == .legacy)
    #expect(
      PairedHostActionRouting.runCancel(
        threadId: "thread-1",
        commandsAvailable: false) == .legacy)
    #expect(
      PairedHostActionRouting.composerSend(
        threadId: "thread-1",
        text: "Hello",
        model: nil,
        reasoningEffort: nil,
        hasUnsupportedArguments: true,
        commandsAvailable: true) == .legacy)
  }

  @Test("plain composer turns retain supported model controls on Host v2")
  func composerCommand() throws {
    let draft = try #require(
      hostDraft(
        PairedHostActionRouting.composerSend(
          threadId: "thread-1",
          text: "Continue",
          model: "gpt-5.6",
          reasoningEffort: "high",
          hasUnsupportedArguments: false,
          commandsAvailable: true)))

    #expect(draft.name == .composerSend)
    #expect(draft.target == ["threadId": "thread-1"])
    #expect(
      draft.arguments == [
        "text": .string("Continue"),
        "model": .string("gpt-5.6"),
        "reasoningEffort": .string("high"),
      ])
  }

  @Test("receipt semantics distinguish processing, terminal success, and failure")
  func receiptSemantics() {
    let succeeded = receipt(status: .succeeded)
    let pending = receipt(status: .pending)
    let failed = receipt(status: .failed)
    #expect(PairedHostActionRouting.acceptedForProcessing(succeeded))
    #expect(PairedHostActionRouting.succeeded(succeeded))
    #expect(PairedHostActionRouting.isTerminal(succeeded))
    #expect(PairedHostActionRouting.acceptedForProcessing(pending))
    #expect(!PairedHostActionRouting.succeeded(pending))
    #expect(!PairedHostActionRouting.isTerminal(pending))
    #expect(!PairedHostActionRouting.acceptedForProcessing(failed))
    #expect(!PairedHostActionRouting.succeeded(failed))
    #expect(PairedHostActionRouting.isTerminal(failed))
    #expect(
      PairedHostActionRouting.alreadyResolvedApproval(
        receipt(status: .failed, errorCode: "approval_already_resolved")))
    #expect(
      PairedHostActionRouting.message(
        for: pending,
        success: "Sent") == "Awaiting Host approval.")
  }

  private func hostDraft(_ route: PairedHostActionRoute) -> PairedHostCommandDraft? {
    guard case .host(let draft) = route else { return nil }
    return draft
  }

  private func receipt(
    status: HostReceiptStatus,
    errorCode: String? = nil
  ) -> HostCommandReceipt {
    HostCommandReceipt(
      commandId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      name: .questionAnswer,
      actor: HostActorIdentity(
        actorId: "iphone-test",
        clientId: "iphone-test",
        clientClass: .ios),
      authority: HostAuthorityDecision(decision: .allow),
      status: status,
      commandFingerprint: String(repeating: "a", count: 64),
      generation: 2,
      cursor: 3,
      createdAt: "2026-08-09T20:00:00Z",
      updatedAt: "2026-08-09T20:00:01Z",
      errorCode: errorCode)
  }
}
