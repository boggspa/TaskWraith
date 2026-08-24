import Foundation
import TaskWraithKit

/// Pure close-out-card policies shared by the transcript view and its tests.
/// The close-out marker is authored by the Mac, so it outranks an individual
/// participant run when describing an ensemble round's outcome.

func twHasCloseoutEpicTables(_ row: RemoteThreadSnapshot.Row) -> Bool {
  (row.closeoutParticipantTable?.rows?.isEmpty == false)
    || (row.closeoutCommits?.isEmpty == false)
    || (row.closeoutFileChanges?.isEmpty == false)
    || (row.closeoutSubThreads?.isEmpty == false)
}
private func twNormalizedCloseoutValue(_ value: String?) -> String {
  value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
}

private func twNormalizedCloseoutIdentifier(_ value: String?) -> String? {
  guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty
  else { return nil }
  return value
}

/// A run can have a stale `endedAt` while its status is still actively running;
/// active vocabulary therefore wins. Otherwise a valid end timestamp is
/// authoritative, with a closed terminal allow-list for status-only snapshots.
func twIsTerminalRunSummary(_ summary: RemoteThreadSnapshot.RunSummary) -> Bool {
  let status = twNormalizedCloseoutValue(summary.status)
  let activeStatuses: Set<String> = [
    "active", "cancelling", "canceling", "idle", "in_progress", "initializing", "paused",
    "pending", "preparing", "queued", "running", "sleeping", "starting", "steer_promoting",
    "waiting", "awaiting_approval", "blocked",
  ]
  if activeStatuses.contains(status) { return false }

  let terminalStatuses: Set<String> = [
    "cancelled", "canceled", "complete", "completed", "done", "error", "failed", "success",
    "success_with_warnings",
  ]
  if terminalStatuses.contains(status) { return true }
  return twNormalizedCloseoutIdentifier(summary.endedAt) != nil
}

func twIsTerminalCloseoutStatus(_ status: String?) -> Bool {
  twIsTerminalRunSummary(.init(status: status))
}

func twTaskCompleteIsFailure(_ status: String?) -> Bool {
  let status = twNormalizedCloseoutValue(status)
  return status == "failed" || status == "error"
}

func twTaskCompleteEffectiveStatus(
  closeoutStatus: String?,
  runStatus: String?,
  exitCode: Int?
) -> String? {
  if let closeoutStatus = twNormalizedCloseoutIdentifier(closeoutStatus) {
    return closeoutStatus
  }
  if let runStatus = twNormalizedCloseoutIdentifier(runStatus) {
    return runStatus
  }
  if exitCode == 130 { return "cancelled" }
  if let exitCode, exitCode != 0 { return "failed" }
  return nil
}

func twTaskCompleteTitle(for status: String?) -> String {
  let status = twNormalizedCloseoutValue(status)
  if status == "cancelled" || status == "canceled" { return "Run cancelled" }
  return twTaskCompleteIsFailure(status) ? "Run failed" : "Task complete"
}

/// Finds the round-owned close-out only when the Mac's explicit scope and
/// immutable round id agree. This deliberately refuses a final lane's result:
/// a lane is not authority for the completed/cancelled/failed round outcome.
func twAuthoritativeRoundCloseoutRow(
  roundId: String,
  rows: [RemoteThreadSnapshot.Row]
) -> RemoteThreadSnapshot.Row? {
  guard let expectedRoundId = twNormalizedCloseoutIdentifier(roundId) else { return nil }
  return rows.last { row in
    row.isCloseout == true
      && row.closeoutScope == "ensembleRound"
      && twNormalizedCloseoutIdentifier(row.closeoutRoundId) == expectedRoundId
  }
}

/// Selects evidence for a Task-complete card. New projections use the explicit
/// close-out marker above. The narrow legacy fallback is table-bearing and
/// TaskWraith-authored, so an arbitrary participant's final lane cannot become
/// a whole-round close-out just because it happened to be last.
func twPreferredCloseoutRow(
  for summary: RemoteThreadSnapshot.RunSummary,
  rows: [RemoteThreadSnapshot.Row]
) -> RemoteThreadSnapshot.Row? {
  if let roundId = twNormalizedCloseoutIdentifier(summary.ensembleRoundId) {
    if let authoritative = twAuthoritativeRoundCloseoutRow(roundId: roundId, rows: rows) {
      return authoritative
    }
    return rows.last { row in
      row.speaker == "TaskWraith"
        && twNormalizedCloseoutIdentifier(row.ensembleRoundId) == roundId
        && twHasCloseoutEpicTables(row)
    }
  }

  guard let runId = twNormalizedCloseoutIdentifier(summary.runId) else { return nil }
  if let explicit = rows.last(where: {
    $0.isCloseout == true && $0.closeoutScope == "run" && $0.runId == runId
  }) {
    return explicit
  }
  return rows.last { row in
    row.speaker == "TaskWraith" && row.runId == runId && twHasCloseoutEpicTables(row)
  }
}

/// A preflight/cancelled ensemble may have no provider runs at all, yet its
/// durable round close-out still has a Participants/Sub-threads/Files/Commits
/// card worth rendering. Give the existing TaskCompleteCard its minimum input
/// without inventing a participant run.
func twSyntheticRoundCloseoutSummary(
  roundId: String,
  closeout: RemoteThreadSnapshot.Row
) -> RemoteThreadSnapshot.RunSummary {
  .init(
    ensembleRoundId: roundId,
    status: closeout.closeoutStatus,
    endedAt: closeout.timestamp,
    durationMs: closeout.closeoutDurationMs
  )
}
