import Foundation

/// Helpers for merging Mac thread snapshots when only metadata arrives (no rows).
public enum ThreadSnapshotMerge {
    /// Apply a metadata-only snapshot refresh while preserving any loaded transcript
    /// rows. Incoming run-summary metadata wins over stale local copies so idle
    /// refreshes can clear a stuck `running` spinner.
    public static func applyingMetadata(
        from incoming: RemoteThreadSnapshot,
        onto existing: RemoteThreadSnapshot
    ) -> RemoteThreadSnapshot {
        RemoteThreadSnapshot(
            threadId: incoming.threadId ?? existing.threadId,
            taskId: incoming.taskId ?? existing.taskId,
            workspaceId: incoming.workspaceId ?? existing.workspaceId,
            provider: incoming.provider ?? existing.provider,
            rows: existing.rows,
            totalRows: incoming.totalRows ?? existing.totalRows,
            runSummary: preferIncomingRunSummary(incoming.runSummary, existing.runSummary),
            conversationCostUsd: incoming.conversationCostUsd ?? existing.conversationCostUsd,
            conversationCostText: incoming.conversationCostText ?? existing.conversationCostText,
            showRunCompleteSummary: incoming.showRunCompleteSummary ?? existing.showRunCompleteSummary,
            notes: incoming.notes ?? existing.notes,
            pinnedRows: incoming.pinnedRows ?? existing.pinnedRows,
            blackboardEntries: incoming.blackboardEntries ?? existing.blackboardEntries,
            runSummaries: incoming.runSummaries ?? existing.runSummaries,
            windowStartIndex: existing.windowStartIndex,
            hasMoreAbove: existing.hasMoreAbove,
            hasMoreBelow: incoming.hasMoreBelow ?? existing.hasMoreBelow,
            // `??` is right here BECAUSE the Mac states an empty inbox rather than
            // omitting it: a present zero clears the badge, and absence means this
            // refresh carried no inbox data at all, so the old count stands.
            threadMessageInbox: incoming.threadMessageInbox ?? existing.threadMessageInbox)
    }

    private static func preferIncomingRunSummary(
        _ incoming: RemoteThreadSnapshot.RunSummary?,
        _ existing: RemoteThreadSnapshot.RunSummary?
    ) -> RemoteThreadSnapshot.RunSummary? {
        guard let incoming else { return existing }
        guard let existing else { return incoming }
        if incoming.status != existing.status { return incoming }
        if incoming.endedAt != nil && existing.endedAt == nil { return incoming }
        if incoming.runId != existing.runId { return incoming }
        return incoming
    }
}
