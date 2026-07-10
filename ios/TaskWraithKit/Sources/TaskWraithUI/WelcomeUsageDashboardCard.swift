// WelcomeUsageDashboardCard.swift — the iOS port of the Electron "New Chat
// welcome" stats dashboard (a card with 4 tabs: Statistics / Model Comparisons /
// Workspaces / Providers, "LAST 30 DAYS"). Data comes from the Mac's
// `buildWelcomeUsageDashboardData` aggregator, projected to `WelcomeDashboard`
// (Models.swift) and broadcast over `bridge.broadcastWelcomeDashboard`. The card
// is full-width + sizes to its content, so it adapts inside the welcome screen's
// ScrollView (1-column stats on a phone, 2-column on iPad). Provider colors reuse
// TWTheme.providerAccent so the card matches the iOS activity heatmap.

import SwiftUI
import TaskWraithKit

/// Pure value formatters — mirror the Electron dashboard's formatting rules
/// (welcomeUsageDashboard.ts: formatCompactUsageNumber / formatDashboardDuration
/// / formatPeakHour / formatCost) so the two surfaces read identically.
enum DashboardFmt {
    /// ≥10M → "19M"; ≥1M → "6.2M"; ≥100k → "364k"; ≥1k → "20.3k"; else integer.
    static func compact(_ raw: Int) -> String {
        let v = max(0, raw)
        if v >= 10_000_000 { return "\(Int((Double(v) / 1_000_000).rounded()))M" }
        if v >= 1_000_000 { return String(format: "%.1fM", Double(v) / 1_000_000) }
        if v >= 100_000 { return "\(Int((Double(v) / 1_000).rounded()))k" }
        if v >= 1_000 { return String(format: "%.1fk", Double(v) / 1_000) }
        return "\(v)"
    }

    /// Two-unit human duration: "<1s" / "32s" / "12m 34s" / "17h 29m" / "12d 3h".
    static func duration(_ ms: Int) -> String {
        if ms <= 0 { return "0s" }
        if ms < 1_000 { return "<1s" }
        // Round to the nearest second BEFORE splitting (matches the Electron
        // formatDashboardDuration; truncating renders a second short at boundaries).
        let totalSec = Int((Double(ms) / 1_000).rounded())
        if totalSec < 60 { return "\(totalSec)s" }
        let totalMin = totalSec / 60
        if totalMin < 60 {
            let s = totalSec % 60
            return s == 0 ? "\(totalMin)m" : "\(totalMin)m \(s)s"
        }
        let totalHr = totalMin / 60
        if totalHr < 24 {
            let m = totalMin % 60
            return m == 0 ? "\(totalHr)h" : "\(totalHr)h \(m)m"
        }
        let d = totalHr / 24
        let h = totalHr % 24
        return h == 0 ? "\(d)d" : "\(d)d \(h)h"
    }

    /// USD 2dp; empty string when ≤0 (matches the Electron blank-when-zero rule).
    static func cost(_ usd: Double) -> String {
        guard usd > 0 else { return "" }
        return String(format: "$%.2f", usd)
    }

    /// Always 1 dp: "33.6%".
    static func percent(_ p: Double) -> String { String(format: "%.1f%%", p) }

    /// HH:MM:SS zero-padded for the Providers "24H Wall Time" readout.
    static func wallClock(_ ms: Int) -> String {
        let totalSec = max(0, ms / 1_000)
        return String(
            format: "%02d:%02d:%02d", totalSec / 3_600, (totalSec % 3_600) / 60, totalSec % 60)
    }
}

private enum DashTab: String, CaseIterable, Identifiable {
    case statistics, models, workspaces, providers
    var id: String { rawValue }
    var label: String {
        switch self {
        case .statistics: return "Statistics"
        case .models: return "Models"
        case .workspaces: return "Workspaces"
        case .providers: return "Providers"
        }
    }
    var icon: String {
        switch self {
        case .statistics: return "chart.bar.xaxis"
        case .models: return "cpu"
        case .workspaces: return "folder.fill"
        case .providers: return "bolt.horizontal.fill"
        }
    }
}

public struct WelcomeUsageDashboardCard: View {
    private let dashboard: WelcomeDashboard
    private let accent: Color
    @State private var tab: DashTab = .statistics

    public init(dashboard: WelcomeDashboard, accent: Color) {
        self.dashboard = dashboard
        self.accent = accent
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if hasRibbon { ribbon }
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .animation(.easeInOut(duration: 0.15), value: tab)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous).fill(TWTheme.surface2))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(TWTheme.border))
    }

    // MARK: Header — tabs + "LAST 30 DAYS" badge

    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(DashTab.allCases) { item in
                        tabChip(item)
                    }
                }
                .padding(.vertical, 1)
            }
            badge
        }
    }

    private func tabChip(_ item: DashTab) -> some View {
        let selected = tab == item
        return Button {
            tab = item
        } label: {
            HStack(spacing: 5) {
                Image(systemName: item.icon).font(.system(size: 10, weight: .semibold))
                Text(item.label).font(.caption.weight(.medium))
            }
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(selected ? accent.opacity(0.20) : Color.clear, in: Capsule())
            .overlay(
                Capsule().strokeBorder(
                    selected ? accent.opacity(0.6) : TWTheme.border.opacity(0.6)))
            .foregroundStyle(selected ? accent : TWTheme.textSecondary)
        }
        .buttonStyle(.plain)
    }

    private var badge: some View {
        HStack(spacing: 3) {
            Image(systemName: "clock").font(.system(size: 8, weight: .semibold))
            Text("LAST 30 DAYS").font(.system(size: 9, weight: .semibold)).tracking(0.4)
        }
        .foregroundStyle(TWTheme.textTertiary)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(TWTheme.surface3, in: Capsule())
        .fixedSize()
    }

    // MARK: Provider-mix gradient ribbon

    private var hasRibbon: Bool {
        dashboard.providerTokenTotals.contains { $0.tokens > 0 }
    }

    private var ribbon: some View {
        let segs = dashboard.providerTokenTotals.filter { $0.tokens > 0 }
        let total = max(1, segs.reduce(0) { $0 + $1.tokens })
        return GeometryReader { geo in
            HStack(spacing: 2) {
                ForEach(segs) { seg in
                    Capsule()
                        .fill(TWTheme.providerAccent(seg.provider))
                        .frame(
                            width: max(
                                3, geo.size.width * CGFloat(seg.tokens) / CGFloat(total)))
                }
                Spacer(minLength: 0)
            }
        }
        .frame(height: 5)
        .clipShape(Capsule())
    }

    // MARK: Tab content

    @ViewBuilder private var content: some View {
        switch tab {
        case .statistics: statisticsTab
        case .models: modelsTab
        case .workspaces: workspacesTab
        case .providers: providersTab
        }
    }

    // MARK: Statistics

    /// `prioritizeValue` true (numeric stats): the value is the point — keep it
    /// whole, let the label truncate. False (favorite model/project): the value is
    /// a long name/slug — keep the label whole, truncate the value's middle.
    private func statRow(_ label: String, _ value: String, prioritizeValue: Bool = true)
        -> some View
    {
        HStack(spacing: 8) {
            Text(label).font(.caption).foregroundStyle(TWTheme.textTertiary)
                .lineLimit(1).layoutPriority(prioritizeValue ? 0 : 1)
            Spacer(minLength: 6)
            Text(value).font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1).truncationMode(.middle)
                .layoutPriority(prioritizeValue ? 1 : 0)
        }
    }

    // Compact (iOS is compact-only): favorite model/project span full width (their
    // values are long); the headline numeric stats sit in a tight 2-column grid
    // (short values fit without truncation). Trimmed from the desktop's 15 stats so
    // the card sits above the ghost without turning the welcome into a scroll screen.
    private var statisticsTab: some View {
        let numeric: [(label: String, value: String)] = [
            ("24H Tkns", DashboardFmt.compact(dashboard.tokens24h)),
            ("Total tokens", DashboardFmt.compact(dashboard.totalTokens)),
            ("Current streak", "\(dashboard.currentStreak)d"),
            ("Longest streak", "\(dashboard.longestStreak)d"),
            ("Active days", DashboardFmt.compact(dashboard.activeDays)),
            ("Peak hour", dashboard.peakHour.isEmpty ? "n/a" : dashboard.peakHour),
            ("Sessions", DashboardFmt.compact(dashboard.sessions)),
            ("Messages", DashboardFmt.compact(dashboard.messages)),
            ("Avg session", DashboardFmt.duration(dashboard.avgSessionMs)),
        ]
        return VStack(alignment: .leading, spacing: 8) {
            statRow(
                "Favorite model",
                dashboard.favoriteModel.isEmpty ? "—" : dashboard.favoriteModel,
                prioritizeValue: false)
            statRow(
                "Favorite project",
                dashboard.favoriteProject.isEmpty ? "—" : dashboard.favoriteProject,
                prioritizeValue: false)
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                alignment: .leading, spacing: 8
            ) {
                ForEach(numeric, id: \.label) { item in statRow(item.label, item.value) }
            }
            if !dashboard.comparisonText.isEmpty {
                Text(dashboard.comparisonText)
                    .font(.caption2).foregroundStyle(TWTheme.textTertiary)
            }
        }
    }

    // MARK: Models

    private var modelsTab: some View {
        VStack(alignment: .leading, spacing: 11) {
            if dashboard.modelBreakdown.isEmpty {
                emptyLine("No model-level usage tracked in the last 30 days.")
            } else {
                ForEach(dashboard.modelBreakdown.prefix(4)) { m in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Circle().fill(TWTheme.providerAccent(m.accentProviderKey))
                                .frame(width: 8, height: 8)
                            Text(m.label).font(.caption.weight(.medium))
                                .foregroundStyle(TWTheme.textPrimary).lineLimit(1)
                            Spacer(minLength: 6)
                            Text(
                                "\(DashboardFmt.compact(m.inputTokens)) in · "
                                    + "\(DashboardFmt.compact(m.outputTokens)) out"
                            )
                            .font(.caption2).foregroundStyle(TWTheme.textTertiary).lineLimit(1)
                            Text(DashboardFmt.percent(m.percent))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TWTheme.textPrimary)
                        }
                        meter(
                            fraction: m.percent / 100,
                            color: TWTheme.providerAccent(m.accentProviderKey))
                    }
                }
            }
        }
    }

    // MARK: Workspaces

    private var totalDailyTokens: Int { dashboard.dailyBreakdown.reduce(0) { $0 + $1.tokens } }
    private var totalDailyCost: Double { dashboard.dailyBreakdown.reduce(0) { $0 + $1.costUsd } }
    /// Electron parity: the daily chart scales by COST when any day carries cost,
    /// else by tokens (WelcomeUsageDashboard.tsx lines 558-575).
    private var dailyScaleByCost: Bool { dashboard.dailyBreakdown.contains { $0.costUsd > 0 } }
    private func dailyValue(_ b: WelcomeDashboard.DailyBucket) -> Double {
        dailyScaleByCost ? b.costUsd : Double(b.tokens)
    }

    private var workspacesTab: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                if dashboard.workspaceBreakdown.isEmpty {
                    emptyLine("No workspace-attributed activity tracked in the last 30 days.")
                } else {
                    ForEach(dashboard.workspaceBreakdown.prefix(4)) { w in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 8) {
                                Text(w.displayName).font(.caption.weight(.medium))
                                    .foregroundStyle(TWTheme.textPrimary).lineLimit(1)
                                Spacer(minLength: 6)
                                tokenCostLabel(tokens: w.tokens, cost: w.costUsd)
                            }
                            meter(fraction: w.shareOfTotalTokens / 100, color: accent)
                        }
                    }
                }
            }
            if !dashboard.dailyBreakdown.isEmpty { dailyChart }
        }
    }

    private var dailyChart: some View {
        let scaleByCost = dailyScaleByCost
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(scaleByCost ? "Daily cost · last 30 days" : "Daily tokens · last 30 days")
                    .font(.caption2.weight(.semibold)).foregroundStyle(TWTheme.textTertiary)
                Spacer()
                Text(
                    scaleByCost
                        ? "\(DashboardFmt.cost(totalDailyCost)) total"
                        : "\(DashboardFmt.compact(totalDailyTokens)) tokens total"
                )
                .font(.caption2).foregroundStyle(TWTheme.textSecondary)
            }
            GeometryReader { geo in
                let maxVal = max(0.0001, dashboard.dailyBreakdown.map(dailyValue).max() ?? 0.0001)
                HStack(alignment: .bottom, spacing: 1.5) {
                    ForEach(dashboard.dailyBreakdown) { b in
                        RoundedRectangle(cornerRadius: 1, style: .continuous)
                            .fill(accent.opacity(0.75))
                            .frame(height: max(1, geo.size.height * CGFloat(dailyValue(b) / maxVal)))
                            .frame(maxWidth: .infinity, alignment: .bottom)
                    }
                }
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
            .frame(height: 24)
        }
    }

    // MARK: Providers

    private var providersTab: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(dashboard.providerBreakdown.prefix(4)) { p in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 7) {
                            Circle().fill(TWTheme.providerAccent(p.provider))
                                .frame(width: 8, height: 8)
                            Text(p.displayName).font(.caption.weight(.medium))
                                .foregroundStyle(TWTheme.textPrimary).lineLimit(1)
                            Spacer(minLength: 6)
                            tokenCostLabel(tokens: p.tokens, cost: p.costUsd)
                        }
                        meter(
                            fraction: p.shareOfTotalTokens / 100,
                            color: TWTheme.providerAccent(p.provider))
                    }
                }
            }
            wallTime
        }
    }

    private var wallTime: some View {
        VStack(spacing: 4) {
            Text("24H WALL TIME")
                .font(.system(size: 9, weight: .semibold)).tracking(1.2)
                .foregroundStyle(TWTheme.textTertiary)
            Text(DashboardFmt.wallClock(dashboard.wallTime24hMs))
                .font(.system(size: 24, weight: .bold, design: .monospaced))
                .monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.6)
                .foregroundStyle(TWTheme.textPrimary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 2)
    }

    // MARK: Shared bits

    private func tokenCostLabel(tokens: Int, cost: Double) -> some View {
        let costStr = DashboardFmt.cost(cost)
        return HStack(spacing: 6) {
            if !costStr.isEmpty {
                Text(costStr).font(.caption2).foregroundStyle(TWTheme.textTertiary)
            }
            Text("\(DashboardFmt.compact(tokens)) tokens")
                .font(.caption2).foregroundStyle(TWTheme.textSecondary)
        }
        .lineLimit(1)
    }

    private func meter(fraction: Double, color: Color) -> some View {
        let f = CGFloat(min(1, max(0, fraction)))
        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(TWTheme.surface3)
                Capsule().fill(color).frame(width: max(3, geo.size.width * f))
            }
        }
        .frame(height: 4)
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(TWTheme.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
    }
}

// MARK: - Fixture (SwiftUI preview seed)

extension WelcomeDashboard {
    /// Representative sample mirroring the Electron screenshots. Xcode-preview
    /// seed only — every real card passes the live `model.welcomeDashboard`
    /// (and renders nothing until it lands), so this never reaches users.
    public static var fixture: WelcomeDashboard {
        let daily: [DailyBucket] = (0..<30).map { i in
            // A gently varying series with one spike, no Date dependency.
            let base = [3, 9, 6, 7, 4, 1, 2, 5, 8, 11, 22, 7, 5, 9, 6, 4, 3, 8, 6,
                5, 7, 4, 6, 9, 5, 7, 6, 4, 5, 3]
            let label = i == 0 ? "May 18" : (i == 29 ? "Jun 16" : "")
            return DailyBucket(
                id: "d\(i)", dayLabel: label, tokens: base[i] * 100_000, costUsd: 0)
        }
        return WelcomeDashboard(
            favoriteModel: "GPT-5.5",
            favoriteProject: "so-mr-midi-has-asked-me",
            tokens24h: 364_000, currentStreak: 12, longestStreak: 15, activeDays: 28,
            longestThreadMs: 6_120_000, totalWallTimeMs: 62_940_000, peakHour: "2 PM",
            sessions: 99, messages: 802, totalTokens: 19_000_000, totalCostUsd: 0,
            avgSessionMs: 636_000, tokensPerSession: 188_000, wallTime24hMs: 212_000,
            comparisonText: "You've tracked 19M tokens across 7 providers.",
            hasActivity: true, lifetimeHasActivity: true,
            providerTokenTotals: [
                .init(provider: "gemini", tokens: 95_000_000),
                .init(provider: "codex", tokens: 9_000_000),
                .init(provider: "claude", tokens: 5_900_000),
                .init(provider: "kimi", tokens: 2_200_000),
                .init(provider: "cursor", tokens: 1_400_000),
                .init(provider: "ollama", tokens: 726_000),
                .init(provider: "grok", tokens: 93_000),
            ],
            modelBreakdown: [
                .init(id: "gpt-5.5", provider: "codex", label: "GPT-5.5",
                    inputTokens: 6_200_000, outputTokens: 20_300, percent: 33.6),
                .init(id: "opus", provider: "claude", label: "Claude Opus 4.8",
                    inputTokens: 4_900_000, outputTokens: 46_600, percent: 27.1),
                .init(id: "gem-pro", provider: "gemini", label: "Gemini Pro",
                    inputTokens: 2_200_000, outputTokens: 10_600, percent: 12.3),
                .init(id: "kimi", provider: "kimi", label: "Kimi K2.7 Code",
                    inputTokens: 572_000, outputTokens: 27_600, percent: 5.2),
                .init(id: "comp-fast", provider: "cursor", label: "Composer 2.5 Fast",
                    inputTokens: 852_000, outputTokens: 57_800, percent: 4.9),
            ],
            workspaceBreakdown: [
                .init(id: "dod", displayName: "Dungeons of Darkness",
                    tokens: 96_000_000, costUsd: 0, shareOfTotalTokens: 84),
                .init(id: "midi", displayName: "so-mr-midi-has-asked-me",
                    tokens: 5_700_000, costUsd: 0, shareOfTotalTokens: 5),
                .init(id: "codex-smoke", displayName: "codex-workbench-smoke-test",
                    tokens: 3_100_000, costUsd: 0, shareOfTotalTokens: 2.7),
                .init(id: "agbench", displayName: "AGBench",
                    tokens: 2_800_000, costUsd: 0, shareOfTotalTokens: 2.5),
            ],
            dailyBreakdown: daily,
            providerBreakdown: [
                .init(provider: "gemini", displayName: "Gemini",
                    tokens: 95_000_000, costUsd: 0, shareOfTotalTokens: 83),
                .init(provider: "codex", displayName: "Codex",
                    tokens: 9_000_000, costUsd: 0, shareOfTotalTokens: 7.8),
                .init(provider: "claude", displayName: "Claude",
                    tokens: 5_900_000, costUsd: 0, shareOfTotalTokens: 5.1),
                .init(provider: "kimi", displayName: "Kimi",
                    tokens: 2_200_000, costUsd: 0, shareOfTotalTokens: 1.9),
                .init(provider: "cursor", displayName: "Cursor",
                    tokens: 1_400_000, costUsd: 0, shareOfTotalTokens: 1.2),
                .init(provider: "ollama", displayName: "Ollama",
                    tokens: 726_000, costUsd: 0, shareOfTotalTokens: 0.6),
                .init(provider: "grok", displayName: "Grok",
                    tokens: 93_000, costUsd: 0, shareOfTotalTokens: 0.1),
            ])
    }
}

#Preview {
    ScrollView {
        WelcomeUsageDashboardCard(dashboard: .fixture, accent: TWTheme.chroma1Default)
            .padding()
    }
}
