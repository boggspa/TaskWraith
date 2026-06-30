import Foundation
import Testing
import TaskWraithKit

@testable import TaskWraithUI

@Suite("Mobile Diff Studio state")
struct MobileDiffStudioStateTests {
    @MainActor
    @Test func statusUsesTotalFilesWhenVisibleFilesAreCapped() {
        #expect(MobileDiffStudioState.statusText(visibleFiles: 40, totalFiles: 128) == "128 changed files")
        #expect(MobileDiffStudioState.statusText(visibleFiles: 1, totalFiles: nil) == "1 changed file")
        #expect(MobileDiffStudioState.statusText(visibleFiles: 0, totalFiles: 0) == "No changes.")
    }

    @MainActor
    @Test func clearUnavailableWorkspaceStatusDropsStaleDiffAndSelection() throws {
        let state = MobileDiffStudioState()
        state.selectedWorkspaceId = "ws-1"
        state.selectedPath = "src/App.swift"
        state.fileFilter = "app"
        state.diff = try decodeWorkspaceDiff()
        state.isLoading = true

        state.clearUnavailableWorkspaceStatus()

        #expect(state.selectedWorkspaceId == nil)
        #expect(state.selectedPath == nil)
        #expect(state.diff == nil)
        #expect(state.fileFilter.isEmpty)
        #expect(state.files.isEmpty)
        #expect(state.isLoading == false)
        #expect(state.status == "No workspace has diff review enabled.")
    }

    @MainActor
    @Test func fileFilterMatchesPathNameAndKind() throws {
        let state = MobileDiffStudioState()
        state.diff = try decodeFilterableWorkspaceDiff()

        state.fileFilter = "button"
        #expect(state.filteredFiles.map(\.path) == ["src/ui/Button.swift"])
        #expect(state.fileFilterStatus == "1 of 5 files match \"button\".")

        state.fileFilter = " deleted "
        #expect(state.filteredFiles.map(\.path) == ["docs/Old.md"])

        state.fileFilter = "src/"
        #expect(state.filteredFiles.map(\.path) == ["src/App.swift", "src/ui/Button.swift"])

        state.fileFilter = ""
        #expect(state.filteredFiles.map(\.path) == [
            "src/App.swift",
            "src/ui/Button.swift",
            "docs/Old.md",
            "Assets/Icon.png",
            ".env"
        ])
        #expect(state.fileFilterStatus == nil)
    }

    @MainActor
    @Test func editorHandoffSkipsDeletedBinaryHiddenAndMissingSelections() throws {
        let state = MobileDiffStudioState()
        state.diff = try decodeFilterableWorkspaceDiff()

        #expect(state.selectedFileCanOpenInEditor == false)

        state.selectedPath = "src/App.swift"
        #expect(state.selectedFileCanOpenInEditor == true)

        state.selectedPath = "docs/Old.md"
        #expect(state.selectedFileCanOpenInEditor == false)

        state.selectedPath = "Assets/Icon.png"
        #expect(state.selectedFileCanOpenInEditor == false)

        state.selectedPath = ".env"
        #expect(state.selectedFileCanOpenInEditor == false)
    }

    @MainActor
    @Test func stageActionsUseBoundedDiffStageState() throws {
        let state = MobileDiffStudioState()
        state.diff = try decodeFilterableWorkspaceDiff()

        #expect(state.selectedFileCanStage == false)
        #expect(state.selectedFileCanUnstage == false)

        state.selectedPath = "src/App.swift"
        #expect(state.selectedFileCanStage == true)
        #expect(state.selectedFileCanUnstage == false)

        state.selectedPath = "src/ui/Button.swift"
        #expect(state.selectedFileCanStage == false)
        #expect(state.selectedFileCanUnstage == true)

        state.selectedPath = "docs/Old.md"
        #expect(state.selectedFileCanStage == true)
        #expect(state.selectedFileCanUnstage == true)

        let labels = Dictionary(uniqueKeysWithValues: state.files.compactMap { file in
            DiffStageChip.label(for: file).map { (file.path, $0) }
        })
        #expect(labels["src/App.swift"] == "Unstaged")
        #expect(labels["src/ui/Button.swift"] == "Staged")
        #expect(labels["docs/Old.md"] == "Mixed")
        #expect(labels["Assets/Icon.png"] == nil)
    }

    @MainActor
    @Test func targetPathNormalizationIgnoresBlankAndSlashes() {
        #expect(MobileDiffStudioState.normalizedTargetPath(nil) == nil)
        #expect(MobileDiffStudioState.normalizedTargetPath("   ") == nil)
        #expect(MobileDiffStudioState.normalizedTargetPath("/src/App.swift/") == "src/App.swift")
    }
}

private func decodeWorkspaceDiff() throws -> WorkspaceDiffResult {
    let json = """
        {
          "files": [
            {
              "path": "src/App.swift",
              "kind": "modified",
              "additions": 2,
              "deletions": 1,
              "truncated": false,
              "hunks": [
                {
                  "header": "@@ -1,1 +1,1 @@",
                  "lines": [
                    { "type": "del", "text": "old", "oldLine": 1, "newLine": null },
                    { "type": "add", "text": "new", "oldLine": null, "newLine": 1 }
                  ]
                }
              ]
            }
          ],
          "totalFiles": 4,
          "truncated": true
        }
        """
    return try JSONDecoder().decode(WorkspaceDiffResult.self, from: Data(json.utf8))
}

private func decodeFilterableWorkspaceDiff() throws -> WorkspaceDiffResult {
    let json = """
        {
          "files": [
            {
              "path": "src/App.swift",
              "kind": "modified",
              "additions": 2,
              "deletions": 1,
              "staged": false,
              "unstaged": true,
              "truncated": false,
              "hunks": []
            },
            {
              "path": "src/ui/Button.swift",
              "kind": "created",
              "additions": 8,
              "deletions": 0,
              "staged": true,
              "unstaged": false,
              "truncated": false,
              "hunks": []
            },
            {
              "path": "docs/Old.md",
              "kind": "deleted",
              "status": "deleted",
              "previewKind": "none",
              "canOpenInEditor": false,
              "additions": 0,
              "deletions": 4,
              "staged": true,
              "unstaged": true,
              "truncated": false,
              "hunks": []
            },
            {
              "path": "Assets/Icon.png",
              "kind": "modified",
              "status": "modified",
              "previewKind": "binary",
              "isBinary": true,
              "canOpenInEditor": false,
              "additions": 0,
              "deletions": 0,
              "truncated": false,
              "hunks": []
            },
            {
              "path": ".env",
              "kind": "modified",
              "status": "hidden_sensitive",
              "previewKind": "hidden",
              "isSensitive": true,
              "canOpenInEditor": false,
              "additions": 1,
              "deletions": 1,
              "truncated": false,
              "hunks": []
            }
          ],
          "totalFiles": 5,
          "truncated": false
        }
        """
    return try JSONDecoder().decode(WorkspaceDiffResult.self, from: Data(json.utf8))
}
