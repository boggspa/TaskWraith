import SwiftUI
import TaskWraithKit

/// One shared 1 Hz clock for approval auto-deny countdowns so N visible cards
/// do not each drive their own TimelineView timer.
@MainActor
final class TWApprovalCountdownTicker: ObservableObject {
    static let shared = TWApprovalCountdownTicker()

    @Published private(set) var now = Date()
    private var task: Task<Void, Never>?
    private var retainCount = 0

    private init() {}

    func retain() {
        retainCount += 1
        guard task == nil else { return }
        task = Task { @MainActor in
            while !Task.isCancelled {
                now = Date()
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    func release() {
        retainCount = max(0, retainCount - 1)
        guard retainCount == 0 else { return }
        task?.cancel()
        task = nil
    }
}

/// Approval card row — Electron approval-card parity within phone idiom:
/// provider accent, title + body (the command/params detail the Mac
/// sanitizes to 400 chars), requested-at caption, and the FULL decision
/// set the executor implements: Allow once (primary), Allow for
/// session / Allow in workspace (menu), Deny, Cancel run (overflow).
/// Tap the content for a detail sheet with the untruncated layout.
struct ApprovalRow: View {
    @ObservedObject var model: RemoteSessionModel
    let card: MobileApprovalCard
    @ObservedObject private var countdownTicker = TWApprovalCountdownTicker.shared
    @State private var showDetail = false
    /// Discrete decision haptic trigger (user-initiated only).
    @State private var decisionHapticTick = 0
    @State private var decisionHaptic: SensoryFeedback = MotionHaptics.success

    private var accent: Color { TWTheme.providerAccent(card.provider) }
    private var approvalActions: [ApprovalActionDescriptor] {
        ApprovalActionDescriptor.visibleActions(from: card.actions)
    }
    private var primaryAction: ApprovalActionDescriptor? {
        approvalActions.first { $0.prominent } ?? approvalActions.first
    }
    private var menuActions: [ApprovalActionDescriptor] {
        approvalActions.filter { $0.id != primaryAction?.id && !$0.destructive }
    }
    private var destructiveActions: [ApprovalActionDescriptor] {
        approvalActions.filter { $0.id != primaryAction?.id && $0.destructive }
    }

    private var bodyLooksTechnical: Bool {
        let text = card.body ?? ""
        return text.contains("{") || text.contains("/") || text.contains("$")
    }

    private var requestedCaption: String? {
        guard let requestedAt = card.requestedAt,
            let date = twParseISODate(requestedAt)
        else { return nil }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        return "\(seconds / 3600)h ago"
    }

    /// Live auto-deny countdown — `expiresAt` is the Mac's ARMED timer
    /// deadline (per-provider Settings → Providers timeout), so what this
    /// counts down is exactly when the desktop will force a decline.
    private func expiresCaption(now: Date) -> (text: String, urgent: Bool)? {
        guard let expiresAt = card.expiresAt, let date = twParseISODate(expiresAt)
        else { return nil }
        let seconds = Int(date.timeIntervalSince(now))
        guard seconds > 0 else { return ("auto-denied", true) }
        if seconds < 60 { return ("auto-denies in \(seconds)s", seconds <= 15) }
        return ("auto-denies in \(seconds / 60)m", false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button {
                showDetail = true
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Circle().fill(accent).frame(width: 7, height: 7)
                        Text(card.title ?? "Approval requested")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TWTheme.textPrimary)
                            .lineLimit(2)
                        Spacer(minLength: 4)
                        if let expiry = expiresCaption(now: countdownTicker.now) {
                            Text(expiry.text)
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(
                                    expiry.urgent
                                        ? TWTheme.statusFailed : TWTheme.statusAttention)
                        } else if let requestedCaption {
                            Text(requestedCaption)
                                .font(.caption2)
                                .foregroundStyle(TWTheme.textMuted)
                        }
                    }
                    if let body = card.body, !body.isEmpty {
                        Text(body)
                            .font(
                                bodyLooksTechnical
                                    ? .system(size: 12, design: .monospaced) : .footnote
                            )
                            .foregroundStyle(TWTheme.textSecondary)
                            .lineLimit(3)
                    } else if let summary = card.summary {
                        Text(summary)
                            .font(.footnote)
                            .foregroundStyle(TWTheme.textSecondary)
                            .lineLimit(3)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            HStack(spacing: 7) {
                if let primaryAction {
                    primaryDecisionButton(primaryAction)
                }
                if !menuActions.isEmpty {
                    Menu {
                        ForEach(menuActions) { action in
                            Button {
                                fireDecision(action)
                            } label: {
                                Label(action.detailLabel, systemImage: action.icon)
                            }
                        }
                    } label: {
                        HStack(spacing: 2) {
                            Text("More…")
                            Image(systemName: "chevron.down")
                                .font(.system(size: 8, weight: .semibold))
                        }
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(accent.opacity(0.14), in: Capsule())
                        .foregroundStyle(accent)
                    }
                }
                Spacer(minLength: 0)
                if !destructiveActions.isEmpty {
                    Menu {
                        ForEach(destructiveActions) { action in
                            Button(role: .destructive) {
                                fireDecision(action)
                            } label: {
                                Label(action.detailLabel, systemImage: action.icon)
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.caption)
                            .foregroundStyle(TWTheme.textTertiary)
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("More approval actions")
                    .accessibilityHint("Includes denial and cancellation actions.")
                }
            }
        }
        .padding(.vertical, 2)
        .onAppear { countdownTicker.retain() }
        .onDisappear { countdownTicker.release() }
        .background {
            if let expiresAt = card.expiresAt {
                ApprovalExpiryAnnouncer(expiresAt: expiresAt)
            }
        }
        .motionHaptic(decisionHaptic, trigger: decisionHapticTick)
        .sheet(isPresented: $showDetail) {
            ApprovalDetailSheet(model: model, card: card)
                .twSheetLiquidGlass(detents: [.medium, .large])
        }
    }

    private func fireDecision(_ action: ApprovalActionDescriptor) {
        decisionHaptic = MotionHaptics.forApproval(destructive: action.destructive)
        decisionHapticTick += 1
        model.approve(card, decision: action.id)
    }

    @ViewBuilder
    private func primaryDecisionButton(_ action: ApprovalActionDescriptor) -> some View {
        if action.prominent {
            Button(action.rowLabel) { fireDecision(action) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .tint(action.destructive ? TWTheme.statusFailed : accent)
        } else {
            Button(action.rowLabel) { fireDecision(action) }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(action.destructive ? TWTheme.statusFailed : accent)
        }
    }
}

/// Full-screen detail for an approval — the Electron modal's content
/// (untruncated body, provider, timestamps) with the same decision set.
struct ApprovalDetailSheet: View {
    @ObservedObject var model: RemoteSessionModel
    let card: MobileApprovalCard
    @Environment(\.dismiss) private var dismiss
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted
    @State private var decisionHapticTick = 0
    @State private var decisionHaptic: SensoryFeedback = MotionHaptics.success

    private var accent: Color { TWTheme.providerAccent(card.provider) }
    private var approvalActions: [ApprovalActionDescriptor] {
        ApprovalActionDescriptor.visibleActions(from: card.actions)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        Circle().fill(accent).frame(width: 8, height: 8)
                        Text(TWTheme.providerLabel(card.provider))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(accent)
                        Spacer()
                        if let requestedAt = card.requestedAt,
                            let date = twParseISODate(requestedAt)
                        {
                            Text(date, style: .time)
                                .font(.caption2)
                                .foregroundStyle(TWTheme.textMuted)
                        }
                    }
                    Text(card.title ?? "Approval requested")
                        .font(.headline)
                        .foregroundStyle(TWTheme.textPrimary)
                    if let body = card.body, !body.isEmpty {
                        Text(body)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(TWTheme.textSecondary)
                            .textSelection(.enabled)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
                    }
                    VStack(spacing: 8) {
                        ForEach(approvalActions) { action in
                            decisionButton(action)
                        }
                    }
                    .padding(.top, 4)
                }
                .padding(16)
            }
            .background(glassSheetHosted ? Color.clear : TWTheme.appBg)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) {
                    TWPrincipalTitle(title: "Approval", subtitle: TWTheme.providerLabel(card.provider))
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .twColorScheme()
        .motionHaptic(decisionHaptic, trigger: decisionHapticTick)
    }

    @ViewBuilder
    private func decisionButton(_ action: ApprovalActionDescriptor) -> some View {
        Button {
            decisionHaptic = MotionHaptics.forApproval(destructive: action.destructive)
            decisionHapticTick += 1
            model.approve(card, decision: action.id)
            dismiss()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: action.icon)
                Text(action.detailLabel).font(.body.weight(.semibold))
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(
                action.prominent
                    ? AnyShapeStyle(accent)
                    : action.destructive
                        ? AnyShapeStyle(TWTheme.statusFailed.opacity(0.14))
                        : AnyShapeStyle(TWTheme.surface2),
                in: RoundedRectangle(cornerRadius: 12)
            )
            .foregroundStyle(
                action.prominent
                    ? Color.black.opacity(0.85)
                    : action.destructive ? TWTheme.statusFailed : TWTheme.textPrimary)
        }
        .buttonStyle(.plain)
    }
}

struct ApprovalActionDescriptor: Identifiable, Equatable {
    let id: String
    let rowLabel: String
    let detailLabel: String
    let icon: String
    let prominent: Bool
    let destructive: Bool

    static func visibleActions(from rawActions: [String]?) -> [ApprovalActionDescriptor] {
        let source = rawActions?.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? [
            "accept", "decline",
        ]
        var seen = Set<String>()
        return source.compactMap { raw in
            let id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, !seen.contains(id) else { return nil }
            seen.insert(id)
            return descriptor(for: id)
        }
    }

    private static func descriptor(for id: String) -> ApprovalActionDescriptor {
        switch id {
        case "accept":
            return ApprovalActionDescriptor(
                id: id, rowLabel: "Allow once", detailLabel: "Allow once",
                icon: "checkmark.circle.fill", prominent: true, destructive: false)
        case "acceptForSession":
            return ApprovalActionDescriptor(
                id: id, rowLabel: "Session", detailLabel: "Allow for session",
                icon: "clock.badge.checkmark", prominent: false, destructive: false)
        case "acceptForWorkspace":
            return ApprovalActionDescriptor(
                id: id, rowLabel: "Workspace", detailLabel: "Allow in workspace",
                icon: "folder.badge.plus", prominent: false, destructive: false)
        case "useProviderNative":
            return ApprovalActionDescriptor(
                id: id, rowLabel: "Provider", detailLabel: "Use provider native flow",
                icon: "arrow.triangle.branch", prominent: true, destructive: false)
        case "useTaskWraithSubthread":
            return ApprovalActionDescriptor(
                id: id, rowLabel: "Sub-thread", detailLabel: "Use TaskWraith sub-thread",
                icon: "arrowshape.turn.up.right", prominent: false, destructive: false)
        case "decline":
            return ApprovalActionDescriptor(
                id: id, rowLabel: "Deny", detailLabel: "Deny",
                icon: "xmark.circle", prominent: false, destructive: true)
        case "cancel":
            return ApprovalActionDescriptor(
                id: id, rowLabel: "Cancel", detailLabel: "Cancel run",
                icon: "stop.circle", prominent: false, destructive: true)
        default:
            return ApprovalActionDescriptor(
                id: id, rowLabel: Self.humanize(id), detailLabel: Self.humanize(id),
                icon: "checkmark.circle", prominent: false, destructive: false)
        }
    }

    private static func humanize(_ raw: String) -> String {
        let spaced = raw.reduce(into: "") { result, char in
            if char.isUppercase && !result.isEmpty { result.append(" ") }
            result.append(char)
        }
        return spaced
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .capitalized
    }
}

/// Question card row — canonical promptId/question fields, option chips,
/// free-text answer when the thread explicitly grants it, expiry countdown,
/// and Dismiss (questionReject → parked tool cancelled).
struct QuestionRow: View {
    @ObservedObject var model: RemoteSessionModel
    let card: MobileQuestionCard
    @State private var freeText = ""

    private var expiresCaption: String? {
        guard let expiresAt = card.expiresAt, let date = twParseISODate(expiresAt)
        else { return nil }
        let seconds = Int(date.timeIntervalSince(Date()))
        guard seconds > 0 else { return "expired" }
        if seconds < 60 { return "expires in \(seconds)s" }
        return "expires in \(seconds / 60)m"
    }

    private var canAnswer: Bool {
        Self.canAnswerQuestion(threadId: card.threadId, taskCards: model.taskCards)
    }

    static func canAnswerQuestion(threadId: String?, taskCards: [RemoteTaskCard]) -> Bool {
        guard let threadId, !threadId.isEmpty else { return false }
        let task = taskCards.first { $0.id == threadId || $0.threadId == threadId }
        return task?.capabilities?.answer == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(card.resolvedQuestion ?? "Question")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 4)
                if let expiresCaption {
                    Text(expiresCaption)
                        .font(.caption2)
                        .foregroundStyle(
                            expiresCaption == "expired"
                                ? TWTheme.statusFailed : TWTheme.textMuted)
                }
            }
            if let context = card.context, !context.isEmpty {
                Text(context)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
                    .lineLimit(3)
            }
            if let options = card.options, !options.isEmpty {
                TWFlowLayout(spacing: 6) {
                    ForEach(options, id: \.self) { option in
                        Button(option) { model.answer(card, option) }
                            .font(.caption.weight(.medium))
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(!canAnswer)
                    }
                }
            }
            HStack(spacing: 7) {
                TextField("Your answer…", text: $freeText)
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textPrimary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(TWTheme.surface2, in: Capsule())
                    .disabled(!canAnswer)
                    .accessibilityLabel("Your answer")
                    .accessibilityValue(canAnswer ? freeText : "Viewing only")
                Button {
                    model.answer(card, freeText)
                    freeText = ""
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title3)
                        .foregroundStyle(
                            freeText.isEmpty ? TWTheme.textMuted : TWTheme.chroma1)
                }
                .buttonStyle(.plain)
                .disabled(freeText.isEmpty || !canAnswer)
                .accessibilityLabel("Submit answer")
                .accessibilityHint(
                    freeText.isEmpty || !canAnswer ? "Enter an answer first." : "")
                Button {
                    model.rejectQuestion(card)
                } label: {
                    Image(systemName: "xmark.circle")
                        .font(.title3)
                        .foregroundStyle(TWTheme.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss question")
            }
            if !canAnswer {
                Text("Waiting for thread permissions from your Mac.")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Posts VoiceOver announcements when an approval countdown becomes urgent or expires.
private struct ApprovalExpiryAnnouncer: View {
    let expiresAt: String
    @ObservedObject private var countdownTicker = TWApprovalCountdownTicker.shared
    @State private var announcedUrgent = false
    @State private var announcedExpired = false

    var body: some View {
        ApprovalExpiryTick(
            expiresAt: expiresAt,
            now: countdownTicker.now,
            announcedUrgent: $announcedUrgent,
            announcedExpired: $announcedExpired
        )
        .accessibilityHidden(true)
        .onAppear { countdownTicker.retain() }
        .onDisappear { countdownTicker.release() }
    }
}

private struct ApprovalExpiryTick: View {
    let expiresAt: String
    let now: Date
    @Binding var announcedUrgent: Bool
    @Binding var announcedExpired: Bool

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .onAppear { evaluate() }
            .onChange(of: now) { _, _ in evaluate() }
    }

    private func evaluate() {
        guard let date = twParseISODate(expiresAt) else { return }
        let seconds = Int(date.timeIntervalSince(now))
        if seconds <= 0 {
            guard !announcedExpired else { return }
            announcedExpired = true
            AccessibilityNotification.Announcement("Approval auto-denied").post()
        } else if seconds <= 15, !announcedUrgent {
            announcedUrgent = true
            AccessibilityNotification.Announcement("Approval auto-denies in \(seconds) seconds")
                .post()
        }
    }
}
