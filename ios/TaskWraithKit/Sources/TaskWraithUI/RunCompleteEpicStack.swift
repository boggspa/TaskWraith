import SwiftUI
import TaskWraithKit

/// Desktop `RunCompleteEpicStack` twin — Participants → File changes → Commits
/// inside the Task-complete card. Seat attribution uses `TWSeatStrip`; status
/// uses `TWParticipantStatusIcon` (not letter pills). Rows share one solid
/// surface (no zebra).
struct RunCompleteEpicStack<FileChanges: View>: View {
    let participantTable: RemoteThreadSnapshot.Row.CloseoutParticipantTable?
    let commits: [RemoteThreadSnapshot.Row.CloseoutCommit]?
    var subThreads: [RemoteThreadSnapshot.Row.CloseoutSubThread]? = nil
    @ViewBuilder var fileChanges: () -> FileChanges

    /// Matches desktop CLOSEOUT_COMMIT_TABLE_LIMIT / Mac projection cap.
    private var commitLimit: Int { 8 }
    /// Display cap for Sub-threads rows; the wire already bounds at 24.
    private var subThreadLimit: Int { 8 }

    private var participantRows: [RemoteThreadSnapshot.Row.CloseoutParticipantTable.CloseoutParticipantRow] {
        participantTable?.rows ?? []
    }

    private var commitRows: [RemoteThreadSnapshot.Row.CloseoutCommit] {
        Array((commits ?? []).prefix(commitLimit))
    }

    private var commitOverflow: Int {
        max(0, (commits?.count ?? 0) - commitRows.count)
    }

    private var hasParticipants: Bool { !participantRows.isEmpty }
    private var hasCommits: Bool { !commitRows.isEmpty }

    private var subThreadRows: [RemoteThreadSnapshot.Row.CloseoutSubThread] {
        Array((subThreads ?? []).prefix(subThreadLimit))
    }

    private var subThreadOverflow: Int {
        max(0, (subThreads?.count ?? 0) - subThreadRows.count)
    }

    private var hasSubThreads: Bool { !subThreadRows.isEmpty }

    var body: some View {
        if hasParticipants || hasCommits || hasSubThreads {
            VStack(spacing: 8) {
                if hasParticipants {
                    participantsCard
                }
                // Desktop order: Participants → Sub-threads → File changes →
                // Commits.
                if hasSubThreads {
                    subThreadsCard
                }
                fileChanges()
                if hasCommits {
                    commitsCard
                }
            }
        } else {
            fileChanges()
        }
    }

    private var subThreadsCard: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Sub-threads")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
                Text("\(subThreads?.count ?? 0) sub-thread\((subThreads?.count ?? 0) == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            epicHeader(left: "Agent", right: "Route & Status")

            ForEach(subThreadRows) { row in
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.title?.isEmpty == false ? (row.title ?? "") : "Sub-thread")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(TWTheme.textPrimary)
                            .lineLimit(1)
                        if let provider = row.provider, !provider.isEmpty {
                            Text(TWTheme.providerLabel(provider))
                                .font(.caption2)
                                .foregroundStyle(TWTheme.providerAccent(provider))
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    HStack(spacing: 5) {
                        if let parent = row.parentProvider, !parent.isEmpty,
                            let provider = row.provider, !provider.isEmpty
                        {
                            Text("\(TWTheme.providerLabel(parent)) → \(TWTheme.providerLabel(provider))")
                                .font(.caption2)
                                .foregroundStyle(TWTheme.textSecondary)
                                .lineLimit(1)
                        }
                        Circle()
                            .fill(subThreadStatusTint(row.status))
                            .frame(width: 6, height: 6)
                            .accessibilityHidden(true)
                        Text(subThreadStatusLabel(row.status))
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textSecondary)
                            .lineLimit(1)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(epicRowFill)
            }

            if subThreadOverflow > 0 {
                Text("\(subThreadOverflow) more sub-thread\(subThreadOverflow == 1 ? "" : "s") not shown.")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(epicRowFill)
            }
        }
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }

    private var participantsCard: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Participants")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
                Text(participantsMeta)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            epicHeader(left: "Seat", right: "Turns & Tokens")

            ForEach(participantRows) { row in
                HStack(alignment: .center, spacing: 10) {
                    seatCell(link: row.seatLink, fallback: row.seatText)
                    Spacer(minLength: 8)
                    HStack(spacing: 6) {
                        Text(row.workLabel?.isEmpty == false ? (row.workLabel ?? "—") : "—")
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textSecondary)
                            .lineLimit(1)
                        TWParticipantStatusIcon(status: row.status ?? "idle")
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(epicRowFill)
            }

            if let total = participantTable?.totalWorkLabel, !total.isEmpty {
                HStack {
                    Text("Round Total")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Spacer()
                    Text(total)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(epicRowFill)
            }
        }
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }

    private var commitsCard: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Commits")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
                Text("\(commitRows.count) commit\(commitRows.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            HStack(spacing: 8) {
                Text("Hash")
                    .frame(width: 72, alignment: .leading)
                Text("Message")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Seat")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Changes")
                    .frame(width: 64, alignment: .trailing)
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(TWTheme.textMuted)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(epicRowFill)

            ForEach(commitRows) { commit in
                HStack(alignment: .center, spacing: 8) {
                    Text(shortHash(commit.hash))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(TWTheme.textSecondary)
                        .frame(width: 72, alignment: .leading)
                    Text(commit.subject?.isEmpty == false ? (commit.subject ?? "—") : "—")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    seatCell(link: commit.seatLink, fallback: "—")
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(commit.stats?.isEmpty == false ? (commit.stats ?? "—") : "—")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                        .lineLimit(1)
                        .frame(width: 64, alignment: .trailing)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(epicRowFill)
            }

            if commitOverflow > 0 {
                Text("\(commitOverflow) more commit\(commitOverflow == 1 ? "" : "s") not shown.")
                    .font(.caption2.italic())
                    .foregroundStyle(TWTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(epicRowFill)
            }
        }
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }

    private var participantsMeta: String {
        let count = participantRows.count
        let seats = "\(count) seat\(count == 1 ? "" : "s")"
        if let total = participantTable?.totalWorkLabel, !total.isEmpty {
            return "\(seats) · \(total)"
        }
        return seats
    }

    private var epicRowFill: some View {
        TWTheme.surface2.opacity(0.55)
    }

    private func epicHeader(left: String, right: String) -> some View {
        HStack {
            Text(left)
            Spacer()
            Text(right)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(TWTheme.textMuted)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(epicRowFill)
    }

    @ViewBuilder
    private func seatCell(link: TWSeatChangePayload?, fallback: String?) -> some View {
        if let renderable = link?.renderableLink {
            TWSeatStrip(link: renderable)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(fallback?.isEmpty == false ? (fallback ?? "—") : "—")
                .font(.caption2)
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Sub-thread lifecycle tint. A status a newer Mac invents reads neutral —
    /// unknown is not evidence of success OR failure.
    private func subThreadStatusTint(_ status: String?) -> Color {
        switch status {
        case "completed", "returned": return TWTheme.statusSuccess
        case "failed", "cancelled": return TWTheme.statusFailed
        case "running": return TWTheme.chroma1
        default: return TWTheme.textMuted
        }
    }

    private func subThreadStatusLabel(_ status: String?) -> String {
        guard let status, !status.isEmpty else { return "Unknown" }
        return status.prefix(1).uppercased() + status.dropFirst()
    }

    private func shortHash(_ hash: String?) -> String {
        guard let hash, !hash.isEmpty else { return "—" }
        return String(hash.prefix(9))
    }
}
