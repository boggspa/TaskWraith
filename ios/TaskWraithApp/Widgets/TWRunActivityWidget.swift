// The Live Activity widget: lock screen + Dynamic Island for an in-flight run.
//
// Five PRECOMPILED archetypes, selected by `context.attributes.config.archetype`.
// A layout cannot travel over the wire — it is compiled SwiftUI — so the user's
// choice arrives as an id and this file switches on it. Adding an archetype is
// an app update; that is ActivityKit, not a limitation of the design.
//
// TIMERS, NOT TICKS: elapsed time renders with `Text(_:style:.timer)`, which
// counts locally. Pushing a new content-state every second would cost one APNs
// push per tick and exhaust the budget in a minute.
//
// ...WHICH IS WHY `isStale` MATTERS. A local timer keeps counting whether or not
// anyone is still updating this activity, and today updates only happen while
// the phone can reach the Mac. Past the staleDate the controller stamps
// (TWRunActivityLimits.staleWindow) ActivityKit flips `context.isStale`, and
// every layout below stops the clock and says it has lost contact. Without that
// a locked phone shows a run "still going" hours after it finished.
//
// NO INVENTED PROGRESS: `state.progress` is nil for solo runs because an agent
// run has no denominator. Only ensembles (seats finished / total) get a bar.
// Everything else gets an indeterminate pulse, which is honest.
//
// COLOUR COMES FROM THE WIRE, never from a table in here. `config.palette` is
// resolved app-side by TWRunActivityController (see TWActivityPalette). Links
// TaskWraithKit ONLY — never TaskWraithUI. An extension that pulled in
// UIKit/Runestone would blow its memory budget (same rule as the NSE).

import ActivityKit
import SwiftUI
import WidgetKit

import TaskWraithKit

// MARK: - Shared pieces

extension Color {
    fileprivate init(rgb: UInt32) {
        self.init(
            .sRGB,
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255,
            opacity: 1)
    }
}

extension TWRunPhase {
    fileprivate var label: String {
        switch self {
        case .running: return "Running"
        case .awaitingApproval: return "Needs approval"
        case .awaitingQuestion: return "Needs an answer"
        case .complete: return "Finished"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        }
    }

    /// What replaces the running clock once there is nothing left to time.
    /// "done" for everything would read as success on a failed run.
    fileprivate var terminalWord: String {
        switch self {
        case .complete: return "done"
        case .failed: return "failed"
        case .cancelled: return "stopped"
        default: return ""
        }
    }

    fileprivate var glyph: String {
        switch self {
        case .running: return "circle.dotted"
        case .awaitingApproval: return "hand.raised.fill"
        case .awaitingQuestion: return "questionmark.circle.fill"
        case .complete: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .cancelled: return "slash.circle"
        }
    }
}

/// Phase colour, entirely from the wire palette.
///
/// The accent is the PROVIDER's brand hue, so it must not also carry status.
/// Success and failure use the DIFF pair instead — the one red/green in the
/// product the user can define themselves, and already what the ± counts in
/// this same activity are painted with.
private func phaseTint(_ phase: TWRunPhase, palette: TWActivityPalette) -> Color {
    switch phase {
    case .running: return Color(rgb: palette.accent)
    case .awaitingApproval, .awaitingQuestion: return Color(rgb: palette.attention)
    case .complete: return Color(rgb: palette.success)
    case .failed: return Color(rgb: palette.failure)
    case .cancelled: return .secondary
    }
}

/// What tints the chrome (keyline, background wash).
///
/// While a run is live this is the provider's brand hue. Once it is OVER the
/// phase colour takes the chrome instead — which also settles a real collision:
/// several brand accents sit close enough to the failure red to be confusable
/// at a glance (OpenBMB #E22B17 is ΔE≈11 from the diff red, Mistral #D44404 is
/// ≈18). A red glyph on a red keyline loses the signal; a whole card that turns
/// red does not.
private func chromeTint(_ phase: TWRunPhase, palette: TWActivityPalette) -> Color {
    phase.isTerminal ? phaseTint(phase, palette: palette) : Color(rgb: palette.accent)
}

private struct ElapsedText: View {
    let startedAt: Date
    let phase: TWRunPhase
    let isStale: Bool

    var body: some View {
        if isStale {
            // The timer is local, so it would happily keep counting a run we
            // have not heard about in ten minutes. Say so instead.
            Label("no contact", systemImage: "antenna.radiowaves.left.and.right.slash")
                .labelStyle(.iconOnly)
        } else if phase.isTerminal {
            // A terminal run must STOP counting — a finished activity that keeps
            // ticking reads as still-running.
            Text(phase.terminalWord)
        } else {
            Text(startedAt, style: .timer)
                .monospacedDigit()
        }
    }
}

/// ActivityKit animates content-state changes; numericText gives changing
/// counters the same rolling-digit feel as TaskWraith's DigitOdometer without
/// spending extra pushes or running a local timer.
private struct OdometerMetric: View {
    let value: Int
    var prefix = ""
    var suffix = ""

    var body: some View {
        Text("\(prefix)\(value)\(suffix)")
            .monospacedDigit()
            .contentTransition(.numericText())
    }
}

private struct DiffCounts: View {
    let state: TWRunActivityState
    let palette: TWActivityPalette

    var body: some View {
        HStack(spacing: 6) {
            if state.filesChanged > 0 {
                OdometerMetric(value: state.filesChanged, suffix: "f")
            }
            if state.additions > 0 {
                OdometerMetric(value: state.additions, prefix: "+")
                    .foregroundStyle(Color(rgb: palette.success))
            }
            if state.deletions > 0 {
                OdometerMetric(value: state.deletions, prefix: "-")
                    .foregroundStyle(Color(rgb: palette.failure))
            }
        }
    }
}

private struct SeatDots: View {
    let seats: [TWSeatState]
    let palette: TWActivityPalette

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(seats.enumerated()), id: \.offset) { _, seat in
                Circle()
                    .fill(phaseTint(seat.phase, palette: palette))
                    .frame(width: 7, height: 7)
                    .opacity(seat.phase.isTerminal ? 1 : 0.45)
            }
        }
    }
}

/// The real TaskWraith monoline mark, rendered as a template so ActivityKit's
/// light/dark/vibrancy treatments remain legible. Intentionally no container:
/// boxing this fine linework makes it disappear at lock-screen scale.
private struct GhostMark: View {
    let tint: Color

    var body: some View {
        Image("ghost-mark-monoline")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .foregroundStyle(tint)
    }
}

private func providerArtwork(_ provider: String) -> String? {
    switch provider.lowercased() {
    case "codex", "openai": return "provider-logo-codex"
    case "claude", "anthropic": return "provider-logo-claude"
    case "kimi", "moonshot": return "provider-logo-kimi"
    case "cursor": return "provider-logo-cursor-on-dark"
    case "grok", "xai": return "provider-logo-grok-on-dark"
    case "mistral": return "provider-logo-mistral"
    case "gemini", "google": return "provider-logo-gemini"
    case "antigravity": return "provider-logo-antigravity"
    case "deepseek": return "provider-logo-deepseek"
    case "cerebras": return "provider-logo-cerebras-on-dark"
    case "ollama": return "provider-logo-ollama-on-dark"
    case "pi": return "provider-logo-pi-on-dark"
    case "ensemble": return "provider-glyph-ensemble"
    default: return nil
    }
}

private struct ProviderStack: View {
    let seats: [TWSeatState]
    let palette: TWActivityPalette

    private var shown: ArraySlice<TWSeatState> { seats.prefix(5) }

    var body: some View {
        ZStack(alignment: .leading) {
            ForEach(Array(shown.enumerated()), id: \.offset) { index, seat in
                Group {
                    if let artwork = providerArtwork(seat.provider) {
                        Image(artwork)
                            .resizable()
                            .scaledToFit()
                            .padding(2.5)
                    } else {
                        Circle()
                            .fill(phaseTint(seat.phase, palette: palette))
                            .padding(4)
                    }
                }
                .frame(width: 22, height: 22)
                .background(.black.opacity(0.68), in: Circle())
                .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: 0.75))
                .offset(x: CGFloat(index) * 14)
                .zIndex(Double(shown.count - index))
            }
        }
        .frame(width: shown.isEmpty ? 0 : CGFloat(22 + max(0, shown.count - 1) * 14), height: 22)
        .accessibilityLabel("\(seats.count) active providers")
    }
}

private struct GitDivergence: View {
    let ahead: Int
    let behind: Int

    var body: some View {
        HStack(spacing: 5) {
            OdometerMetric(value: ahead, prefix: "↑")
                .foregroundStyle(Color(rgb: 0xF5A623))
            OdometerMetric(value: behind, prefix: "↓")
                .foregroundStyle(Color(rgb: 0x5A8CFF))
        }
    }
}

// MARK: - Lock screen

private struct LockScreenView: View {
    let config: TWRunActivityConfig
    let state: TWRunActivityState
    let isStale: Bool

    private var palette: TWActivityPalette { config.palette }
    private var isWorkspace: Bool { config.archetype == .workspace }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if isWorkspace {
                GhostMark(tint: phaseTint(state.phase, palette: palette))
                    .frame(width: 28, height: 28)
            } else {
                Image(systemName: state.phase.glyph)
                    .font(.title3)
                    .foregroundStyle(phaseTint(state.phase, palette: palette))
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(isWorkspace ? "TaskWraith" : config.provider.capitalized).font(.headline)
                    if config.archetype != .attention {
                        statusLabel
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                detail
            }

            Spacer(minLength: 8)

            ElapsedText(startedAt: state.startedAt, phase: state.phase, isStale: isStale)
                .font(.system(.callout, design: .rounded))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .activityBackgroundTint(chromeTint(state.phase, palette: palette).opacity(0.12))
        // Desaturating the whole card is the strongest "do not trust this"
        // signal available without a second layout.
        .opacity(isStale ? 0.55 : 1)
    }

    @ViewBuilder
    private var statusLabel: some View {
        if isStale {
            Text("Out of contact")
        } else if isWorkspace, state.phase.needsUser {
            Text("Needs you")
        } else if isWorkspace {
            HStack(spacing: 3) {
                OdometerMetric(value: state.activeRuns)
                Text(state.activeRuns == 1 ? "run active" : "runs active")
            }
        } else {
            Text(state.phase.label)
        }
    }

    @ViewBuilder
    private var detail: some View {
        switch config.archetype {
        case .minimal:
            EmptyView()
        case .diff:
            DiffCounts(state: state, palette: palette)
                .font(.caption).foregroundStyle(.secondary)
        case .attention:
            Text(isStale ? "Out of contact" : state.phase.label)
                .font(.title3.weight(.semibold))
                .foregroundStyle(phaseTint(state.phase, palette: palette))
        case .ensemble:
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    SeatDots(seats: state.seats, palette: palette)
                    Text("\(state.seatsFinished)/\(state.seats.count)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                if let progress = state.progress {
                    ProgressView(value: progress)
                        .tint(Color(rgb: palette.accent))
                        .frame(maxWidth: 160)
                }
            }
        case .workspace:
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    ProviderStack(seats: state.seats, palette: palette)
                    if state.hasGitSnapshot {
                        DiffCounts(state: state, palette: palette)
                        GitDivergence(ahead: state.ahead, behind: state.behind)
                    } else {
                        Text("Git snapshot unavailable")
                            .foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }
        }
    }
}

// MARK: - Widget

@available(iOS 16.1, *)
struct TWRunActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TWRunActivityAttributes.self) { context in
            LockScreenView(
                config: context.attributes.config,
                state: context.state,
                isStale: context.isStale)
        } dynamicIsland: { context in
            let config = context.attributes.config
            let palette = config.palette
            let state = context.state
            let isStale = context.isStale
            let tint = phaseTint(state.phase, palette: palette)

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    if config.archetype == .workspace {
                        HStack(spacing: 5) {
                            GhostMark(tint: tint).frame(width: 18, height: 18)
                            Text("Workspace activity")
                        }
                        .font(.caption)
                        .foregroundStyle(tint)
                    } else {
                        Label(config.provider.capitalized, systemImage: state.phase.glyph)
                            .font(.caption)
                            .foregroundStyle(tint)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ElapsedText(startedAt: state.startedAt, phase: state.phase, isStale: isStale)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if isStale {
                        Text("Lost contact with your Mac")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        switch config.archetype {
                        case .minimal:
                            Text(state.phase.label).font(.caption).foregroundStyle(.secondary)
                        case .diff:
                            DiffCounts(state: state, palette: palette).font(.caption)
                        case .attention:
                            Text(state.phase.label)
                                .font(.headline)
                                .foregroundStyle(tint)
                        case .ensemble:
                            HStack(spacing: 8) {
                                SeatDots(seats: state.seats, palette: palette)
                                Text("\(state.seatsFinished)/\(state.seats.count)")
                                    .font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                            }
                        case .workspace:
                            HStack(spacing: 8) {
                                ProviderStack(seats: state.seats, palette: palette)
                                if state.phase.needsUser {
                                    Text("Needs you")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(tint)
                                } else {
                                    HStack(spacing: 3) {
                                        OdometerMetric(value: state.activeRuns)
                                        Text(state.activeRuns == 1 ? "run" : "runs")
                                    }
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                }
                                if state.hasGitSnapshot {
                                    DiffCounts(state: state, palette: palette).font(.caption)
                                    GitDivergence(ahead: state.ahead, behind: state.behind)
                                        .font(.caption)
                                }
                            }
                        }
                    }
                }
            } compactLeading: {
                if config.archetype == .workspace {
                    GhostMark(tint: tint).frame(width: 18, height: 18)
                } else {
                    Image(systemName: state.phase.glyph)
                        .foregroundStyle(tint)
                }
            } compactTrailing: {
                // The compact region is a few points wide — one signal only.
                // Elapsed beats counts here: it is legible at a glance and does
                // not change width as the numbers grow.
                if config.archetype == .workspace, !isStale {
                    if state.phase.needsUser {
                        Text("!").font(.caption2.weight(.semibold)).foregroundStyle(tint)
                    } else {
                        OdometerMetric(value: state.activeRuns)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                } else if config.archetype == .ensemble, !state.seats.isEmpty, !isStale {
                    Text("\(state.seatsFinished)/\(state.seats.count)")
                        .font(.caption2).monospacedDigit()
                } else {
                    ElapsedText(startedAt: state.startedAt, phase: state.phase, isStale: isStale)
                        .font(.caption2)
                        .frame(maxWidth: 44)
                }
            } minimal: {
                if config.archetype == .workspace {
                    GhostMark(tint: tint).frame(width: 16, height: 16)
                } else {
                    Image(systemName: state.phase.glyph)
                        .foregroundStyle(tint)
                }
            }
            .keylineTint(chromeTint(state.phase, palette: palette))
        }
    }
}
