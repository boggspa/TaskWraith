import Foundation
import SwiftUI
import TaskWraithKit
import Testing

@testable import TaskWraithUI

/// The File Editor and Diff Studio pane headers used to lay out from the size
/// class, which inside a NavigationSplitView column always reads compact — so
/// the iPad detail pane was handed full-width labels no matter how narrow it
/// actually was, and SwiftUI wrapped them CHARACTER BY CHARACTER ("Back / to
/// app", a "Stage" pill six lines tall). These pin the budget that replaced it.
@Suite("Workspace pane header budget")
struct WorkspaceHeaderPolicyTests {
    /// The file editor's bar, which is fixed — its actions disable, they never
    /// leave — so the budget always sees all six.
    private static let editorActions = [
        "Delete", "Show Diff", "Stage", "Unstage", "Commit", "Save"
    ]
    private static let backTitle = "Back to app"

    private static func layout(
        _ paneWidth: CGFloat,
        actions: [String] = editorActions,
        back: String = backTitle,
        trailingReserved: CGFloat = 0,
        scale: TWAppScale = .standard,
        typeSize: DynamicTypeSize = .large
    ) -> TWWorkspaceHeaderLayout {
        TWWorkspaceHeaderPolicy.layout(
            paneWidth: paneWidth,
            backTitle: back,
            actionTitles: actions,
            trailingReserved: trailingReserved,
            scale: scale,
            typeSize: typeSize)
    }

    /// Total width a layout actually asks for, at the title width it is
    /// entitled to. This is the sum the bar overflowed when nothing budgeted it.
    private static func demand(
        _ layout: TWWorkspaceHeaderLayout,
        actions: [String],
        back: String,
        trailingReserved: CGFloat
    ) -> CGFloat {
        let title =
            layout.actionsShowLabels
            ? TWWorkspaceHeaderPolicy.titleFloor : TWWorkspaceHeaderPolicy.titleMinimum
        return TWWorkspaceHeaderPolicy.barPadding + TWWorkspaceHeaderPolicy.sectionGaps
            + trailingReserved + title
            + TWWorkspaceHeaderPolicy.controlWidth(title: back, showsLabel: layout.backShowsLabel)
            + TWWorkspaceHeaderPolicy.runWidth(
                titles: actions, showsLabels: layout.actionsShowLabels)
    }

    /// 13-inch landscape: 1366pt minus the ~350pt navigator leaves ~1016pt, and
    /// at that width every action is worth spelling out.
    @Test func aWideLandscapePaneSpellsEveryActionOut() {
        let layout = Self.layout(1016)
        #expect(layout.actionsShowLabels)
        #expect(layout.backShowsLabel)
    }

    /// The reported case. A ~950pt window leaves the detail column ~570pt —
    /// which the shipped code treated identically to the 1016pt one, because
    /// both are `compact: false`. Six labelled actions need 801pt, so this pane
    /// must take glyphs; what it must NOT do is keep the labels and wrap them.
    @Test func theReportedSplitPaneTakesGlyphsRatherThanWrapping() {
        let layout = Self.layout(570)
        #expect(!layout.actionsShowLabels)
        #expect(layout.backShowsLabel)
        #expect(
            Self.demand(layout, actions: Self.editorActions, back: Self.backTitle,
                trailingReserved: 0) <= 570)
    }

    /// Order of sacrifice. The back control is the pane's only escape, so its
    /// wording outlives the action wording at every width — never the reverse.
    @Test func theBackControlIsTheLastWordingToGo() {
        for pane in stride(from: CGFloat(280), through: 1400, by: 2) {
            let layout = Self.layout(pane)
            if layout.actionsShowLabels {
                #expect(
                    layout.backShowsLabel,
                    "pane \(pane) spelled its actions out but abbreviated the way back")
            }
        }
    }

    /// The invariant the wrapping bug violated, swept rather than sampled: a
    /// chosen layout fits, and a REFUSED one was genuinely unaffordable. Without
    /// the second half this passes by always returning the narrowest tier.
    @Test func everyChosenLayoutFitsAndEveryRefusalWasEarned() {
        for pane in stride(from: CGFloat(280), through: 1400, by: 2) {
            let layout = Self.layout(pane)
            let asked = Self.demand(
                layout, actions: Self.editorActions, back: Self.backTitle, trailingReserved: 0)
            let isLastResort = !layout.actionsShowLabels && !layout.backShowsLabel
            if !isLastResort {
                #expect(asked <= pane, "pane \(pane) chose a layout needing \(asked)pt")
            }
            if !layout.actionsShowLabels {
                let labelled = TWWorkspaceHeaderLayout(
                    actionsShowLabels: true, backShowsLabel: true)
                #expect(
                    Self.demand(
                        labelled, actions: Self.editorActions, back: Self.backTitle,
                        trailingReserved: 0) > pane,
                    "pane \(pane) dropped to glyphs it could have afforded to label")
            }
        }
    }

    /// The Diff Studio bar is capability-GATED — a read-only workspace loses
    /// Stage and Unstage outright — so the same 570pt pane that cannot label
    /// six actions can comfortably label the one that remains.
    @Test func aReadOnlyDiffPaneBuysWordingWithTheActionsItLost() {
        let reserved = TWWorkspaceHeaderPolicy.glyphControlWidth + 76
        let granted = Self.layout(
            570, actions: ["Open in Files", "Stage", "Unstage"], trailingReserved: reserved)
        let readOnly = Self.layout(570, actions: ["Open in Files"], trailingReserved: reserved)
        #expect(!granted.actionsShowLabels)
        #expect(readOnly.actionsShowLabels)
    }

    /// The ± chips and the expand glyph carry no wording but do take width, so
    /// reserving them has to be able to change the answer.
    @Test func trailingChromeIsChargedAgainstTheSameBudget() {
        let bare = Self.layout(700, actions: ["Open in Files", "Stage", "Unstage"])
        let withChips = Self.layout(
            700, actions: ["Open in Files", "Stage", "Unstage"], trailingReserved: 110)
        #expect(bare.actionsShowLabels)
        #expect(!withChips.actionsShowLabels)
    }

    /// The bar is measured in unscaled points, so a reader on a larger app scale
    /// must collapse EARLIER at the same pane width, not render the same bar
    /// 10% wider than its column — and a reader on a smaller one earns wording
    /// back.
    ///
    /// The pairs below are the ones the app actually produces: `twAppScale`
    /// shifts `dynamicTypeSize` one step per scale step
    /// (`TWAppScale.adjustedDynamicTypeSize`), so a scale never arrives at this
    /// policy alongside the default text size.
    @Test func aLargerAppScaleCollapsesEarlier() {
        let larger = TWAppScale(rawValue: 1) ?? .standard
        #expect(Self.layout(820, scale: .standard, typeSize: .large).actionsShowLabels)
        #expect(!Self.layout(820, scale: larger, typeSize: .xLarge).actionsShowLabels)
        #expect(Self.layout(780, scale: .compact, typeSize: .medium).actionsShowLabels)
        #expect(!Self.layout(780, scale: .standard, typeSize: .large).actionsShowLabels)
    }

    /// The bar's wording grows with the reader's text size but its column does
    /// not, so an accessibility text size has to collapse the bar at a width
    /// that comfortably labels it at the default — otherwise the labels stop
    /// fitting the width they were budgeted for, which is the wrapping this
    /// whole policy exists to prevent.
    @Test func anAccessibilityTextSizeCollapsesTheBarEarlier() {
        #expect(Self.layout(1016, typeSize: .large).actionsShowLabels)
        #expect(!Self.layout(1016, typeSize: .accessibility1).actionsShowLabels)
        #expect(Self.layout(570, typeSize: .large).backShowsLabel)
        #expect(!Self.layout(570, typeSize: .accessibility3).backShowsLabel)
    }

    /// The app scale already shifts Dynamic Type in step with itself
    /// (`TWAppScale.adjustedDynamicTypeSize`), so the two axes are taken as a
    /// MAX rather than multiplied — charging both would collapse the bar at
    /// widths that render perfectly well.
    @Test func theTwoGrowthAxesAreNotChargedTwice() {
        let scaled = Self.layout(
            900, scale: TWAppScale(rawValue: 1) ?? .standard, typeSize: .xLarge)
        let product = Self.layout(900 / (1.10 * 1.12), scale: .standard, typeSize: .large)
        #expect(scaled.actionsShowLabels)
        #expect(!product.actionsShowLabels)
    }

    /// A pane that has not been measured yet reports zero. It must resolve to
    /// the narrowest bar rather than the widest, so the first frame can never
    /// be the overflowing one.
    @Test func anUnmeasuredPaneTakesTheNarrowestBar() {
        let layout = Self.layout(0)
        #expect(!layout.actionsShowLabels)
        #expect(!layout.backShowsLabel)
    }

    /// The phone keeps its wording. `FilesModeCompactView` labels its back
    /// control "Files" because it returns to the list rather than leaving the
    /// mode, and that is short enough that a 393pt iPhone seats it beside all
    /// six glyphs — the phone loses no wording it had.
    @Test func thePhoneKeepsItsBackWording() {
        let layout = Self.layout(393, back: "Files")
        #expect(layout.backShowsLabel)
        #expect(!layout.actionsShowLabels)
        #expect(
            Self.demand(layout, actions: Self.editorActions, back: "Files", trailingReserved: 0)
                <= 393)
    }

    /// 11-inch portrait is the narrowest iPad detail column the Diff Studio
    /// viewer gets (834pt minus its navigator). It must still name the way out.
    @Test func theNarrowestIpadDiffPaneStillNamesTheWayOut() {
        let layout = Self.layout(
            484,
            actions: ["Open in Files", "Stage", "Unstage"],
            trailingReserved: TWWorkspaceHeaderPolicy.glyphControlWidth + 76)
        #expect(layout.backShowsLabel)
        #expect(!layout.actionsShowLabels)
    }
}
