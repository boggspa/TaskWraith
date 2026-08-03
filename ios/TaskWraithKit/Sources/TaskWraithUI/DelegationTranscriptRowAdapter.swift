import Foundation
import TaskWraithKit

/// Joins a structured delegation transcript row to the phone's child task-card
/// projection. The wire carries immutable invocation metadata; the task card
/// supplies live/terminal state and the existing-child navigation authority.
enum DelegationTranscriptRowAdapter {
    static func input(
        for row: RemoteThreadSnapshot.Row,
        childCards: [RemoteTaskCard]
    ) -> AgentInvocationCardInput? {
        guard let summary = row.subThreadDelegation else { return nil }

        let child = childCards.first { $0.id == summary.subThreadId }
        let childSnapshot: AgentInvocationChildSnapshot?
        if let child {
            childSnapshot = AgentInvocationChildSnapshot(
                id: child.id,
                status: child.status,
                hasRecordedRun: nil,
                resultReturnedAt: summary.resultReturned == true ? 1 : nil,
                dispatchErrorMessage: nil
            )
        } else if let subThreadId = summary.subThreadId,
            summary.resultReturned == true
        {
            childSnapshot = AgentInvocationChildSnapshot(
                id: subThreadId,
                hasRecordedRun: true,
                resultReturnedAt: 1
            )
        } else {
            childSnapshot = nil
        }

        return AgentInvocationCardInput(
            subThreadId: summary.subThreadId,
            parentProvider: summary.parentProvider,
            targetProvider: summary.targetProvider,
            title: summary.title,
            promptPreview: summary.promptPreview,
            returnResultToParent: summary.returnResultToParent == true,
            route: .taskwraithSubthread,
            status: AgentInvocationStatusResolver.resolve(childSnapshot),
            dispatchErrorMessage: nil,
            agentName: child?.agentName,
            agentAccent: child?.agentAccent
        )
    }

    static func navigation(
        for row: RemoteThreadSnapshot.Row,
        parentThreadId: String,
        childCards: [RemoteTaskCard],
        preferredDestination: ExistingChildOpenDestination = .openInMain
    ) -> ExistingChildNavigationIntent {
        ExistingChildNavigation.resolve(
            subThreadId: row.subThreadDelegation?.subThreadId,
            parentThreadId: parentThreadId,
            childCards: childCards,
            preferredDestination: preferredDestination
        )
    }
}
