import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

/// The seat strip's vocabulary — the strings the user actually READS off a
/// close-out row or a seat-change row — plus the two extractions it forced:
/// the reasoning label (Kimi's "Thinking" used to be spelled at one call site)
/// and the permission tier table (which had three copies).
@Suite("Ensemble seat strip (desktop parity)")
@MainActor
struct TWSeatStripTests {
    private func seat(
        provider: String,
        model: String = "",
        role: String? = nil,
        seatNumber: Int? = nil,
        reasoningEffort: String? = nil,
        thinkingEnabled: Bool? = nil,
        permissionPresetId: String? = nil,
        grantsCount: Int? = nil
    ) -> TWSeatChangeState {
        TWSeatChangeState(
            provider: provider, model: model, role: role, seatNumber: seatNumber,
            reasoningEffort: reasoningEffort, thinkingEnabled: thinkingEnabled,
            permissionPresetId: permissionPresetId, grantsCount: grantsCount)
    }

    // MARK: - Side vocabulary

    @Test func rendersProviderModelReasoningPermissionGrantsAndSeatRole() {
        let side = twSeatStripSide(
            seat(
                provider: "claude", model: "claude-opus-5", role: "GemProWork", seatNumber: 8,
                reasoningEffort: "max", permissionPresetId: "workspace_write", grantsCount: 2))
        #expect(side.providerLabel == "Claude")
        // iOS catalogue label, deliberately NOT desktop's "Claude Opus 5" — a
        // second model catalogue over the process boundary is the bug class
        // this divergence exists to avoid.
        #expect(side.modelLabel == "Opus 5")
        #expect(side.reasoningLabel == "Max")
        #expect(side.permissionLabel == "Full WS Access")
        #expect(side.grantsLabel == "2 grants")
        #expect(side.roleLabel == "#8 GemProWork")
    }

    @Test func aRoleWithoutASeatNumberDropsTheHashPrefix() {
        #expect(twSeatStripSide(seat(provider: "claude", role: "Lead")).roleLabel == "Lead")
        #expect(twSeatStripSide(seat(provider: "claude", seatNumber: 3)).roleLabel == "")
    }

    @Test func grantsCountIsSingularAtOneAndAbsentAtZero() {
        #expect(twSeatStripSide(seat(provider: "claude", grantsCount: 1)).grantsLabel == "1 grant")
        #expect(twSeatStripSide(seat(provider: "claude", grantsCount: 0)).grantsLabel == "")
        #expect(twSeatStripSide(seat(provider: "claude")).grantsLabel == "")
    }

    /// Kimi's thinking toggle is a SEPARATE input from the effort ladder. A
    /// seat that carries only the flag must still show the suffix, or the
    /// element renders a blank where the close-out's link text says Thinking.
    @Test func kimisThinkingFlagProducesTheSuffixWithNoReasoningEffort() {
        let on = twSeatStripSide(
            seat(provider: "kimi", model: "kimi-k2.7-code", thinkingEnabled: true))
        #expect(on.reasoningLabel == "Thinking")
        // The ladder's `on` stop — so the shimmer/sparkle tier matches the
        // composer's, rather than falling off the ladder to a plain suffix.
        #expect(on.reasoningToken == "on")
        let off = twSeatStripSide(
            seat(provider: "kimi", model: "kimi-k2.7-code", thinkingEnabled: false))
        #expect(off.reasoningLabel == "")
    }

    @Test func anOffOrAbsentEffortShowsNoReasoningAtAll() {
        #expect(twSeatStripSide(seat(provider: "claude", reasoningEffort: "off")).reasoningLabel == "")
        #expect(twSeatStripSide(seat(provider: "claude")).reasoningLabel == "")
        #expect(twSeatStripSide(seat(provider: "claude", reasoningEffort: " ")).reasoningLabel == "")
    }

    @Test func reasoningSpeaksEachProvidersOwnVocabulary() {
        #expect(
            twSeatStripSide(seat(provider: "codex", reasoningEffort: "xhigh")).reasoningLabel
                == "Extra High")
        #expect(
            twSeatStripSide(seat(provider: "claude", reasoningEffort: "xhigh")).reasoningLabel
                == "Extra")
        #expect(
            twSeatStripSide(seat(provider: "codex", reasoningEffort: "low")).reasoningLabel
                == "Light")
        #expect(
            twSeatStripSide(seat(provider: "grok", reasoningEffort: "low")).reasoningLabel == "Low")
    }

    // MARK: - Shared reasoning rule (extracted from the picker chip)

    @Test func theThinkingRuleLivesInOneSharedFunction() {
        #expect(twReasoningDisplayLabel("on", provider: "kimi") == "Thinking")
        #expect(twReasoningDisplayLabel("on", provider: "claude") == "On")
        #expect(twReasoningDisplayLabel("ultracode", provider: "codex") == "Ultra")
        #expect(twReasoningDisplayLabel("ultracode", provider: "claude") == "Ultracode")
    }

    // MARK: - Shared permission tier table

    @Test func thePermissionTableSpellsTheFivePresetsOnceForEverySurface() {
        #expect(TWPermissionTiers.all.map(\.id) == [
            "plan", "read_only", "default", "workspace_write", "full_access",
        ])
        #expect(TWPermissionTiers.all.map(\.label) == [
            "Plan", "Ask", "Accept Edits", "Full WS Access", "Full Access",
        ])
    }

    /// nil and an id a newer Mac invents both land on the neutral default
    /// rather than on an empty chip or a raw enum id.
    @Test func anUnknownOrAbsentPresetDegradesToAcceptEdits() {
        #expect(TWPermissionTiers.label(nil) == "Accept Edits")
        #expect(TWPermissionTiers.label("some_future_tier") == "Accept Edits")
        #expect(TWPermissionTiers.tier("some_future_tier").tint == nil)
        #expect(TWPermissionTiers.tier("full_access").tint == TWPermissionTiers.red)
    }

    // MARK: - Close-out table cell

    @Test func aCloseOutSeatCellResolvesToTheLiveSeat() {
        let cell = twSeatTableCell(
            "[@Builder · Codex · GPT-5.6-Sol · Ultra · Full WS Access]"
                + "(ensemble-seat://p1?p=codex&m=gpt-5.6-sol&role=Builder&n=1&r=ultracode"
                + "&k=workspace_write)")
        #expect(cell?.link?.after.provider == "codex")
        #expect(cell?.link?.after.seatNumber == 1)
        #expect(cell?.text == "@Builder · Codex · GPT-5.6-Sol · Ultra · Full WS Access")
        let side = twSeatStripSide(cell!.link!.after)
        #expect(side.reasoningLabel == "Ultra")
        #expect(side.permissionLabel == "Full WS Access")
    }

    /// Graceful degradation is mandatory: an href this build cannot decode
    /// still yields the plain-text description the Mac put in the link, and it
    /// is NOT left as a tappable link — nothing on this device handles the
    /// scheme, so a preserved link would be dead.
    @Test func anUndecodableSeatHrefFallsBackToTheLinkText() {
        let cell = twSeatTableCell("[@Lead · Claude · Opus 5](ensemble-seat://p1?x=1)")
        #expect(cell != nil)
        #expect(cell?.link == nil)
        #expect(cell?.text == "@Lead · Claude · Opus 5")
    }

    @Test func ordinaryCellsAreUntouched() {
        #expect(twSeatTableCell("**Round Total**") == nil)
        #expect(twSeatTableCell("939k Tks / 4 Turns") == nil)
        #expect(twSeatTableCell("[@Reviewer](ensemble-dm://p2)") == nil)
        // A seat link with prose beside it is not a seat CELL — leave the whole
        // cell to the ordinary markdown renderer.
        #expect(twSeatTableCell("seat [x](ensemble-seat://p1?p=claude&m=opus)") == nil)
    }

    // MARK: - Accessibility

    @Test func theSpokenLabelNamesThePreviousSeatOnlyWhenItActuallyMoved() {
        let after = twSeatStripSide(
            seat(
                provider: "claude", model: "claude-opus-5", role: "Lead", seatNumber: 1,
                reasoningEffort: "max", permissionPresetId: "default", grantsCount: 1))
        #expect(
            twSeatStripAccessibilityLabel(before: after, after: after)
                == "Seat: #1 Lead, Claude, Opus 5, Max reasoning, Accept Edits, 1 grant")
        let before = twSeatStripSide(
            seat(
                provider: "kimi", model: "kimi-k2.7-code", role: "Lead", seatNumber: 1,
                thinkingEnabled: true, permissionPresetId: "read_only"))
        let changed = twSeatStripAccessibilityLabel(before: before, after: after)
        #expect(changed.hasPrefix("Seat: #1 Lead, Claude"))
        #expect(changed.contains("Previously #1 Lead, Kimi, K2.7 Coding, Thinking reasoning, Ask"))
    }

    // MARK: - Transcript row time

    @Test func theRowStampsARealTimeOrNoneAtAll() {
        #expect(twSeatStripTime(nil) == nil)
        #expect(twSeatStripTime("") == nil)
        #expect(twSeatStripTime("not-a-date") == nil)
        #expect(twSeatStripTime("2026-08-05T12:00:00.000Z") != nil)
        #expect(twSeatStripTime("2026-08-05T12:00:00Z") != nil)
    }

    // MARK: - Transcript row (projected metadata.seatChange)

    private func seatChangeRow(withSeatChange: Bool) -> RemoteThreadSnapshot.Row {
        var object: [String: Any] = [
            "id": "ensemble-seat-change-r1",
            "role": "system",
            "kind": "system",
            "preview": "Authoritative seat change applied.",
            "truncated": false,
            "timestamp": "2026-08-05T12:00:00.000Z",
        ]
        if withSeatChange {
            object["seatChange"] = [
                "participantId": "p-8",
                "label": "GemProWork",
                "appliedAt": "2026-08-05T12:00:00.000Z",
                "before": [
                    "provider": "grok", "model": "grok-4.5", "role": "GemProWork",
                    "seatNumber": 8, "reasoningEffort": "high", "permissionPresetId": "default",
                ],
                "after": [
                    "provider": "claude", "model": "claude-opus-5", "role": "GemProWork",
                    "seatNumber": 8, "reasoningEffort": "max",
                    "permissionPresetId": "workspace_write", "grantsCount": 2,
                ],
            ]
        }
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(RemoteThreadSnapshot.Row.self, from: data)
    }

    @Test func aProjectedSeatChangeRowResolvesBothSides() {
        let row = seatChangeRow(withSeatChange: true)
        let link = row.seatChange?.renderableLink
        #expect(link?.before.provider == "grok")
        #expect(link?.after.provider == "claude")
        #expect(twSeatStripSide(link!.after).permissionLabel == "Full WS Access")
        #expect(twSeatStripSide(link!.after).grantsLabel == "2 grants")
    }

    /// The seat change is a plain SYSTEM row. Left foldable it collapses into
    /// "System · Authoritative seat change applied." — a line that says a change
    /// happened without saying what it was, which is the whole point of the row.
    @Test func aSeatChangeRowNeverFoldsIntoASystemNoticeSummary() {
        #expect(twIsPlainSystemNoticeRow(seatChangeRow(withSeatChange: true)) == false)
        // Same row from an older Mac (no projected seat) still folds — this
        // build changes nothing for a snapshot that carries no seat.
        #expect(twIsPlainSystemNoticeRow(seatChangeRow(withSeatChange: false)) == true)
    }
}
