// Sizing rules for anchored glass popovers (TWSharedViews.swift).
//
// A `.popover` neither scrolls nor shrinks to fit: hand it a panel taller than
// the space it has and the system centres the panel in the bounds it can give
// and CLIPS both ends, with no scroll affordance to say anything is missing —
// and the clipped band cannot be scrolled back, because the list inside scrolls
// within a viewport whose own top is off the balloon. These tests pin the two
// pure rules that keep that from happening, on the phone geometry that failed:
// a 402x874 device with the keyboard up and the ensemble roster row riding the
// top of the raised composer.

import Foundation
import SwiftUI
import Testing

@testable import TaskWraithUI

@Suite("Popover space budget")
struct PopoverSpaceBudgetTests {
    // 402x874 phone, keyboard up, focused composer ~250pt tall.
    private static let windowHeight: CGFloat = 874
    private static let safeTopY: CGFloat = 59
    private static let safeBottomInset: CGFloat = 34
    private static let keyboardHeight: CGFloat = 336
    private static let composerHeight: CGFloat = 250
    private static let anchorMinY: CGFloat = windowHeight - keyboardHeight - composerHeight  // 288
    private static let anchorMaxY: CGFloat = anchorMinY + 34
    private static let chromeAllowance: CGFloat = 56
    /// What `TWPopoverSpace.availableHeight(keyboardHeight:)` reports for the
    /// same device: safe height minus keyboard minus chrome.
    private static let safeAreaEstimate: CGFloat =
        (windowHeight - safeTopY - safeBottomInset) - keyboardHeight - chromeAllowance  // 389

    private static func anchored(_ arrowEdge: Edge) -> CGFloat {
        twPopoverAnchoredHeight(
            anchorMinY: anchorMinY,
            anchorMaxY: anchorMaxY,
            arrowEdge: arrowEdge,
            safeTopY: safeTopY,
            safeBottomY: windowHeight - max(keyboardHeight, safeBottomInset),
            sideAnchoredHeight: safeAreaEstimate,
            chromeAllowance: chromeAllowance)
    }

    /// `.bottom` = the balloon sits ABOVE its anchor, so the budget is the gap
    /// up to the safe-area top — and nothing like the safe-area estimate the
    /// panel used to size against.
    @Test func upwardBalloonIsBoundedByTheGapAboveItsAnchor() {
        let budget = Self.anchored(.bottom)
        #expect(budget == Self.anchorMinY - Self.safeTopY - Self.chromeAllowance)
        #expect(budget == 173)
        // The bug in one line: the old estimate promised more than twice the
        // room that actually exists on this side of the anchor.
        #expect(Self.safeAreaEstimate > budget * 2)
    }

    /// The upward budget carries no keyboard term by design — the keyboard
    /// raises the composer, and therefore the anchor, which is what is measured.
    /// Charging for it again would bill it twice and starve the panel.
    @Test func upwardBudgetDoesNotDoubleChargeForTheKeyboard() {
        let raised = twPopoverAnchoredHeight(
            anchorMinY: Self.anchorMinY, anchorMaxY: Self.anchorMaxY, arrowEdge: .bottom,
            safeTopY: Self.safeTopY, safeBottomY: Self.windowHeight - Self.keyboardHeight,
            sideAnchoredHeight: Self.safeAreaEstimate, chromeAllowance: Self.chromeAllowance)
        // Same anchor, keyboard down: the budget must not change.
        let lowered = twPopoverAnchoredHeight(
            anchorMinY: Self.anchorMinY, anchorMaxY: Self.anchorMaxY, arrowEdge: .bottom,
            safeTopY: Self.safeTopY, safeBottomY: Self.windowHeight - Self.safeBottomInset,
            sideAnchoredHeight: Self.safeAreaEstimate, chromeAllowance: Self.chromeAllowance)
        #expect(raised == lowered)
    }

    /// `.top` = the balloon sits BELOW its anchor, where the keyboard IS the
    /// floor it would otherwise grow into.
    @Test func downwardBalloonIsBoundedByTheKeyboard() {
        let budget = Self.anchored(.top)
        #expect(budget == (Self.windowHeight - Self.keyboardHeight) - Self.anchorMaxY - Self.chromeAllowance)
        #expect(budget == 160)
    }

    /// A side-anchored balloon is centred on its anchor and grows both ways, so
    /// the whole safe height genuinely is available (the iPad roster fix).
    @Test func sideAnchoredBalloonKeepsTheSafeAreaBudget() {
        #expect(Self.anchored(.leading) == Self.safeAreaEstimate)
        #expect(Self.anchored(.trailing) == Self.safeAreaEstimate)
    }

    /// An anchor already under the ceiling must report no room, never negative
    /// room (which would invert the clamp downstream).
    @Test func budgetNeverGoesNegative() {
        let budget = twPopoverAnchoredHeight(
            anchorMinY: 40, anchorMaxY: 74, arrowEdge: .bottom,
            safeTopY: 59, safeBottomY: 538, sideAnchoredHeight: 389,
            chromeAllowance: Self.chromeAllowance)
        #expect(budget == 0)
    }
}

@Suite("Picker panel body clamp")
struct PickerPanelBodyClampTests {
    /// Drawn height of the whole balloon content: the body plus the grabber
    /// above it, both scaled.
    private func drawnHeight(body: CGFloat, scale: CGFloat) -> CGFloat {
        (twPickerGrabberHeight + body) * scale
    }

    /// The reported failure: the participant editor asks for 420pt of body at
    /// 0.70 scale — ~302pt drawn — with 173pt of gap above its chip. Clamped, it
    /// fits exactly; unclamped it overflowed by ~130pt, half off each end.
    @Test func participantEditorFitsTheMeasuredGap() {
        let budget: CGFloat = 173
        let clamped = twPickerClampedBodyHeight(
            requested: 420, available: budget, contentScale: 0.70)
        #expect(drawnHeight(body: clamped, scale: 0.70) <= budget + 0.01)
        // Unclamped, the panel drew ~302pt into a 173pt gap.
        #expect(drawnHeight(body: 420, scale: 0.70) > budget + 100)
    }

    /// With the keyboard down there is room to spare, and the clamp must not
    /// ration space that exists.
    @Test func roomyGapLeavesTheRequestedHeightAlone() {
        #expect(twPickerClampedBodyHeight(requested: 420, available: 600, contentScale: 0.70) == 420)
        #expect(twPickerClampedBodyHeight(requested: 276, available: 500, contentScale: 1) == 276)
    }

    /// The 200pt floor keeps a merely-cramped panel usable, but it must never
    /// win against a real measurement — a floor that overshoots the gap
    /// re-creates the clip it exists to prevent.
    @Test func floorNeverOvershootsTheBudget() {
        let budget: CGFloat = 100
        let clamped = twPickerClampedBodyHeight(
            requested: 420, available: budget, contentScale: 0.70)
        #expect(clamped < 200)
        #expect(drawnHeight(body: clamped, scale: 0.70) <= budget + 0.01)
    }

    /// The invariant the whole seam exists for: whatever the budget and scale,
    /// the drawn panel never exceeds the room its balloon has.
    @Test func drawnPanelNeverExceedsItsBudget() {
        for budget in stride(from: CGFloat(60), through: 900, by: 20) {
            for scale in [CGFloat(0.70), 0.85, 1] {
                let clamped = twPickerClampedBodyHeight(
                    requested: 420, available: budget, contentScale: scale)
                #expect(drawnHeight(body: clamped, scale: scale) <= budget + 0.01)
            }
        }
    }

    /// A degenerate scale must not divide by zero and blow the cap up.
    @Test func zeroScaleIsClampedNotDividedBy() {
        let clamped = twPickerClampedBodyHeight(requested: 420, available: 173, contentScale: 0)
        #expect(clamped.isFinite)
        #expect(clamped <= 420)
    }

    /// A degenerate anchor (no room at all) must never hand SwiftUI a negative
    /// frame height.
    @Test func zeroBudgetStaysPositive() {
        #expect(twPickerClampedBodyHeight(requested: 420, available: 0, contentScale: 0.70) > 0)
    }
}
