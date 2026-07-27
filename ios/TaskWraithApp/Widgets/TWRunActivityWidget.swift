// The Live Activity widget: lock screen + Dynamic Island for an in-flight run.
//
// Four PRECOMPILED archetypes, selected by `context.attributes.config.archetype`.
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

private struct DiffCounts: View {
    let state: TWRunActivityState
    let palette: TWActivityPalette

    var body: some View {
        HStack(spacing: 6) {
            if state.filesChanged > 0 {
                Text("\(state.filesChanged)f")
            }
            if state.additions > 0 {
                Text("+\(state.additions)").foregroundStyle(Color(rgb: palette.success))
            }
            if state.deletions > 0 {
                Text("-\(state.deletions)").foregroundStyle(Color(rgb: palette.failure))
            }
        }
        .monospacedDigit()
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

// MARK: - Lock screen

private struct LockScreenView: View {
    let config: TWRunActivityConfig
    let state: TWRunActivityState
    let isStale: Bool

    private var palette: TWActivityPalette { config.palette }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: state.phase.glyph)
                .font(.title3)
                .foregroundStyle(phaseTint(state.phase, palette: palette))

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(config.provider.capitalized).font(.headline)
                    if config.archetype != .attention {
                        Text(isStale ? "Out of contact" : state.phase.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
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
                    Label(config.provider.capitalized, systemImage: state.phase.glyph)
                        .font(.caption)
                        .foregroundStyle(tint)
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
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: state.phase.glyph)
                    .foregroundStyle(tint)
            } compactTrailing: {
                // The compact region is a few points wide — one signal only.
                // Elapsed beats counts here: it is legible at a glance and does
                // not change width as the numbers grow.
                if config.archetype == .ensemble, !state.seats.isEmpty, !isStale {
                    Text("\(state.seatsFinished)/\(state.seats.count)")
                        .font(.caption2).monospacedDigit()
                } else {
                    ElapsedText(startedAt: state.startedAt, phase: state.phase, isStale: isStale)
                        .font(.caption2)
                        .frame(maxWidth: 44)
                }
            } minimal: {
                Image(systemName: state.phase.glyph)
                    .foregroundStyle(tint)
            }
            .keylineTint(chromeTint(state.phase, palette: palette))
        }
    }
}
