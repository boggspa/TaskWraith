import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
    import UIKit
#endif

struct FirstLaunchSheetView: View {
    @ObservedObject var model: RemoteSessionModel
    @ObservedObject private var themes = TWThemeStore.shared
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let onOpenSettings: () -> Void
    let onDone: () -> Void

    private var state: FirstLaunchState? { model.firstLaunchState }
    private var providerCards: [ProviderDisplay] {
        if let cards = state?.providerCards, !cards.isEmpty {
            return cards
                .filter { !TWTheme.isRetiredProvider($0.id) }
                .map(ProviderDisplay.init(card:))
        }
        let usageByProvider = Dictionary(
            uniqueKeysWithValues: (model.modelUsage?.providers ?? []).map { ($0.provider, $0) })
        return ["codex", "claude", "kimi", "cursor", "grok", "ollama"].map { provider in
            ProviderDisplay(
                id: provider,
                label: TWTheme.providerLabel(provider),
                optional: ["kimi", "cursor", "grok", "ollama"].contains(provider),
                statusKind: model.providerModels[provider]?.isEmpty == false
                    ? "notObservable" : "notLoaded",
                statusText: model.providerModels[provider]?.isEmpty == false
                    ? "Models available" : "Not loaded yet",
                detail: "Waiting for the paired Mac to report provider readiness.",
                setupHint: "Provider setup and sign-in happen on the Mac.",
                usageWindows: usageByProvider[provider]?.windows.map(UsageDisplay.init(window:)) ?? []
            )
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    notices
                    connectedMacSection
                    providerReadinessSection
                    lookAndComposerSection
                    approvalsSection
                    usageSection
                    ensembleSection
                    powerToolsSection
                }
                .padding(.horizontal, horizontalSizeClass == .regular ? 24 : 16)
                .padding(.vertical, 20)
                .frame(maxWidth: horizontalSizeClass == .regular ? 760 : .infinity)
                .frame(maxWidth: .infinity)
            }
            .background(TWTheme.appBg.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Settings") { onOpenSettings() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onDone() }
                        .fontWeight(.semibold)
                }
            }
        }
        .twColorScheme()
    }

    private var welcomeDeviceName: String {
        #if canImport(UIKit)
            switch UIDevice.current.userInterfaceIdiom {
            case .pad: return "iPad"
            default: return "iPhone"
            }
        #else
            return "iPhone"
        #endif
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            GhostMonolineMarkView(size: 42)
            VStack(alignment: .leading, spacing: 4) {
                Text("Welcome to TaskWraith on \(welcomeDeviceName)")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text("Your Mac runs providers and owns setup. This device monitors, steers, approves, and starts allowed turns.")
                    .font(.subheadline)
                    .foregroundStyle(TWTheme.textSecondary)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var notices: some View {
        let entries = state?.notifications ?? []
        if !entries.isEmpty {
            VStack(spacing: 10) {
                ForEach(entries) { notice in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: notice.tone == "danger" ? "exclamationmark.circle" : "info.circle")
                            .font(.headline)
                            .foregroundStyle(notice.tone == "danger" ? TWTheme.statusFailed : TWTheme.chroma1)
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
                            .fill(
                                notice.tone == "danger"
                                    ? TWTheme.statusFailed.opacity(0.12)
                                    : TWTheme.surface1
                            )
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(
                                notice.tone == "danger"
                                    ? TWTheme.statusFailed.opacity(0.35)
                                    : TWTheme.border,
                                lineWidth: 1
                            )
                    )
                }
            }
        }
    }

    private var connectedMacSection: some View {
        FirstLaunchSection(title: "Connected Mac & Workspace Access", systemImage: "macbook.and.iphone") {
            let summary = state?.workspace
            VStack(alignment: .leading, spacing: 12) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 135), spacing: 10)], spacing: 10) {
                    MetricChip(
                        title: "Host",
                        value: model.macDisplayName.isEmpty ? "Mac" : model.macDisplayName,
                        systemImage: "desktopcomputer")
                    MetricChip(
                        title: "Workspaces",
                        value: "\(summary?.visibleCount ?? model.workspaces.count) visible",
                        systemImage: "folder")
                    MetricChip(
                        title: "Active",
                        value: "\(summary?.runningCount ?? runningTaskCount)",
                        systemImage: "bolt.horizontal")
                }
                CapabilityStrip(summary: summary)
                Text(workspaceCaption(summary))
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var providerReadinessSection: some View {
        FirstLaunchSection(title: "Provider Readiness", systemImage: "switch.2") {
            StatusDotLegend()
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 245), spacing: 10)], spacing: 10) {
                ForEach(providerCards) { card in
                    ProviderReadinessCard(card: card)
                }
            }
            if let generated = state?.generatedAt, let asOf = shortTime(generated) {
                Text("Readiness snapshot as of \(asOf). Setup and sign-in still happen on the Mac.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
            }
        }
    }

    private var lookAndComposerSection: some View {
        FirstLaunchSection(title: "Look & Composer", systemImage: "paintpalette", accent: true) {
            VStack(spacing: 12) {
                Grid(horizontalSpacing: 10, verticalSpacing: 10) {
                    GridRow {
                        pickerBox("Theme") {
                            Picker("Theme", selection: Binding(
                                get: { themes.systemTheme },
                                set: { themes.systemTheme = $0 }
                            )) {
                                ForEach(TWSystemTheme.allCases) { theme in
                                    Text(theme.label).tag(theme)
                                }
                            }
                            .labelsHidden()
                            .accessibilityLabel("Theme")
                            .accessibilityValue(themes.systemTheme.label)
                        }
                        pickerBox("Accent") {
                            Picker("Accent", selection: Binding(
                                get: { themes.accentTheme },
                                set: { themes.accentTheme = $0 }
                            )) {
                                ForEach(TWAccentTheme.allCases) { accent in
                                    Text(accent.label).tag(accent)
                                }
                            }
                            .labelsHidden()
                            .accessibilityLabel("Accent")
                            .accessibilityValue(themes.accentTheme.label)
                        }
                    }
                    GridRow {
                        pickerBox("Composer") {
                            Picker("Composer", selection: composerBinding) {
                                Text("Follow Mac").tag("followMac")
                                ForEach(TWComposerStyle.known, id: \.raw) { style in
                                    Text(style.label).tag(style.raw)
                                }
                            }
                            .labelsHidden()
                            .accessibilityLabel("Composer")
                            .accessibilityValue(composerPickerValue)
                        }
                        pickerBox("Transcript") {
                            Picker("Transcript", selection: Binding(
                                get: { themes.transcriptFontPreference },
                                set: { themes.transcriptFontPreference = $0 }
                            )) {
                                ForEach(TWTranscriptFont.allCases, id: \.self) { font in
                                    Text(font.label).tag(font)
                                }
                            }
                            .labelsHidden()
                            .accessibilityLabel("Transcript")
                            .accessibilityValue(themes.transcriptFontPreference.label)
                        }
                    }
                }
                composerPreview
            }
        }
    }

    private var composerBinding: Binding<String> {
        Binding<String>(
            get: {
                switch themes.composerShellPreference {
                case .followMac: return "followMac"
                case .override(let style): return style.raw
                }
            },
            set: { raw in
                themes.composerShellPreference =
                    raw == "followMac" ? .followMac : .override(TWComposerStyle(raw: raw))
            }
        )
    }

    private var composerPickerValue: String {
        switch themes.composerShellPreference {
        case .followMac: return "Follow Mac"
        case .override(let style): return style.label
        }
    }

    private func pickerBox<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(TWTheme.textTertiary)
            content()
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var composerPreview: some View {
        let shell = twResolvedComposerShell(model: model, presentation: .welcome)
        return VStack(alignment: .leading, spacing: 10) {
            Text("Message the selected provider...")
                .font(twComposerFont(shell.fontDesign, .callout))
                .foregroundStyle(shell.palette.placeholder)
            HStack(spacing: 8) {
                previewPill("Claude", accent: TWTheme.providerAccent("claude"), shape: shell.geometry.controlShape)
                previewPill("Plan", accent: TWTheme.statusAttention, shape: shell.geometry.controlShape)
                Spacer(minLength: 0)
                ComposerPreviewSendLabel(shell: shell)
}
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Static preview (no real input drawing the surface), so draw the shell
        // for EVERY style — including the input-owns shells (claude / cursor /
        // obsidian / alabaster) that composerShellUnlessInputOwns skips, which
        // left those Provider-style shells blank in the preview.
        .composerShell(shell)
    }

    private func previewPill(_ title: String, accent: Color, shape: ComposerControlShape) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(accent)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(accent.opacity(0.14), in: twControlShape(shape))
    }

    private var approvalsSection: some View {
        FirstLaunchSection(title: "Approvals & Control", systemImage: "checkmark.shield") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    MetricChip(
                        title: "Approvals",
                        value: "\(model.approvals.count) waiting",
                        systemImage: "checkmark.circle")
                    MetricChip(
                        title: "Questions",
                        value: "\(model.questions.count) waiting",
                        systemImage: "questionmark.circle")
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ApprovalActionChip("Allow once", systemImage: "checkmark.circle")
                        ApprovalActionChip("Allow session", systemImage: "clock.badge.checkmark")
                        ApprovalActionChip("Allow workspace", systemImage: "folder.badge.gearshape")
                        ApprovalActionChip("Deny", systemImage: "xmark.circle")
                        ApprovalActionChip("Cancel run", systemImage: "stop.circle")
                    }
                }
                ApprovalCapabilityRow(
                    icon: "hand.raised",
                    title: "Respond from iPhone",
                    detail: "Approvals and agent questions appear here when the Mac is waiting; the full Approval Ledger remains desktop-only.",
                    enabled: state?.workspace?.capabilities.approve ?? true)
                ApprovalCapabilityRow(
                    icon: "play.circle",
                    title: "Start or steer allowed workspaces",
                    detail: "Remote turns follow the Mac workspace allowlist and approval mode.",
                    enabled: state?.workspace?.capabilities.startTurn ?? !model.workspaces.isEmpty)
                ApprovalCapabilityRow(
                    icon: "doc.text.magnifyingglass",
                    title: "Inspect before acting",
                    detail: "Diffs, files, and transcript snapshots are monitor-first on iPhone.",
                    enabled: state?.workspace?.capabilities.monitor ?? true)
            }
        }
    }

    private var usageSection: some View {
        FirstLaunchSection(title: "Usage Snapshots", systemImage: "chart.bar.xaxis") {
            if let dashboard = model.welcomeDashboard, dashboard.lifetimeHasActivity {
                WelcomeUsageDashboardCard(dashboard: dashboard, accent: TWTheme.chroma1)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(providerCards.filter { !$0.usageWindows.isEmpty }) { card in
                        ProviderUsageMiniRow(provider: card.label, providerId: card.id, windows: card.usageWindows)
                    }
                    if providerCards.allSatisfy({ $0.usageWindows.isEmpty }) {
                        Text("No quota windows have arrived from the Mac yet.")
                            .font(.caption)
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                }
            }
            if let asOf = shortTime(model.modelUsage?.generatedAt ?? state?.generatedAt) {
                Text("Usage as of \(asOf). Cached or stale windows are labelled by the Mac snapshot.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
            } else {
                Text("Offline or waiting for the Mac usage snapshot. Quota windows appear after the Mac broadcasts usage.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textTertiary)
            }
        }
    }

    private var ensembleSection: some View {
        FirstLaunchSection(title: "Ensemble Basics", systemImage: "person.3.sequence") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    ForEach(ensembleRoster.prefix(4)) { entry in
                        EnsembleRosterChip(entry: entry)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 8) {
                    FeaturePill("Turn", systemImage: "arrow.turn.down.right")
                    FeaturePill("Continuous", systemImage: "repeat")
                    FeaturePill("@Role", systemImage: "at")
                }
                Text("Participants speak in roster order, can be steered by role, and share the same transcript for the round.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var powerToolsSection: some View {
        FirstLaunchSection(title: "Power Tools & Mac-only Setup", systemImage: "terminal") {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Provider logins, API keys, CLI installs, MCP servers, Screen Watch, provider settings, and local Ollama pulls stay on your Mac. iPhone can monitor readiness and start allowed remote turns after the Mac is configured.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                    ForEach((state?.setupCommands ?? []).prefix(6)) { command in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(command.platform == nil ? command.label : "\(command.label) · \(command.platform!)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TWTheme.textPrimary)
                            Text(command.command)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(TWTheme.textSecondary)
                                .textSelection(.enabled)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
                .padding(.top, 8)
            } label: {
                Text("Show Mac setup references")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
            }
        }
    }

    private var runningTaskCount: Int {
        model.taskCards.filter { $0.status == "running" }.count
    }

    private func workspaceCaption(_ summary: FirstLaunchWorkspaceSummary?) -> String {
        guard let summary else {
            return model.workspaces.isEmpty
                ? "Add workspace access from TaskWraith on your Mac in Settings -> Devices -> workspace access before composing from iPhone."
                : "Workspace access is granted on your Mac and controlled by the Mac allowlist."
        }
        if summary.hasVisibleWorkspaces {
            return "\(summary.visibleCount) of \(summary.totalCount) desktop workspaces are visible to this phone. Workspace access is granted on your Mac."
        }
        return "No desktop workspaces are currently shared with this phone. Add access on your Mac in Settings -> Devices -> workspace access."
    }

    private var ensembleRoster: [EnsembleDisplay] {
        if let roster = model.ensembleStates.values.first?.roster, !roster.isEmpty {
            return roster
                .filter { $0.enabled != false }
                .sorted { ($0.order ?? 99) < ($1.order ?? 99) }
                .map { EnsembleDisplay(id: $0.id, provider: $0.provider, role: $0.role) }
        }
        return [
            EnsembleDisplay(id: "explorer", provider: "claude", role: "Explorer"),
            EnsembleDisplay(id: "builder", provider: "codex", role: "Builder"),
            EnsembleDisplay(id: "reviewer", provider: "kimi", role: "Reviewer")
        ]
    }

    private func shortTime(_ value: String?) -> String? {
        guard let date = twParseISODate(value) else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

private struct FirstLaunchSection<Content: View>: View {
    let title: String
    let systemImage: String
    var accent: Bool
    private let content: Content

    init(
        title: String, systemImage: String, accent: Bool = false,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.systemImage = systemImage
        self.accent = accent
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage)
                .font(.headline.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Accent sections (Look & Composer) get Electron's signature radial
        // accent wash behind the content + an accent-tinted border. Uses the
        // themed `chroma1`, so it tracks the user's accent rather than a fixed
        // blue. Plain sections stay on surface1 + a hairline border.
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(TWTheme.surface1)
                if accent {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(
                            RadialGradient(
                                gradient: Gradient(colors: [
                                    TWTheme.chroma1.opacity(0.12), Color.clear
                                ]),
                                center: .topLeading, startRadius: 0, endRadius: 280)
                        )
                }
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(
                    accent ? TWTheme.chroma1.opacity(0.22) : TWTheme.border, lineWidth: 1)
        )
    }
}

private struct MetricChip: View {
    let title: String
    let value: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(TWTheme.chroma1)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(TWTheme.textTertiary)
                Text(value)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct CapabilityStrip: View {
    let summary: FirstLaunchWorkspaceSummary?

    private var capabilities: [CapabilityDisplay] {
        let caps = summary?.capabilities
        return [
            CapabilityDisplay(label: "Monitor", enabled: caps?.monitor ?? true),
            CapabilityDisplay(label: "Approve", enabled: caps?.approve ?? true),
            CapabilityDisplay(label: "Answer", enabled: caps?.answer ?? true),
            CapabilityDisplay(label: "Start", enabled: caps?.startTurn ?? false),
            CapabilityDisplay(label: "Steer", enabled: caps?.steer ?? false),
            CapabilityDisplay(label: "Read", enabled: caps?.fileRead ?? false),
            CapabilityDisplay(label: "Write", enabled: caps?.fileWrite ?? false)
        ]
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(capabilities) { item in
                    Text(item.label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(item.enabled ? TWTheme.chroma1 : TWTheme.textTertiary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(
                            (item.enabled ? TWTheme.chroma1.opacity(0.14) : TWTheme.surface2),
                            in: Capsule()
                        )
                }
            }
        }
    }
}

private struct CapabilityDisplay: Identifiable {
    let label: String
    let enabled: Bool
    var id: String { label }
}

private struct StatusDotLegend: View {
    var body: some View {
        // Decodes the per-card status dots (parity with the Electron legend).
        // Buckets mirror ProviderReadinessCard.statusColor. Wraps to 2 columns
        // on a narrow iPhone via an adaptive grid.
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 165), spacing: 8)],
            alignment: .leading, spacing: 6
        ) {
            // Labels track ProviderReadinessCard.statusColor's buckets AND the
            // card statusText they decode: amber also covers cliMissing
            // ("CLI missing on Mac") + stale; grey covers notObservable (the
            // Cursor/Grok steady state, shown as "Not observable") + notLoaded.
            item(TWTheme.statusSuccess, "Ready")
            item(TWTheme.statusAttention, "Needs setup, sign-in, or install")
            item(TWTheme.statusFailed, "Out of usage")
            item(TWTheme.textSecondary, "Not observable / not loaded")
        }
    }

    private func item(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label)
                .font(.caption2)
                .foregroundStyle(TWTheme.textTertiary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Spacer(minLength: 0)
        }
    }
}

private struct ProviderReadinessCard: View {
    let card: ProviderDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                ProviderGlyphIcon(provider: card.id, size: 18)
                Text(card.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 0)
                if card.optional {
                    Text("Optional")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(TWTheme.surface3, in: Capsule())
                }
            }
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                Text(card.statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
            }
            Text(card.detail)
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if !card.setupHint.isEmpty {
                Text(card.setupHint)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !card.usageWindows.isEmpty {
                ProviderUsageMiniRow(provider: card.label, providerId: card.id, windows: card.usageWindows)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(TWTheme.providerAccent(card.id).opacity(0.25), lineWidth: 1)
        )
    }

    private var statusColor: Color {
        switch card.statusKind {
        case "ready", "localReady": return TWTheme.statusSuccess
        case "needsSignIn", "cliMissing", "stale": return TWTheme.statusAttention
        case "outOfUsage": return TWTheme.statusFailed
        default: return TWTheme.textSecondary
        }
    }
}

private struct ProviderUsageMiniRow: View {
    let provider: String
    let providerId: String
    let windows: [UsageDisplay]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(provider)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 0)
                Text("\(windows.count) window\(windows.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            ForEach(windows.prefix(2)) { window in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(window.label)
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textSecondary)
                        Spacer(minLength: 0)
                        if let percent = window.usedPercent {
                            Text("\(percent)%")
                                .font(.caption2.monospacedDigit())
                            .foregroundStyle(TWTheme.textSecondary)
                        }
                    }
                    if let reset = resetText(window.resetAt) {
                        Text(reset)
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textTertiary)
                    }
                    GeometryReader { proxy in
                        let percent = CGFloat(window.usedPercent ?? 0) / 100
                        ZStack(alignment: .leading) {
                            Capsule().fill(TWTheme.surface3)
                            Capsule()
                                .fill(TWTheme.providerAccent(providerId))
                                .frame(width: max(4, proxy.size.width * percent))
                        }
                    }
                    .frame(height: 5)
                }
            }
        }
        .padding(9)
        .background(TWTheme.appBg.opacity(0.45), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func resetText(_ resetAt: String?) -> String? {
        guard let resetAt, let date = twParseISODate(resetAt) else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return "resets \(formatter.string(from: date))"
    }
}

private struct ApprovalActionChip: View {
    let label: String
    let systemImage: String

    init(_ label: String, systemImage: String) {
        self.label = label
        self.systemImage = systemImage
    }

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(TWTheme.textPrimary)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(TWTheme.surface2, in: Capsule())
            .overlay(Capsule().strokeBorder(TWTheme.border, lineWidth: 1))
    }
}

private struct ApprovalCapabilityRow: View {
    let icon: String
    let title: String
    let detail: String
    let enabled: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: enabled ? icon : "lock")
                .foregroundStyle(enabled ? TWTheme.chroma1 : TWTheme.textTertiary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct FeaturePill: View {
    let label: String
    let systemImage: String

    init(_ label: String, systemImage: String) {
        self.label = label
        self.systemImage = systemImage
    }

    var body: some View {
        Label(label, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(TWTheme.chroma1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(TWTheme.chroma1.opacity(0.14), in: Capsule())
    }
}

private struct EnsembleRosterChip: View {
    let entry: EnsembleDisplay

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(entry.role ?? TWTheme.providerLabel(entry.provider))
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(TWTheme.providerLabel(entry.provider))
                .font(.caption2)
                .foregroundStyle(TWTheme.providerAccent(entry.provider))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(TWTheme.providerAccent(entry.provider).opacity(0.28), lineWidth: 1)
        )
    }
}

private struct ProviderDisplay: Identifiable {
    let id: String
    let label: String
    let optional: Bool
    let statusKind: String
    let statusText: String
    let detail: String
    let setupHint: String
    let usageWindows: [UsageDisplay]

    init(
        id: String,
        label: String,
        optional: Bool,
        statusKind: String,
        statusText: String,
        detail: String,
        setupHint: String,
        usageWindows: [UsageDisplay]
    ) {
        self.id = id
        self.label = label
        self.optional = optional
        self.statusKind = statusKind
        self.statusText = statusText
        self.detail = detail
        self.setupHint = setupHint
        self.usageWindows = usageWindows
    }

    init(card: FirstLaunchProviderCard) {
        self.init(
            id: card.id,
            label: card.label,
            optional: card.optional,
            statusKind: card.statusKind,
            statusText: card.statusText,
            detail: card.detail,
            setupHint: card.setupHint,
            usageWindows: card.usageWindows.map(UsageDisplay.init(window:))
        )
    }
}

private struct UsageDisplay: Identifiable {
    let id: String
    let label: String
    let usedPercent: Int?
    let resetAt: String?

    init(window: FirstLaunchUsageWindow) {
        id = window.id
        label = window.label
        usedPercent = window.usedPercent
        resetAt = window.resetAt
    }

    init(window: ModelUsageMessage.Window) {
        id = window.id
        label = window.label
        usedPercent = window.usedPercent
        resetAt = window.resetAt
    }
}

private struct EnsembleDisplay: Identifiable {
    let id: String
    let provider: String
    let role: String?
}
