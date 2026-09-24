// TaskWraith iOS — workspace pane header chrome (File Editor + Diff Studio).
//
// Both panes carry the same bar: a back affordance, the file's identity, and a
// run of actions. It shipped as `.buttonStyle(.bordered)` throughout, which
// renders every control as a filled capsule — a row of pills that reads louder
// than the diff or the source underneath it.
//
// The louder failure was layout. An HStack of Labels has no compression policy,
// so inside a NavigationSplitView detail column (~440–570pt on an 11-inch iPad)
// SwiftUI shrank each control toward its minimum and let the TEXT wrap: "Back
// to app" became "Back / to app", and the six action pills became tall
// one-glyph-wide columns of stacked characters.
//
// Two rules fix it, and both are worth not regressing:
//
//  1. **Nothing in this bar wraps.** Every control is `.lineLimit(1)` and
//     `.fixedSize(horizontal:)`, so it holds its intrinsic width or is dropped
//     to a glyph — it never compresses into a character column. The TITLE is
//     the single flexible element and it truncates instead, with the path
//     truncating in the MIDDLE because its tail is the filename.
//
//  2. **What cannot fit becomes a glyph, and the decision is budgeted against
//     the measured pane width — never the size class.** A split view's columns
//     report a COMPACT horizontal size class (DESIGN.md v0.13, "the size-class
//     trap"), which is exactly why the iPad pane is handed `compact: false` and
//     then rendered full-width labels at 570pt. `TWWorkspaceHeaderPolicy` reads
//     the pane instead.

import SwiftUI
import TaskWraithKit

// ── Width budget ──────────────────────────────────────────────────────────────

/// How much wording a workspace pane header can afford at a given pane width.
struct TWWorkspaceHeaderLayout: Equatable {
    /// Actions render icon + text rather than a bare glyph.
    var actionsShowLabels: Bool
    /// The back control keeps its wording rather than collapsing to a chevron.
    var backShowsLabel: Bool
}

/// Width budget for the File Editor and Diff Studio pane headers.
///
/// The action run is the elastic half and the title is the floor, which is the
/// inverse of what an unmanaged HStack does. Order of sacrifice, cheapest
/// first: action wording, then the title's comfortable width, then — last,
/// because it is the pane's primary escape — the back control's wording.
///
/// The point costs below are ESTIMATES of rendered width, so they are rounded
/// up. Overshooting drops to glyphs one step early; undershooting overflows the
/// bar, and only one of those is visible to the reader.
enum TWWorkspaceHeaderPolicy {
    /// One SF Symbol at `.subheadline`.
    static let glyphWidth: CGFloat = 18
    /// `Label`'s icon-to-title gap.
    static let labelGap: CGFloat = 5
    /// Mean advance of SF Pro Text at `.subheadline`, taken across the actual
    /// action vocabulary ("Show Diff", "Unstage", "Open in Files").
    static let perCharacter: CGFloat = 8
    /// Horizontal padding baked into `TWChromeActionButtonStyle`, both edges.
    static let controlPadding: CGFloat = 12
    /// Minimum tappable width of a glyph-only control — the button style's own
    /// `minWidth`, which also supplies the visual gap between adjacent glyphs.
    static let glyphControlWidth: CGFloat = 34
    /// Filename plus a readable stretch of its path.
    static let titleFloor: CGFloat = 128
    /// The point past which the title is a stub, but still worth more than the
    /// back control's wording.
    static let titleMinimum: CGFloat = 64
    /// The bar's own horizontal padding, both edges.
    static let barPadding: CGFloat = 24
    /// Gaps flanking the title.
    static let sectionGaps: CGFloat = 20

    /// Rendered width of one control.
    static func controlWidth(title: String, showsLabel: Bool) -> CGFloat {
        guard showsLabel else { return glyphControlWidth }
        return glyphWidth + labelGap + CGFloat(title.count) * perCharacter + controlPadding
    }

    /// Rendered width of a run of actions. Adjacent controls need no explicit
    /// spacing — each already carries `controlPadding`.
    static func runWidth(titles: [String], showsLabels: Bool) -> CGFloat {
        titles.reduce(CGFloat.zero) { $0 + controlWidth(title: $1, showsLabel: showsLabels) }
    }

    /// Growth of the bar's text relative to `.large`, by Dynamic Type step.
    /// Only the ramp matters — the costs above are already rounded up.
    static func textGrowth(_ size: DynamicTypeSize) -> CGFloat {
        switch size {
        case .xSmall: return 0.88
        case .small: return 0.92
        case .medium: return 0.96
        case .large: return 1.00
        case .xLarge: return 1.12
        case .xxLarge: return 1.24
        case .xxxLarge: return 1.35
        case .accessibility1: return 1.6
        case .accessibility2: return 1.9
        case .accessibility3: return 2.2
        case .accessibility4: return 2.6
        case .accessibility5: return 3.1
        @unknown default: return 1.00
        }
    }

    /// The wording a header of `paneWidth` can seat.
    ///
    /// `trailingReserved` is any non-button chrome pinned after the actions (the
    /// Diff Studio viewer's ± chips). All costs are UNSCALED points, so the pane
    /// is divided by the growth factor rather than the constants multiplied by
    /// it.
    ///
    /// The two growth axes are taken as a MAX, not a product. `twAppScale`
    /// already shifts `dynamicTypeSize` in step with the app scale, so
    /// multiplying them would charge the same growth twice; taking the larger
    /// keeps the estimate conservative on whichever axis the reader actually
    /// moved. Without the type-size half a reader on an accessibility text size
    /// gets a bar whose labels no longer fit the width they were budgeted for,
    /// which is where the wrapping came from in the first place.
    static func layout(
        paneWidth: CGFloat,
        backTitle: String,
        actionTitles: [String],
        trailingReserved: CGFloat = 0,
        scale: TWAppScale = .standard,
        typeSize: DynamicTypeSize = .large
    ) -> TWWorkspaceHeaderLayout {
        let growth = max(scale.multiplier, textGrowth(typeSize))
        let budget = paneWidth / max(growth, 0.01)
        let backLabelled = controlWidth(title: backTitle, showsLabel: true)
        let labelledRun = runWidth(titles: actionTitles, showsLabels: true)
        let glyphRun = runWidth(titles: actionTitles, showsLabels: false)
        let chrome = barPadding + sectionGaps + trailingReserved

        if chrome + titleFloor + backLabelled + labelledRun <= budget {
            return TWWorkspaceHeaderLayout(actionsShowLabels: true, backShowsLabel: true)
        }
        if chrome + titleMinimum + backLabelled + glyphRun <= budget {
            return TWWorkspaceHeaderLayout(actionsShowLabels: false, backShowsLabel: true)
        }
        return TWWorkspaceHeaderLayout(actionsShowLabels: false, backShowsLabel: false)
    }
}

// ── Borderless controls ───────────────────────────────────────────────────────

/// Emphasis for a chrome action. The bar is deliberately monochrome apart from
/// its two ends: the back control and the pane's primary action carry the
/// accent, and a destructive action carries the failure hue.
enum TWChromeActionTone {
    case standard
    case prominent
    case destructive
}

/// Borderless press response for a workspace header action — tint and weight
/// only, no capsule and no fill. The chrome bar already supplies the plane
/// these sit on; a container per control just restates it six times.
struct TWChromeActionButtonStyle: ButtonStyle {
    var tone: TWChromeActionTone = .standard
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.appScale) private var appScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(tone == .standard ? .medium : .semibold))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(isEnabled ? enabledTint : TWTheme.textMuted)
            .padding(.horizontal, appScale.scaled(6))
            .padding(.vertical, appScale.scaled(6))
            .frame(
                minWidth: appScale.scaled(TWWorkspaceHeaderPolicy.glyphControlWidth),
                minHeight: appScale.scaled(TWWorkspaceHeaderPolicy.glyphControlWidth))
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.5 : 1)
            .scaleEffect(reduceMotion || !configuration.isPressed ? 1 : 0.94)
            .animation(
                reduceMotion
                    ? .easeOut(duration: 0.12)
                    : .spring(response: 0.24, dampingFraction: 0.7),
                value: configuration.isPressed)
    }

    private var enabledTint: Color {
        switch tone {
        case .standard: return TWTheme.textPrimary
        case .prominent: return TWTheme.chroma1
        case .destructive: return TWTheme.statusFailed
        }
    }
}

/// One action in a workspace pane header. Icon plus wording when the bar can
/// afford it, a bare glyph when it cannot — the wording survives as the
/// accessibility label either way, so collapsing never leaves a control
/// nameless to VoiceOver.
struct TWChromeActionLabel: View {
    let title: String
    let systemImage: String
    var showsLabel: Bool = true

    var body: some View {
        Group {
            if showsLabel {
                Label(title, systemImage: systemImage)
            } else {
                Image(systemName: systemImage)
            }
        }
        .lineLimit(1)
        .accessibilityLabel(title)
    }
}

/// The pane's escape hatch. Always first, always one line, and never allowed to
/// compress — at the narrowest tier it drops to its chevron rather than
/// stacking its words.
struct TWChromeBackButton: View {
    let title: String
    var showsLabel: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            TWChromeActionLabel(
                title: title, systemImage: "chevron.left", showsLabel: showsLabel)
        }
        .buttonStyle(TWChromeActionButtonStyle(tone: .prominent))
        .fixedSize(horizontal: true, vertical: false)
    }
}

/// File identity for a workspace pane header: name, an optional adjacent badge,
/// and the path beneath it.
///
/// This is the ONLY flexible element in the bar. It absorbs whatever the
/// controls leave and truncates rather than wrapping; the path truncates in the
/// MIDDLE, because a path's tail is its filename and that is the half a reader
/// needs when the head is `src/renderer/src/components/...`.
struct TWWorkspaceHeaderTitle<Badge: View>: View {
    let name: String
    let subtitle: String
    @ViewBuilder let badge: () -> Badge

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(name)
                    .font(.headline)
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                badge()
                Spacer(minLength: 0)
            }
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(TWTheme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

extension TWWorkspaceHeaderTitle where Badge == EmptyView {
    init(name: String, subtitle: String) {
        self.init(name: name, subtitle: subtitle, badge: { EmptyView() })
    }
}
