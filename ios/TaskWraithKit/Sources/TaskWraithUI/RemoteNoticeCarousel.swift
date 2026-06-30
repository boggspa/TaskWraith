import SwiftUI
import TaskWraithKit

struct RemoteNoticeCarousel: View {
    let notices: [FirstLaunchNotice]
    @State private var activeIndex = 0

    private var safeIndex: Int {
        guard !notices.isEmpty else { return 0 }
        return min(max(activeIndex, 0), notices.count - 1)
    }

    var body: some View {
        if !notices.isEmpty {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    if notices.count > 1 {
                        noticeNavButton(systemName: "chevron.left", label: "Previous notice") {
                            activeIndex = (safeIndex - 1 + notices.count) % notices.count
                        }
                    }

                    RemoteNoticeCard(notice: notices[safeIndex])

                    if notices.count > 1 {
                        noticeNavButton(systemName: "chevron.right", label: "Next notice") {
                            activeIndex = (safeIndex + 1) % notices.count
                        }
                    }
                }

                if notices.count > 1 {
                    HStack(spacing: 6) {
                        ForEach(Array(notices.enumerated()), id: \.element.id) { index, notice in
                            Button {
                                activeIndex = index
                            } label: {
                                Circle()
                                    .fill(index == safeIndex ? noticeDotColor(notice) : TWTheme.border)
                                    .frame(width: index == safeIndex ? 7 : 5, height: index == safeIndex ? 7 : 5)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Show notice \(index + 1) of \(notices.count)")
                            .accessibilityValue(index == safeIndex ? "Selected" : "")
                        }
                    }
                }
            }
            .onChange(of: notices.map(\.id)) { _, _ in
                if activeIndex > notices.count - 1 { activeIndex = 0 }
            }
        }
    }

    private func noticeNavButton(
        systemName: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.caption.weight(.semibold))
                .frame(width: 26, height: 30)
        }
        .buttonStyle(.plain)
        .foregroundStyle(TWTheme.textSecondary)
        .background(TWTheme.surface1.opacity(0.85), in: Capsule())
        .overlay(Capsule().strokeBorder(TWTheme.border, lineWidth: 1))
        .accessibilityLabel(label)
    }

    private func noticeDotColor(_ notice: FirstLaunchNotice) -> Color {
        if notice.tone == "danger" { return TWTheme.statusFailed }
        if notice.accent?.lowercased() == "claude" { return TWTheme.providerAccent("claude") }
        return TWTheme.chroma1
    }
}

struct RemoteNoticeCard: View {
    let notice: FirstLaunchNotice

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: notice.tone == "danger" ? "exclamationmark.circle" : "info.circle")
                .font(.headline)
                .foregroundStyle(accentColor)
            VStack(alignment: .leading, spacing: 3) {
                Text(notice.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text(notice.body)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(backgroundColor)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            accentColor.opacity(notice.accent?.lowercased() == "claude" ? 0.13 : 0.05),
                            Color.clear
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .allowsHitTesting(false)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(borderColor, lineWidth: 1)
        )
    }

    private var accentColor: Color {
        if notice.tone == "danger" { return TWTheme.statusFailed }
        if notice.accent?.lowercased() == "claude" { return TWTheme.providerAccent("claude") }
        return TWTheme.chroma1
    }

    private var backgroundColor: Color {
        if notice.tone == "danger" { return TWTheme.statusFailed.opacity(0.12) }
        if notice.accent?.lowercased() == "claude" {
            return TWTheme.providerAccent("claude").opacity(0.10)
        }
        return TWTheme.surface1
    }

    private var borderColor: Color {
        if notice.tone == "danger" { return TWTheme.statusFailed.opacity(0.35) }
        if notice.accent?.lowercased() == "claude" {
            return TWTheme.providerAccent("claude").opacity(0.42)
        }
        return TWTheme.border
    }
}
