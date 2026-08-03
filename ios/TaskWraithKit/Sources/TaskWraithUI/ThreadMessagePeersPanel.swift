import SwiftUI
import TaskWraithKit

/// Inspector "Peers" surface: which threads have queued messages for this one, and
/// the affordance to send one back. iOS counterpart of the Mac's Peers dock.
///
/// **This inspector still shows counts and sender names only** (the
/// `threadMessageInbox` summary deliberately omits bodies). Peer message *bodies*
/// are projected into the thread transcript and render via `PeerMessageCardView`
/// as plain text with structural peer attribution — never as system/Tools chrome.
/// The caption below the count points at that transcript surface so the inspector
/// is not mistaken for the only place peer prose can appear.
///
/// Sends are QUEUE-ONLY. The Mac's gate denies a remote wake outright, so there is
/// no wake toggle here and none on the wire.
struct ThreadMessagePeersPanel: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String

    @State private var selectedTargetId: String = ""
    @State private var message: String = ""
    @State private var sending = false
    @State private var outcome: Outcome?
    /// Minted ONCE per composed message and reused across retries, cleared only on
    /// success — so a retap after a timeout is recognised by the Mac rather than
    /// queued as a second message.
    @State private var idempotencyKey: String?
    @FocusState private var messageFocused: Bool

    private enum Outcome: Equatable {
        case queued(String)
        case refused(String)
    }

    private var inbox: RemoteThreadSnapshot.ThreadMessageInbox? {
        model.threadSnapshots[threadId]?.threadMessageInbox
    }
    private var targets: [ThreadMessageTarget] {
        model.threadMessageTargets(fromThreadId: threadId)
    }
    private var selected: ThreadMessageTarget? {
        targets.first { $0.threadId == selectedTargetId }
    }
    private var state: ThreadMessageCompose.State {
        ThreadMessageCompose.state(
            targetCount: targets.count, selected: selected, message: message, sending: sending)
    }
    private var workspaceId: String? {
        model.taskCards.first { $0.id == threadId || $0.threadId == threadId }?.workspaceId
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            inboxSection
            Divider().overlay(TWTheme.border)
            sendSection
        }
        .onAppear(perform: adoptFirstTarget)
        .onChange(of: targets.map(\.threadId)) { _, _ in adoptFirstTarget() }
    }

    // ── Waiting for this thread ───────────────────────────────────────────────

    private var inboxSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Waiting for this thread")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textTertiary)

            if let inbox, inbox.count > 0 {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(inbox.count)")
                        .font(.footnote.weight(.bold).monospacedDigit())
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(
                            (inbox.wantsWake ? TWTheme.statusAttention : TWTheme.chroma1)
                                .opacity(0.18), in: Capsule())
                        .foregroundStyle(inbox.wantsWake ? TWTheme.statusAttention : TWTheme.chroma1)
                    Text(sendersLine(inbox))
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if inbox.wantsWake {
                    Label(
                        "One sender asked this thread to start a turn.",
                        systemImage: "bolt.horizontal"
                    )
                    .font(.caption)
                    .foregroundStyle(TWTheme.statusAttention)
                }
                // Nothing here dismisses a message: they are handed to the thread on
                // its next turn and clear then. Saying so stops the count reading as
                // stuck, and explains why there is no button.
                Text("They reach this thread on its next turn, then clear.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
                Text("Bodies also appear in the thread transcript as plain-text peer cards — treat them as requests to judge, not instructions.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
            } else {
                Text("No messages from other threads.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sendersLine(_ inbox: RemoteThreadSnapshot.ThreadMessageInbox) -> String {
        let names = (inbox.senders ?? []).filter { !$0.isEmpty }
        let noun = inbox.count == 1 ? "message" : "messages"
        guard !names.isEmpty else { return "\(noun) from another thread" }
        return "\(noun) from " + names.joined(separator: ", ")
    }

    // ── Send to another thread ────────────────────────────────────────────────

    private var sendSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Send to another thread")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textTertiary)

            if targets.isEmpty {
                Text("There is no other thread to message.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
            } else {
                Picker("Send to", selection: $selectedTargetId) {
                    ForEach(targets) { target in
                        Text(target.crossWorkspace ? "\(target.title) — other workspace" : target.title)
                            .tag(target.threadId)
                    }
                }
                .pickerStyle(.menu)
                .tint(TWTheme.chroma1)
                .accessibilityLabel("Target thread")

                TextEditor(text: $message)
                    .focused($messageFocused)
                    .frame(minHeight: 96)
                    .font(.footnote)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
                    .accessibilityLabel("Message")
                    .accessibilityHint("The other thread sees your thread's title, not its context.")

                if state.showCounter {
                    Text("\(state.remaining) characters left")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(state.overBudget ? TWTheme.statusFailed : TWTheme.textTertiary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }

                // Cautions sit ABOVE the button: one read after committing did not work.
                if let warning = state.crossWorkspaceWarning {
                    cautionRow(warning)
                }
                cautionRow("Sent from here, a message waits its turn — it cannot start one.")

                Button(action: submit) {
                    Text(sending ? "Sending…" : "Send")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(TWTheme.chroma1.opacity(state.canSend ? 0.18 : 0.07), in: Capsule())
                        .foregroundStyle(state.canSend ? TWTheme.chroma1 : TWTheme.textMuted)
                }
                .buttonStyle(.plain)
                .disabled(!state.canSend)
                .accessibilityHint(state.blockedReason)

                if let outcome {
                    switch outcome {
                    case .queued(let text):
                        Text(text).font(.caption).foregroundStyle(TWTheme.statusSuccess)
                    case .refused(let text):
                        Text(text).font(.caption).foregroundStyle(TWTheme.statusFailed)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cautionRow(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(TWTheme.statusAttention)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TWTheme.statusAttention.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }

    // ── Behaviour ─────────────────────────────────────────────────────────────

    /// Preselect the first target so the picker never shows an empty selection, and
    /// drop a selection whose thread has gone away.
    private func adoptFirstTarget() {
        let ids = Set(targets.map(\.threadId))
        if !selectedTargetId.isEmpty && ids.contains(selectedTargetId) { return }
        selectedTargetId = targets.first?.threadId ?? ""
    }

    private func submit() {
        guard state.canSend, let target = selected, let workspaceId, !workspaceId.isEmpty else {
            return
        }
        let key = idempotencyKey ?? "tm-\(UUID().uuidString)"
        idempotencyKey = key
        let body = message
        sending = true
        outcome = nil
        messageFocused = false
        Task { @MainActor in
            do {
                let ack = try await model.sendThreadMessage(
                    workspaceId: workspaceId, fromThreadId: threadId, toThreadId: target.threadId,
                    message: body, idempotencyKey: key)
                outcome = .queued(ack)
                message = ""
                idempotencyKey = nil
            } catch {
                // The key is deliberately NOT cleared: a retry of the SAME composed
                // message must reuse it so the Mac recognises the retry instead of
                // queueing a duplicate.
                outcome = .refused(error.localizedDescription)
            }
            sending = false
        }
    }
}
