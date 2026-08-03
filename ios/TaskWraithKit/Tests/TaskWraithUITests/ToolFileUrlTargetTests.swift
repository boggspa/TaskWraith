import Foundation
import Testing
@testable import TaskWraithUI

@Suite("Tool file/URL target detection")
struct ToolFileUrlTargetDetectionTests {
    @Test func extractFilePathPrefersParameterKeysOverFirstClassFile() {
        let path = ToolFileUrlTargetModel.extractToolFilePath(
            parameterStrings: ["path": "/other/b.ts"],
            filePath: "/repo/a.ts"
        )
        #expect(path == "/other/b.ts")
    }

    @Test func extractFilePathReadsWellKnownKeysInOrder() {
        #expect(
            ToolFileUrlTargetModel.extractToolFilePath(
                parameterStrings: ["file_path": "/repo/src/foo.ts"],
                filePath: nil
            ) == "/repo/src/foo.ts"
        )
        #expect(
            ToolFileUrlTargetModel.extractToolFilePath(
                parameterStrings: ["target": "/x/y.ts"],
                filePath: nil
            ) == "/x/y.ts"
        )
    }

    @Test func extractFilePathFallsBackToFirstClassFile() {
        #expect(
            ToolFileUrlTargetModel.extractToolFilePath(
                parameterStrings: ["query": "todo"],
                filePath: "/repo/only-first-class.ts"
            ) == "/repo/only-first-class.ts"
        )
    }

    @Test func extractFilePathReturnsNilWhenAbsent() {
        #expect(
            ToolFileUrlTargetModel.extractToolFilePath(
                parameterStrings: ["query": "todo"],
                filePath: nil
            ) == nil
        )
        #expect(
            ToolFileUrlTargetModel.extractToolFilePath(
                parameterStrings: [:],
                filePath: "   "
            ) == nil
        )
    }

    @Test func extractFilePathRejectsHttpShapedValues() {
        #expect(
            ToolFileUrlTargetModel.extractToolFilePath(
                parameterStrings: ["path": "https://example.com/a.ts"],
                filePath: nil
            ) == nil
        )
    }

    @Test func normalizeHttpUrlStripsPunctuationAndCredentials() throws {
        let a = try #require(
            ToolFileUrlTargetModel.normalizeHttpUrlTarget(
                "https://github.com/boggspa/TaskWraith,"
            )
        )
        #expect(a.url == "https://github.com/boggspa/TaskWraith")
        #expect(a.host == "github.com")

        let withUser = try #require(
            ToolFileUrlTargetModel.normalizeHttpUrlTarget(
                "https://user:pass@www.example.com/docs#frag"
            )
        )
        #expect(withUser.url == "https://www.example.com/docs")
        #expect(withUser.host == "example.com")
        #expect(withUser.origin == "https://www.example.com")
    }

    @Test func normalizeKeepsBalancedParensAndStripsUnbalanced() throws {
        let balanced = try #require(
            ToolFileUrlTargetModel.normalizeHttpUrlTarget(
                "https://example.com/wiki/Foo_(bar)"
            )
        )
        #expect(balanced.url == "https://example.com/wiki/Foo_(bar)")

        let unbalanced = try #require(
            ToolFileUrlTargetModel.normalizeHttpUrlTarget("https://example.com/docs)")
        )
        #expect(unbalanced.url == "https://example.com/docs")
    }

    @Test func normalizeRejectsNonHttpSchemes() {
        #expect(ToolFileUrlTargetModel.normalizeHttpUrlTarget("file:///tmp/report.html") == nil)
        #expect(ToolFileUrlTargetModel.normalizeHttpUrlTarget("javascript:alert(1)") == nil)
        #expect(ToolFileUrlTargetModel.normalizeHttpUrlTarget("data:text/html,hi") == nil)
    }

    @Test func extractHttpUrlsDedupesAndRespectsLimit() {
        let urls = ToolFileUrlTargetModel.extractHttpUrls(
            "See https://github.com/boggspa/TaskWraith, then https://github.com/boggspa/TaskWraith. Also https://example.com/docs."
        )
        #expect(urls.map(\.host) == ["github.com", "example.com"])

        let capped = ToolFileUrlTargetModel.extractHttpUrls(
            "https://a.example/x https://b.example/y https://c.example/z",
            limit: 2
        )
        #expect(capped.count == 2)
        #expect(capped.map(\.host) == ["a.example", "b.example"])
    }

    @Test func makePresentationMergesParameterAndResultUrls() {
        let model = ToolFileUrlTargetModel.makePresentation(
            from: ToolTargetDetectionInput(
                file: nil,
                detail: nil,
                parameterStrings: ["url": "https://github.com/boggspa/TaskWraith"],
                resultText:
                    "Fetched https://github.com/boggspa/TaskWraith and https://example.com/docs.",
                urlLimit: 5
            )
        )
        #expect(model.fileTarget == nil)
        #expect(model.urlTargets.map(\.host) == ["github.com", "example.com"])
        #expect(model.primaryUrlTarget?.host == "github.com")
        #expect(model.showsSourcesSection)
        #expect(model.hasTargets)
    }

    @Test func makePresentationAcceptsSanitizedProjectedUrls() {
        let model = ToolFileUrlTargetModel.makePresentation(
            file: nil,
            detail: "Also https://detail.example.com/path",
            projectedUrls: [
                "https://user:secret@example.com/a#private",
                "https://example.com/a",
            ]
        )
        #expect(model.urlTargets.map(\.url) == [
            "https://example.com/a",
            "https://detail.example.com/path",
        ])
    }

    @Test func zeroUrlLimitSuppressesAllTargets() {
        let model = ToolFileUrlTargetModel.makePresentation(
            from: ToolTargetDetectionInput(
                resultText: "https://result.example.com",
                projectedUrls: ["https://example.com"],
                urlLimit: 0
            )
        )
        #expect(model.urlTargets.isEmpty)
    }

    @Test func makePresentationBuildsFileTargetFromProjectedFile() throws {
        let model = ToolFileUrlTargetModel.makePresentation(
            file: "/Users/alice/Documents/repo/src/main/index.ts",
            detail: nil,
            workspacePath: "/Users/alice/Documents/repo"
        )
        let file = try #require(model.fileTarget)
        #expect(file.rawPath == "/Users/alice/Documents/repo/src/main/index.ts")
        #expect(file.displayPath == "src/main/index.ts")
        #expect(file.displayLabel == "main/index.ts")
        #expect(file.absolutePath == "/Users/alice/Documents/repo/src/main/index.ts")
    }

    @Test func resolveRelativePathAgainstWorkspace() {
        let absolute = ToolFileUrlTargetModel.resolveWorkspaceAbsolutePath(
            "src/foo.ts",
            workspacePath: "/Users/alice/Documents/repo"
        )
        #expect(absolute == "/Users/alice/Documents/repo/src/foo.ts")

        let tilde = ToolFileUrlTargetModel.resolveWorkspaceAbsolutePath(
            "~/Desktop/x.ts",
            workspacePath: "/Users/alice/Documents/repo"
        )
        #expect(tilde == "~/Desktop/x.ts")

        let collapsed = ToolFileUrlTargetModel.resolveWorkspaceAbsolutePath(
            "/repo/src/../../etc/hosts",
            workspacePath: nil
        )
        #expect(collapsed == "/etc/hosts")
    }

    @Test func displayPathTildifiesHomeOutsideWorkspace() {
        let display = ToolFileUrlTargetModel.displayPathRelativeToWorkspace(
            "/Users/alice/Downloads/notes.txt",
            workspacePath: "/Users/alice/Documents/repo"
        )
        #expect(display == "~/Downloads/notes.txt")
    }

    @Test func boundsRejectOversizedPathAndUrl() {
        let longPath = "/" + String(repeating: "a", count: 3_000)
        #expect(ToolFileUrlTargetModel.makeFileTarget(rawPath: longPath, workspacePath: nil) == nil)

        let longUrl = "https://example.com/" + String(repeating: "b", count: 3_000)
        #expect(ToolFileUrlTargetModel.normalizeHttpUrlTarget(longUrl) == nil)
    }
}

@Suite("Tool file/URL target actions")
struct ToolFileUrlTargetActionTests {
    @Test func fileActionsIncludeOpenRevealCopyInspect() throws {
        let target = try #require(
            ToolFileUrlTargetModel.makeFileTarget(
                rawPath: "/repo/src/foo.ts",
                workspacePath: "/repo"
            )
        )
        let actions = ToolFileUrlTargetModel.fileActions(for: target)
        #expect(actions == [.open, .reveal, .copyPath, .inspect])
        #expect(ToolFileUrlTargetModel.canPerform(.reveal, onFile: target))
    }

    @Test func urlActionsExcludeReveal() throws {
        let target = try #require(
            ToolFileUrlTargetModel.normalizeHttpUrlTarget("https://example.com/docs")
        )
        let actions = ToolFileUrlTargetModel.urlActions(for: target)
        #expect(actions == [.open, .copyPath, .inspect])
        #expect(ToolFileUrlTargetModel.canPerform(.reveal, onUrl: target) == false)
    }

    @Test func accessibilityLabelsAreStable() throws {
        let file = try #require(
            ToolFileUrlTargetModel.makeFileTarget(
                rawPath: "/repo/src/foo.ts",
                workspacePath: "/repo"
            )
        )
        #expect(
            ToolFileUrlTargetModel.accessibilityLabel(forFile: file)
                == "Open file src/foo.ts"
        )
        #expect(
            ToolFileUrlTargetModel.accessibilityLabel(for: .reveal, file: file)
                == "Reveal in Files src/foo.ts"
        )

        let url = try #require(
            ToolFileUrlTargetModel.normalizeHttpUrlTarget("https://github.com/acme/app")
        )
        #expect(ToolFileUrlTargetModel.accessibilityLabel(forUrl: url) == "Open link github.com")
        #expect(
            ToolFileUrlTargetModel.accessibilityLabel(for: .copyPath, url: url)
                == "Copy URL github.com"
        )
    }

    @Test func actionTitlesAndImagesMatchWiringContract() {
        #expect(ToolFileUrlTargetModel.actionTitle(.open) == "Open")
        #expect(ToolFileUrlTargetModel.actionTitle(.reveal) == "Reveal in Files")
        #expect(ToolFileUrlTargetModel.actionTitle(.copyPath) == "Copy path")
        #expect(ToolFileUrlTargetModel.actionTitle(.inspect) == "Inspect")
        #expect(ToolFileUrlTargetModel.actionSystemImage(.open) == "arrow.up.right.square")
        #expect(ToolFileUrlTargetModel.actionSystemImage(.reveal) == "folder")
        #expect(ToolFileUrlTargetModel.actionSystemImage(.copyPath) == "doc.on.doc")
        #expect(ToolFileUrlTargetModel.actionSystemImage(.inspect) == "info.circle")
    }

    @Test func emptyPresentationHasNoTargets() {
        let model = ToolFileUrlTargetModel.makePresentation(file: nil, detail: "no links here")
        #expect(model.hasTargets == false)
        #expect(model.showsSourcesSection == false)
        #expect(model.primaryUrlTarget == nil)
    }
}
