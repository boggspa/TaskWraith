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
        state.stageFilter = .unstaged
        state.diff = try decodeWorkspaceDiff()
        state.isLoading = true

        state.clearUnavailableWorkspaceStatus()

        #expect(state.selectedWorkspaceId == nil)
        #expect(state.selectedPath == nil)
        #expect(state.diff == nil)
        #expect(state.fileFilter.isEmpty)
        #expect(state.stageFilter == .all)
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
        #expect(state.fileFilterStatus == "1 of 7 files match \"button\".")

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
            ".env",
            "notes/New.md",
            "generated.lock"
        ])
        #expect(state.fileFilterStatus == nil)
    }

    @MainActor
    @Test func stageFilterMatchesDesktopDiffGroupsAndCombinesWithTextSearch() throws {
        let state = MobileDiffStudioState()
        state.diff = try decodeFilterableWorkspaceDiff()

        #expect(MobileDiffStageFilter.allCases.map(\.label) == [
            "All",
            "Mixed",
            "Unstaged",
            "Staged",
            "Untracked",
            "Other"
        ])

        state.stageFilter = .mixed
        #expect(state.filteredFiles.map(\.path) == ["docs/Old.md"])
        #expect(state.stageFilterStatus == "1 of 7 mixed file visible.")
        #expect(state.emptyFilterMessage == "No mixed changed files.")

        state.stageFilter = .unstaged
        #expect(state.filteredFiles.map(\.path) == ["src/App.swift"])
        #expect(state.stageFilterStatus == "1 of 7 unstaged file visible.")

        state.stageFilter = .staged
        #expect(state.filteredFiles.map(\.path) == ["src/ui/Button.swift"])

        state.stageFilter = .untracked
        #expect(state.filteredFiles.map(\.path) == ["notes/New.md"])

        state.stageFilter = .other
        #expect(state.filteredFiles.map(\.path) == ["Assets/Icon.png", ".env", "generated.lock"])

        state.fileFilter = "env"
        #expect(state.filteredFiles.map(\.path) == [".env"])
        #expect(state.fileFilterStatus == "1 of 3 files match \"env\".")

        state.fileFilter = "missing"
        #expect(state.filteredFiles.isEmpty)
        #expect(state.emptyFilterMessage == "No other changed files match \"missing\".")
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

    @MainActor
    @Test func diffColumnHeaderLabelsMatchUnifiedDiffGutters() {
        #expect(MobileDiffStudioState.diffColumnLabels == ["Old", "New", "Δ", "Line"])
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
            },
            {
              "path": "notes/New.md",
              "kind": "untracked",
              "status": "untracked",
              "additions": 6,
              "deletions": 0,
              "staged": false,
              "unstaged": false,
              "truncated": false,
              "hunks": []
            },
            {
              "path": "generated.lock",
              "kind": "modified",
              "status": "modified",
              "additions": 0,
              "deletions": 0,
              "truncated": false,
              "hunks": []
            }
          ],
          "totalFiles": 7,
          "truncated": false
        }
        """
    return try JSONDecoder().decode(WorkspaceDiffResult.self, from: Data(json.utf8))
}

@Suite("Diff Studio sheet glass policy")
struct DiffStudioSheetGlassPolicyTests {
    @Test func fullScreenHostsKeepTheOpaqueCanvasAndDefaultFills() {
        #expect(DiffStudioSheetGlassPolicy.paintsOpaqueCanvas(glassSheetHosted: false))
        #expect(
            DiffStudioSheetGlassPolicy.chromeFillAlpha(
                glassSheetHosted: false, glassEnabled: true) == nil)
        #expect(
            DiffStudioSheetGlassPolicy.codePanelFillAlpha(
                glassSheetHosted: false, glassEnabled: true) == nil)
    }

    @Test func glassSheetDropsTheCanvasAndWashesSurfaces() {
        #expect(!DiffStudioSheetGlassPolicy.paintsOpaqueCanvas(glassSheetHosted: true))
        let chrome = DiffStudioSheetGlassPolicy.chromeFillAlpha(
            glassSheetHosted: true, glassEnabled: true)
        let code = DiffStudioSheetGlassPolicy.codePanelFillAlpha(
            glassSheetHosted: true, glassEnabled: true)
        #expect(chrome == 0.35)
        #expect(code == 0.62)
        // Code stays less transparent than chrome for monospace contrast.
        if let chrome, let code {
            #expect(code > chrome)
        }
    }

    @Test func reduceTransparencyKeepsSurfacesOpaqueOverTheOpaqueBackdrop() {
        #expect(!DiffStudioSheetGlassPolicy.paintsOpaqueCanvas(glassSheetHosted: true))
        #expect(
            DiffStudioSheetGlassPolicy.chromeFillAlpha(
                glassSheetHosted: true, glassEnabled: false) == 1.0)
        #expect(
            DiffStudioSheetGlassPolicy.codePanelFillAlpha(
                glassSheetHosted: true, glassEnabled: false) == 1.0)
    }
}
