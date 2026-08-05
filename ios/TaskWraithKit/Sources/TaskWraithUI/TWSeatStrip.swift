import SwiftUI
import TaskWraithKit

/*
 * TWSeatStrip — one participant's seat, rendered as the composer's own chips:
 * [provider logo] Provider · Model · Reasoning, then the permission tier with
 * its grants count, then #N Role in the provider accent.
 *
 * Two surfaces share it, exactly as on the desktop: the round close-out table's
 * Seat cell (decoded out of an `ensemble-seat://` link) and the authoritative
 * seat-change transcript row (decoded out of the projected `row.seatChange`).
 *
 * MOTION CONTRACT (desktop parity, deliberately not a pixel port). The strip
 * mounts showing the BEFORE seat, holds it for two seconds so the old config
 * can be read, then transitions to AFTER — replaying on every appearance,
 * because the strip is a record of a change and encountering it is when the
 * change should be shown. What it does NOT port is the desktop's per-character
 * odometer: this codebase's motion pass already settled that question for
 * ticking labels (see NumericTickText — "keep native contentTransition, do NOT
 * port Electron's DigitOdometer wheel"), and a per-segment crossfade is the
 * right weight at phone scale. Reduce Motion keeps the two-second hold — the
 * information, which is that the seat used to be something else — and drops the
 * animation, exactly as ChipReasoningSuffix keeps its hue and freezes its
 * sparkles.
 *
 * MODEL LABEL divergence, signed off: the model name comes from the iOS
 * catalogue (`twModelVariantLabel`), so a Claude seat reads "Opus 5" where the
 * desktop transcript row says "Claude Opus 5". Mirroring the desktop's string
 * table into Swift would put a second model catalogue on the far side of a
 * process boundary, which is a known and expensive bug class here.
 */

/// Every string one side of the strip renders. Pure (no colours, no views) so
/// the vocabulary is unit-testable without a host.
struct TWSeatStripSide: Equatable {
    let provider: String
    let model: String
    let providerLabel: String
    let modelLabel: String
    /// "" when the seat has no reasoning to show (no effort token, thinking
    /// off, or an explicit `off`) — the desktop suppresses the chip tail then.
    let reasoningLabel: String
    /// The effort token driving the shimmer/sparkle ladder. Kimi's thinking
    /// toggle reports as the ladder's `on` stop, which is where it sits.
    let reasoningToken: String
    let permissionLabel: String
    /// "" when the seat holds no workspace grants.
    let grantsLabel: String
    /// "#8 GemProWork", "GemProWork", or "" — the approval-modal vocabulary.
    let roleLabel: String
}

func twSeatStripSide(_ state: TWSeatChangeState) -> TWSeatStripSide {
    let modelLabel = twModelVariantLabel(provider: state.provider, model: state.model) ?? state.model
    let effort = (state.reasoningEffort ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    // Kimi's thinking toggle is a separate input from the effort ladder but
    // produces the same chip suffix, so a seat with no effort and thinking on
    // still shows one. `off` shows nothing, matching the desktop chip.
    let token = effort.isEmpty ? (state.thinkingEnabled == true ? "on" : "") : effort
    let reasoningLabel =
        (token.isEmpty || token == "off")
        ? "" : twReasoningDisplayLabel(token, provider: state.provider)
    let grants = state.grantsCount ?? 0
    let role = (state.role ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let roleLabel: String
    if role.isEmpty {
        roleLabel = ""
    } else if let seatNumber = state.seatNumber, seatNumber > 0 {
        roleLabel = "#\(seatNumber) \(role)"
    } else {
        roleLabel = role
    }
    return TWSeatStripSide(
        provider: state.provider,
        model: state.model,
        providerLabel: TWTheme.providerLabel(
            state.provider, modelId: state.model, modelLabel: modelLabel),
        modelLabel: modelLabel,
        reasoningLabel: reasoningLabel,
        reasoningToken: token,
        permissionLabel: TWPermissionTiers.label(state.permissionPresetId),
        grantsLabel: grants > 0 ? "\(grants) grant\(grants == 1 ? "" : "s")" : "",
        roleLabel: roleLabel)
}

/// Spoken form of one side — the seat read out as a sentence rather than as a
/// row of chips VoiceOver would otherwise announce field by field.
func twSeatStripSpokenLabel(_ side: TWSeatStripSide) -> String {
    var parts: [String] = []
    if !side.roleLabel.isEmpty { parts.append(side.roleLabel) }
    parts.append(side.providerLabel)
    if !side.modelLabel.isEmpty { parts.append(side.modelLabel) }
    if !side.reasoningLabel.isEmpty { parts.append("\(side.reasoningLabel) reasoning") }
    parts.append(side.permissionLabel)
    if !side.grantsLabel.isEmpty { parts.append(side.grantsLabel) }
    return parts.joined(separator: ", ")
}

/// Full accessibility sentence for the strip: the seat now, and — only when it
/// actually moved — what it was before.
func twSeatStripAccessibilityLabel(before: TWSeatStripSide, after: TWSeatStripSide) -> String {
    let now = "Seat: \(twSeatStripSpokenLabel(after))"
    guard before != after else { return now }
    return "\(now). Previously \(twSeatStripSpokenLabel(before))"
}

// MARK: - View

struct TWSeatStrip: View {
    let link: TWSeatChangeLink
    /// Transcript rows lead with the chair glyph and trail with the time; a
    /// table cell carries neither (the close-out header already dates the row).
    var showsChair: Bool = false
    var timestamp: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsAfter = false

    /// Owner call: two seconds is long enough to READ the old seat before it
    /// rolls. Shared with the desktop's pre-wait.
    private static let holdSeconds: UInt64 = 2

    private var before: TWSeatStripSide { twSeatStripSide(link.before) }
    private var after: TWSeatStripSide { twSeatStripSide(link.after) }
    private var current: TWSeatStripSide { showsAfter ? after : before }
    private var changed: Bool { before != after }

    private var accent: Color {
        TWTheme.providerAccent(
            current.provider, modelId: current.model, modelLabel: current.modelLabel)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                if showsChair {
                    Image(systemName: "chair.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(TWTheme.textMuted)
                        .accessibilityHidden(true)
                }
                clusterChip
            }
            HStack(spacing: 5) {
                permissionChip
                if !current.roleLabel.isEmpty {
                    Text(current.roleLabel)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .contentTransition(reduceMotion ? .identity : .opacity)
                }
                if let time = twSeatStripTime(timestamp) {
                    Spacer(minLength: 4)
                    Text(time)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                        .monospacedDigit()
                }
            }
        }
        .animation(
            reduceMotion ? ComposerMotion.reducedFade : .easeInOut(duration: 0.42),
            value: showsAfter
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(twSeatStripAccessibilityLabel(before: before, after: after))
        .task(id: link) {
            // Replay on every appearance, by design: reset, hold, then move.
            showsAfter = false
            guard changed else { return }
            try? await Task.sleep(for: .seconds(Self.holdSeconds))
            guard !Task.isCancelled else { return }
            showsAfter = true
        }
    }

    /// [logo] Provider · Model · Reasoning — the composer's collapsed picker
    /// chip, chip for chip.
    private var clusterChip: some View {
        HStack(spacing: 4) {
            ProviderLogoIcon(provider: current.provider, modelId: current.model, size: 12)
            Text(current.providerLabel)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
                .contentTransition(reduceMotion ? .identity : .opacity)
            if !current.modelLabel.isEmpty {
                Text("· \(current.modelLabel)")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
                    .contentTransition(reduceMotion ? .identity : .opacity)
            }
            if !current.reasoningLabel.isEmpty {
                // Same tiered treatment as the composer trigger; identity keyed
                // on the effort so a tier change restarts its sweep rather than
                // cross-fading two different shimmers into each other.
                ChipReasoningSuffix(
                    label: current.reasoningLabel,
                    effort: current.reasoningToken,
                    accent: accent
                )
                .id(current.reasoningToken)
                .lineLimit(1)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(Capsule().fill(TWTheme.surface3))
        .overlay(Capsule().strokeBorder(TWTheme.border, lineWidth: 0.5))
    }

    /// Tier label in the tier's own tint, plus the muted grants count.
    private var permissionChip: some View {
        let currentTier = TWPermissionTiers.tier(
            showsAfter ? link.after.permissionPresetId : link.before.permissionPresetId)
        return HStack(spacing: 4) {
            Image(systemName: currentTier.systemImage)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(currentTier.tint ?? TWTheme.textSecondary)
            Text(current.permissionLabel)
                .font(.caption2.weight(.medium))
                .foregroundStyle(currentTier.tint ?? TWTheme.textPrimary)
                .lineLimit(1)
                .contentTransition(reduceMotion ? .identity : .opacity)
            if !current.grantsLabel.isEmpty {
                Text("· \(current.grantsLabel)")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
                    .contentTransition(reduceMotion ? .identity : .opacity)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(Capsule().fill(TWTheme.surface3.opacity(0.55)))
        .overlay(
            Capsule().strokeBorder(
                currentTier.tint.map { $0.opacity(0.45) } ?? TWTheme.border,
                lineWidth: currentTier.tint == nil ? 0.5 : 1)
        )
        .accessibilityHidden(true)
    }
}

/// A markdown table cell that is entirely one `ensemble-seat://` link — the
/// shape the round close-out emits for its Seat column.
///
/// Returns nil for every other cell (which keeps its ordinary inline-markdown
/// rendering). Returns a nil `link` when the cell IS a seat cell whose href did
/// not decode: the caller must then render `text`, the full plain-text seat
/// description the Mac put in the link for exactly this reason. There is no
/// third outcome — a dead tappable link is never one of them, since nothing on
/// this device handles the scheme.
func twSeatTableCell(_ raw: String) -> (link: TWSeatChangeLink?, text: String)? {
    guard raw.contains(TWSeatChangeLinkCodec.prefix),
        let cell = twParseSoleMarkdownLinkCell(raw),
        cell.href.hasPrefix(TWSeatChangeLinkCodec.prefix)
    else { return nil }
    return (TWSeatChangeLinkCodec.decode(cell.href), cell.text)
}

/// Wall-clock stamp for a transcript seat-change row, in the transcript's own
/// timestamp vocabulary (today → "HH:mm", older → "d MMM, HH:mm"). nil for a
/// table cell (which passes none) or an unparseable time — never a fabricated
/// one.
func twSeatStripTime(_ timestamp: String?) -> String? {
    guard let timestamp, !timestamp.isEmpty else { return nil }
    return TWTranscriptTimestampFormat.footerCaption(iso: timestamp)
}
