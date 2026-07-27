// The Swift half of the shared banner corpus.
//
// This suite and src/shared/bannerTemplate.test.ts read THE SAME JSON file and
// assert the same strings. The Mac's settings preview and the phone's actual
// banner are two separate implementations of one algorithm; without a single
// corpus forcing them together they drift, and the user finds out when the
// lock-screen banner doesn't match what the preview promised.
//
// Add cases to src/shared/bannerTemplateFixtures.json — never a hand-rolled
// assertion in only one language.

import Foundation
import Testing

@testable import TaskWraithKit

private struct FixtureInput: Decodable {
    let title: String?
    let preview: String?
    let filesChanged: Int
    let additions: Int
    let deletions: Int
    let status: String
}

private struct FixtureCase: Decodable {
    let name: String
    let template: TWBannerTemplate?
    let input: FixtureInput
    let expectedTitle: String
    let expectedBody: String
}

private struct FixtureFile: Decodable {
    let cases: [FixtureCase]
}

private func bannerStatus(_ raw: String) -> CompletionBannerStatus? {
    switch raw {
    case "success": return .success
    case "warning": return .warning
    case "error": return .error
    case "quota": return .quota
    case "cancelled": return .cancelled
    default: return nil
    }
}

/// Resolve the repo-root JSON from this file's own path. SwiftPM resource
/// bundling would need a COPY of the corpus inside the package, which is
/// exactly the duplication the corpus exists to prevent.
private func loadFixtures() throws -> FixtureFile {
    var url = URL(fileURLWithPath: #filePath)
    // …/ios/TaskWraithKit/Tests/TaskWraithKitTests/TWBannerFixtureTests.swift
    for _ in 0..<5 { url = url.deletingLastPathComponent() }
    let fixtureURL = url.appending(path: "src/shared/bannerTemplateFixtures.json")
    let data = try Data(contentsOf: fixtureURL)
    return try JSONDecoder().decode(FixtureFile.self, from: data)
}

@Suite("Shared banner fixture corpus")
struct TWBannerFixtureTests {
    @Test("the corpus file is present and non-empty")
    func corpusLoads() throws {
        let fixtures = try loadFixtures()
        // A silently-empty corpus would make every fixture test vacuously pass.
        #expect(fixtures.cases.count >= 10)
    }

    @Test("every fixture case renders identically to the TS preview")
    func casesMatch() throws {
        let fixtures = try loadFixtures()
        for testCase in fixtures.cases {
            let status = bannerStatus(testCase.input.status)
            #expect(status != nil, "unknown status '\(testCase.input.status)' in \(testCase.name)")
            guard let status else { continue }
            let template = testCase.template?.sanitized() ?? .default
            let rendered = CompletionBannerRenderer.render(
                CompletionBannerInput(
                    title: testCase.input.title,
                    failed: status != .success,
                    preview: testCase.input.preview,
                    filesChanged: testCase.input.filesChanged,
                    additions: testCase.input.additions,
                    deletions: testCase.input.deletions,
                    status: status),
                template: template)
            #expect(
                rendered.title == testCase.expectedTitle,
                "\(testCase.name): title was \(rendered.title)")
            #expect(
                rendered.body == testCase.expectedBody,
                "\(testCase.name): body was \(rendered.body)")
        }
    }
}
