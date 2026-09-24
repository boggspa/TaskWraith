import Foundation
import TaskWraithKit

// iPad two-across fan-out lanes + six-plus compact band (desktop parity,
// 2026-09). Desktop reference: `classifyFanoutLaneSlots` and
// `classifyCompactFanoutLaneRows` in
// `src/renderer/src/lib/fanoutLanePairing.ts`. Placement there is a CSS grid;
// here ThreadDetailViews zips adjacent lane display items into an HStack pair
// using the run pairing below. The compact band VALUE deliberately does not
// copy desktop's 166 — the iOS bands are phone-sized (see the
// TWFanoutResultViewport height note in ThreadDetailViews).

/// Lane count at which a run of adjacent fan-out result rows drops to the
/// compact collapsed band. Desktop `FANOUT_LANE_COMPACT_THRESHOLD` parity: at
/// six-plus, full-band lanes mean the reader sees only a sliver of the round
/// at once, so the whole run trades resting height for overview.
let twFanoutLaneCompactThreshold = 6

/// One two-across placement for a run of adjacent lane rows. `solo` spans the
/// full column — an odd lane count is ordinary (three scouts, five workers),
/// and a half-width card beside a hole reads as a rendering fault.
enum TWFanoutLanePlacement: Equatable, Identifiable {
    case pair(lead: RemoteThreadSnapshot.Row, trail: RemoteThreadSnapshot.Row)
    case solo(RemoteThreadSnapshot.Row)

    /// Anchored on the LEAD row so identity stays stable while later lanes
    /// stream in: appending a lane may only change the run's last placement.
    var id: String {
        switch self {
        case .pair(let lead, _): return "fanout-pair-\(lead.id)"
        case .solo(let row): return "fanout-solo-\(row.id)"
        }
    }
}

func twIsFanoutLaneRow(_ row: RemoteThreadSnapshot.Row) -> Bool {
    row.fanoutResult != nil
}

/// Pair one run of ADJACENT lane rows two-across, pairing off from the run's
/// start (desktop `classifyFanoutLaneSlots` parity — stability while lanes
/// stream in). The caller identifies the run; any other row kind ends it.
func twPairFanoutLaneRun(_ rows: [RemoteThreadSnapshot.Row]) -> [TWFanoutLanePlacement] {
    var placements: [TWFanoutLanePlacement] = []
    var cursor = 0
    while cursor < rows.count {
        if cursor + 1 < rows.count {
            placements.append(.pair(lead: rows[cursor], trail: rows[cursor + 1]))
            cursor += 2
        } else {
            placements.append(.solo(rows[cursor]))
            cursor += 1
        }
    }
    return placements
}

/// Whether fan-out lanes lay two-across at all: iPad only, and only at
/// regular width. A slide-over narrow iPad reads like a phone, and a
/// landscape Max iPhone reports regular width but deliberately stays
/// single-column — the phone band is sized for one lane per line.
func twFanoutLanePairingEnabled(isPadInterface: Bool, isRegularWidth: Bool) -> Bool {
    isPadInterface && isRegularWidth
}

/// Row ids of every fan-out result row sitting in a run of
/// `twFanoutLaneCompactThreshold`-or-more ADJACENT lane rows. The crossing is
/// deliberately retroactive (desktop `classifyCompactFanoutLaneRows` parity):
/// when the sixth lane streams in, the first five join the set too, so a wave
/// never mixes bands mid-round. Adjacency is the same notion pairing uses —
/// any other row kind ends the run.
func twCompactFanoutLaneRowIds(_ rows: [RemoteThreadSnapshot.Row]) -> Set<String> {
    var compact: Set<String> = []
    var index = 0
    while index < rows.count {
        guard twIsFanoutLaneRow(rows[index]) else {
            index += 1
            continue
        }
        var end = index + 1
        while end < rows.count, twIsFanoutLaneRow(rows[end]) { end += 1 }
        if end - index >= twFanoutLaneCompactThreshold {
            for cursor in index..<end { compact.insert(rows[cursor].id) }
        }
        index = end
    }
    return compact
}
