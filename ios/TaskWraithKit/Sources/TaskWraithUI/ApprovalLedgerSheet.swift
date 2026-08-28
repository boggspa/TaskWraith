// Approval ledger — the read-only audit list ("why did this auto-deny at
// 02:14?"). Desktop's ApprovalLedgerPanel carries filters and JSON export;
// the phone ships the read: newest decisions first, decision + source +
// scope, provider-tinted. Rows are the Mac's BOUNDED projection — no
// params/preview payloads ever reach this device.

import SwiftUI
import TaskWraithKit

struct ApprovalLedgerSheet: View {
    @ObservedObject var model: RemoteSessionModel
    let workspaceId: String
    var threadId: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    @State private var entries: [ApprovalLedgerEntry] = []
    @State private var loading = true
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let loadError {
                    VStack(spacing: 6) {
                        Text("Ledger unavailable")
                            .font(.subheadline.weight(.semibold))
                        Text(loadError)
                            .font(.caption)
                            .foregroundStyle(TWTheme.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if entries.isEmpty {
                    Text("No recorded approval decisions yet.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(entries, id: \.resolvedId) { entry in
                        row(entry)
                            .twGlassSheetRowBackground()
                    }
                    .twGlassSheetListCanvas()
                }
            }
            .background(glassSheetHosted ? Color.clear : TWTheme.appBg)
            .navigationTitle("Approval ledger")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            entries = try await model.fetchApprovalLedger(
                workspaceId: workspaceId, threadId: threadId, limit: 100)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func row(_ entry: ApprovalLedgerEntry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Circle()
                    .fill(decisionTint(entry))
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
                Text(entry.title ?? entry.method ?? "Approval")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: 4)
                if let provider = entry.provider {
                    Text(TWTheme.providerLabel(provider))
                        .font(.caption2)
                        .foregroundStyle(TWTheme.providerAccent(provider))
                }
            }
            HStack(spacing: 5) {
                Text(decisionLabel(entry))
                    .foregroundStyle(decisionTint(entry))
                if let source = entry.decisionSource, !source.isEmpty {
                    Text("· \(source)")
                }
                if let scope = entry.grantedScope, !scope.isEmpty {
                    Text("· \(scope)")
                }
                Spacer(minLength: 4)
                if let stamp = entry.respondedAt ?? entry.requestedAt,
                    let caption = TWTranscriptTimestampFormat.footerCaption(iso: stamp)
                {
                    Text(caption).monospacedDigit()
                }
            }
            .font(.caption2)
            .foregroundStyle(TWTheme.textSecondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func decisionLabel(_ entry: ApprovalLedgerEntry) -> String {
        switch entry.decision {
        case "accept": return "Accepted"
        case "acceptForSession": return "Accepted for session"
        case "acceptForWorkspace": return "Accepted for workspace"
        case "decline": return "Declined"
        case "cancel": return "Cancelled"
        case "autoAllow": return "Auto-allowed"
        case "autoDeny": return "Auto-denied"
        case "expired": return "Expired"
        case let other?: return other
        case nil: return entry.status?.capitalized ?? "Pending"
        }
    }

    private func decisionTint(_ entry: ApprovalLedgerEntry) -> Color {
        switch entry.decision {
        case "accept", "acceptForSession", "acceptForWorkspace", "autoAllow":
            return TWTheme.statusSuccess
        case "decline", "autoDeny", "expired", "cancel":
            return TWTheme.statusFailed
        default:
            return TWTheme.statusAttention
        }
    }
}
