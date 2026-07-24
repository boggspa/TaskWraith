import SwiftUI
import TaskWraithKit

/// Per-notice dismissal persistence for the remote notice carousel. Keyed by
/// notice id in UserDefaults so a first-launch-sheet dismissal sticks across
/// launches. Mirrors the Electron localStorage per-id dismiss keys; the
/// `tw.*.dismissed` prefix matches the whole-sheet key.
enum RemoteNoticeDismissalStore {
    static func key(_ id: String) -> String { "tw.appNotice.\(id).dismissed" }

    static func isDismissed(_ id: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: key(id))
    }

    static func dismiss(_ id: String, defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: key(id))
    }

    static func dismissedIds(
        among notices: [FirstLaunchNotice], defaults: UserDefaults = .standard
    ) -> Set<String> {
        Set(notices.filter { isDismissed($0.id, defaults: defaults) }.map(\.id))
    }
}

struct RemoteNoticeCarousel: View {
    let notices: [FirstLaunchNotice]
    @State private var activeIndex = 0
    /// Ids the user has dismissed. Seeded from the persisted store up-front (no
    /// first-paint flash) and grown live as the user taps ×.
    @State private var dismissedIds: Set<String>

    init(notices: [FirstLaunchNotice]) {
        self.notices = notices
        _dismissedIds = State(initialValue: RemoteNoticeDismissalStore.dismissedIds(among: notices))
    }

    /// Notices still worth showing: a dismissible notice drops once dismissed;
    /// a non-dismissible one always remains.
    private var visibleNotices: [FirstLaunchNotice] {
        notices.filter { notice in
            if notice.dismissible == false { return true }
            return !dismissedIds.contains(notice.id)
        }
    }

    private var safeIndex: Int {
        guard !visibleNotices.isEmpty else { return 0 }
        return min(max(activeIndex, 0), visibleNotices.count - 1)
    }

    var body: some View {
        if !visibleNotices.isEmpty {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    if visibleNotices.count > 1 {
                        noticeNavButton(systemName: "chevron.left", label: "Previous notice") {
                            activeIndex = (safeIndex - 1 + visibleNotices.count) % visibleNotices.count
                        }
                    }

                    RemoteNoticeCard(
                        notice: visibleNotices[safeIndex],
                        onDismiss: { dismiss(visibleNotices[safeIndex]) })

                    if visibleNotices.count > 1 {
                        noticeNavButton(systemName: "chevron.right", label: "Next notice") {
                            activeIndex = (safeIndex + 1) % visibleNotices.count
                        }
                    }
                }

                if visibleNotices.count > 1 {
                    HStack(spacing: 6) {
                        ForEach(Array(visibleNotices.enumerated()), id: \.element.id) { index, notice in
                            Button {
                                activeIndex = index
                            } label: {
                                Circle()
                                    .fill(index == safeIndex ? noticeDotColor(notice) : TWTheme.border)
                                    .frame(width: index == safeIndex ? 7 : 5, height: index == safeIndex ? 7 : 5)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Show notice \(index + 1) of \(visibleNotices.count)")
                            .accessibilityValue(index == safeIndex ? "Selected" : "")
                        }
                    }
                }
            }
            .onChange(of: notices.map(\.id)) { _, _ in
                // The Mac pushed a fresh notice list — re-seed from the store so
                // a newly-arrived-but-already-dismissed notice stays hidden.
                dismissedIds = RemoteNoticeDismissalStore.dismissedIds(among: notices)
                if activeIndex > visibleNotices.count - 1 { activeIndex = 0 }
            }
        }
    }

    private func dismiss(_ notice: FirstLaunchNotice) {
        guard notice.dismissible != false else { return }
        RemoteNoticeDismissalStore.dismiss(notice.id)
        dismissedIds.insert(notice.id)
        activeIndex = 0
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
        if notice.accent?.lowercased() == "ensemble" { return TWTheme.statusSuccess }
        return TWTheme.chroma1
    }
}

struct RemoteNoticeCard: View {
    let notice: FirstLaunchNotice
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if usesEnsembleGlyph {
                ProviderGlyphIcon(provider: "ensemble", isEnsemble: true, size: 20)
            } else {
                Image(systemName: iconName)
                    .font(.headline)
                    .foregroundStyle(accentColor)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(notice.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                if let groups = notice.groups, !groups.isEmpty {
                    RemoteNoticeGroupsView(groups: groups)
                } else {
                    Text(notice.body)
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if notice.dismissible != false, let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TWTheme.textSecondary)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss notice: \(notice.title)")
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
                            accentColor.opacity(usesAccentWash ? 0.13 : 0.05),
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

    private var accentKey: String { notice.accent?.lowercased() ?? "" }

    private var iconKey: String { notice.icon?.lowercased() ?? "" }

    private var usesAccentWash: Bool {
        accentKey == "claude" || accentKey == "ensemble"
    }

    private var usesEnsembleGlyph: Bool {
        notice.tone != "danger" && (iconKey == "ensemble" || accentKey == "ensemble")
    }

    private var iconName: String {
        if notice.tone == "danger" { return "exclamationmark.circle" }
        return "info.circle"
    }

    private var accentColor: Color {
        if notice.tone == "danger" { return TWTheme.statusFailed }
        if accentKey == "claude" { return TWTheme.providerAccent("claude") }
        if accentKey == "ensemble" { return TWTheme.statusSuccess }
        return TWTheme.chroma1
    }

    private var backgroundColor: Color {
        if notice.tone == "danger" { return TWTheme.statusFailed.opacity(0.12) }
        if accentKey == "claude" {
            return TWTheme.providerAccent("claude").opacity(0.10)
        }
        if accentKey == "ensemble" { return TWTheme.statusSuccess.opacity(0.10) }
        return TWTheme.surface1
    }

    private var borderColor: Color {
        if notice.tone == "danger" { return TWTheme.statusFailed.opacity(0.35) }
        if accentKey == "claude" {
            return TWTheme.providerAccent("claude").opacity(0.42)
        }
        if accentKey == "ensemble" { return TWTheme.statusSuccess.opacity(0.42) }
        return TWTheme.border
    }
}

/// "New Additions" grouped content — provider heading + its newly-added
/// models. The provider heading and model NAME are bold and hued (from
/// `TWTheme.providerAccent`, matching the Electron card's provider tokens;
/// one card spans several providers, so this ignores the card's own single
/// accentColor), while each model's marketing blurb is neutral secondary
/// text — hue signposts identity, the description reads as plain body copy.
private struct RemoteNoticeGroupsView: View {
    let groups: [FirstLaunchNoticeGroup]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(groups, id: \.provider) { group in
                let accent = TWTheme.providerAccent(group.provider)
                VStack(alignment: .leading, spacing: 2) {
                    // First-party provider mark beside the explicit provider
                    // heading. Generic icon pickers keep the mnemonic glyphs.
                    HStack(spacing: 5) {
                        ProviderLogoIcon(provider: group.provider, size: 12)
                        Text(group.label)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(accent)
                    }
                    ForEach(group.models, id: \.name) { model in
                        // Ollama-backed models wear their spoofed brand hue
                        // (accentProvider); everything else falls back to the
                        // group's provider accent.
                        let modelAccent = TWTheme.providerAccent(
                            model.accentProvider ?? group.provider)
                        (Text(model.name).fontWeight(.bold).foregroundStyle(modelAccent)
                            + Text(" - \(model.blurb)").fontWeight(.regular)
                                .foregroundStyle(TWTheme.textSecondary))
                            .font(.caption2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}
