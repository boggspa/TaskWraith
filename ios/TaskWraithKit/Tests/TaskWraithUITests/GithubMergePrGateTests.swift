import Foundation
import TaskWraithKit
import Testing

@testable import TaskWraithUI

@Suite("GitHub merge surface (host-wired, destructive)")
struct GithubMergePrGateTests {
    @Test("hidden unless the Mac projects merge support AND the workspace grants external publish")
    func availabilityIsFailClosed() {
        #expect(GithubMergePrGate.isAvailable(hostProjected: nil, externalPublish: true) == false)
        #expect(GithubMergePrGate.isAvailable(hostProjected: false, externalPublish: true) == false)
        #expect(GithubMergePrGate.isAvailable(hostProjected: true, externalPublish: nil) == false)
        #expect(GithubMergePrGate.isAvailable(hostProjected: true, externalPublish: false) == false)
        #expect(GithubMergePrGate.isAvailable(hostProjected: true, externalPublish: true) == true)
    }

    @Test("the merge capability decodes from the capabilities object; absent means not wired")
    func capabilityDecodes() throws {
        let wired = try JSONDecoder().decode(
            RemoteTaskCapabilities.self, from: Data(#"{"githubMergePr":true}"#.utf8))
        #expect(wired.githubMergePr == true)
        let silent = try JSONDecoder().decode(
            RemoteTaskCapabilities.self, from: Data(#"{"deleteMessage":true}"#.utf8))
        #expect(silent.githubMergePr == nil)
    }

    @Test("only an open, non-draft, identified PR may offer merge — anything less hides the control")
    func offerableNeedsOpenIdentifiedPr() throws {
        let open = try pr(#"{"number":12,"url":"https://example.test/pr/12","state":"OPEN","isDraft":false}"#)
        #expect(
            GithubMergePrGate.isOfferable(pr: open, hostProjected: true, externalPublish: true)
                == true)

        // Every way this goes wrong hides the button rather than showing it dead.
        #expect(GithubMergePrGate.isOfferable(pr: nil, hostProjected: true, externalPublish: true) == false)
        #expect(
            GithubMergePrGate.isOfferable(pr: open, hostProjected: nil, externalPublish: true)
                == false)
        #expect(
            GithubMergePrGate.isOfferable(pr: open, hostProjected: false, externalPublish: true)
                == false)
        #expect(
            GithubMergePrGate.isOfferable(pr: open, hostProjected: true, externalPublish: false)
                == false)

        let merged = try pr(#"{"number":12,"url":"https://example.test/pr/12","state":"MERGED"}"#)
        #expect(
            GithubMergePrGate.isOfferable(pr: merged, hostProjected: true, externalPublish: true)
                == false)
        let draft = try pr(#"{"number":12,"url":"https://example.test/pr/12","state":"OPEN","isDraft":true}"#)
        #expect(
            GithubMergePrGate.isOfferable(pr: draft, hostProjected: true, externalPublish: true)
                == false)
        let anonymous = try pr(#"{"state":"OPEN"}"#)
        #expect(
            GithubMergePrGate.isOfferable(pr: anonymous, hostProjected: true, externalPublish: true)
                == false)
    }

    @Test("the builder never stamps the elevation bit itself — only the confirmation tap may")
    func elevationAcknowledgementIsCallerOwned() throws {
        let refused = try decodePayload(
            BridgeAction.githubMergePr(
                workspaceId: "ws-1", elevationAcknowledged: false, actionId: "act-1"))
        #expect(refused["kind"] as? String == "githubMergePr")
        #expect(refused["workspaceId"] as? String == "ws-1")
        #expect(refused["elevationAcknowledged"] as? Bool == false)
        #expect(refused["actionId"] as? String == "act-1")

        let confirmed = try decodePayload(
            BridgeAction.githubMergePr(
                workspaceId: "ws-1", elevationAcknowledged: true, actionId: "act-2"))
        #expect(confirmed["elevationAcknowledged"] as? Bool == true)
    }

    private func pr(_ json: String) throws -> GitPullRequestSummary {
        try JSONDecoder().decode(GitPullRequestSummary.self, from: Data(json.utf8))
    }

    private func decodePayload(_ params: [String: Any]) throws -> [String: Any] {
        let payloadBase64 = try #require(params["payloadBase64"] as? String)
        let payloadData = try #require(Data(base64Encoded: payloadBase64))
        let object = try JSONSerialization.jsonObject(with: payloadData)
        return try #require(object as? [String: Any])
    }
}
