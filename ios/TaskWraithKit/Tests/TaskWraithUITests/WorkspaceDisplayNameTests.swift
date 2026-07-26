import Foundation
import Testing

@testable import TaskWraithKit

/// Parity with `src/shared/workspaceDisplayName.ts`. The desktop composer's
/// above-row has always resolved the OFFICIAL repo name; the phone's composer
/// pill showed the raw projected display name, i.e. the folder root. Same
/// checkout, two names.
@Suite("Workspace display name (desktop parity)")
struct WorkspaceDisplayNameTests {
    typealias Name = TWWorkspaceDisplayName

    @Test func prefersTheGitRemoteOverTheFolderName() {
        // The exact case from the report: folder AGBench, remote TaskWraith.
        #expect(
            Name.resolve(
                displayName: "AGBench",
                path: "/Users/me/Documents/AGBench",
                repoRoot: "/Users/me/Documents/AGBench",
                remoteUrl: "https://github.com/boggspa/TaskWraith.git"
            ) == "TaskWraith")
    }

    @Test func rewritesTheLegacyLabelEvenWithoutARemote() {
        // The rebrand renamed the product, not the folder on disk.
        #expect(
            Name.resolve(
                displayName: "AGBench", path: "/Users/me/AGBench", repoRoot: nil, remoteUrl: nil)
                == "TaskWraith")
        #expect(Name.formatWorkspaceDisplayName("agbench") == "TaskWraith")
        #expect(Name.formatWorkspaceDisplayName("Something Else") == "Something Else")
    }

    @Test func keepsAUserChosenNameThatIsNotJustTheFolder() {
        #expect(
            Name.resolve(
                displayName: "Client work",
                path: "/Users/me/repos/acme",
                repoRoot: "/Users/me/repos/acme",
                remoteUrl: "git@github.com:acme/widgets.git"
            ) == "Client work")
    }

    @Test func fallsBackDownTheLadderWhenPiecesAreMissing() {
        // No remote → repo root basename.
        #expect(
            Name.resolve(
                displayName: nil, path: nil, repoRoot: "/Users/me/repos/widgets", remoteUrl: nil)
                == "widgets")
        // Nothing at all → a label, never an empty pill.
        #expect(Name.resolve(displayName: nil, path: nil, repoRoot: nil, remoteUrl: nil) == "Workspace")
    }

    @Test func parsesBothRemoteURLShapesAndStripsDotGit() {
        #expect(Name.gitRemoteProjectName("https://github.com/owner/repo.git") == "repo")
        #expect(Name.gitRemoteProjectName("https://github.com/owner/repo") == "repo")
        #expect(Name.gitRemoteProjectName("git@github.com:owner/repo.git") == "repo")
        #expect(Name.gitRemoteProjectName("ssh://git@host.example/owner/repo.git/") == "repo")
        // Query/fragment noise must not leak into the label.
        #expect(Name.gitRemoteProjectName("https://host/owner/repo.git?ref=main") == "repo")
        #expect(Name.gitRemoteProjectName("") == "")
        #expect(Name.gitRemoteProjectName(nil) == "")
    }

    /// The pill is tight on a phone, so the answer is the repo segment only —
    /// never `owner/repo`.
    @Test func returnsTheRepoSegmentWithoutTheOwner() {
        #expect(Name.gitRemoteProjectName("https://github.com/boggspa/TaskWraith.git") == "TaskWraith")
        #expect(Name.gitRemoteProjectName("git@github.com:boggspa/TaskWraith.git") == "TaskWraith")
    }

    @Test func basenameToleratesEitherSeparatorAndTrailingSlashes() {
        #expect(Name.pathBasename("/a/b/c") == "c")
        #expect(Name.pathBasename("/a/b/c/") == "c")
        #expect(Name.pathBasename("C:\\repos\\widgets") == "widgets")
        #expect(Name.pathBasename("") == "")
        #expect(Name.pathBasename(nil) == "")
    }
}
