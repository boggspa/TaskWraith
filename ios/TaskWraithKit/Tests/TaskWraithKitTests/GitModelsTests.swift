// Git workflow model coding — the Swift mirror of the Mac's compact
// bridge payloads (compactGitSnapshotForBridge & friends in main/index.ts).
// Asserts the ack JSON the Mac actually emits decodes into the typed
// models, and that the BridgeAction helpers stamp well-formed payloads.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Git workflow models")
struct GitModelsTests {
    @Test("gitSnapshot ack data decodes the compact snapshot")
    func decodeSnapshotAck() throws {
        let json = """
            {
              "accepted": true, "executed": true, "message": "Git status read.",
              "data": {
                "git": {
                  "repoRoot": "/Users/me/Repo", "branch": "feature/phone",
                  "commit": "abc1234", "detached": false,
                  "upstream": "origin/feature/phone", "remoteName": "origin",
                  "remoteUrl": "git@github.com:o/r.git",
                  "ahead": 2, "behind": 1,
                  "counts": { "changed": 3, "staged": 1, "unstaged": 2, "untracked": 1 },
                  "clean": false, "mergeState": null, "conflicts": 0,
                  "lineStats": { "additions": 42, "deletions": 7 },
                  "files": [
                    { "path": "src/App.swift", "kind": "modified", "staged": true, "unstaged": false },
                    { "path": "docs/new.md", "kind": "untracked", "staged": false, "unstaged": true }
                  ],
                  "filesTruncated": false
                }
              }
            }
            """
        let ack = try JSONDecoder().decode(BridgeActionAck.self, from: Data(json.utf8))
        let git = try #require(ack.data?.git)
        #expect(git.branch == "feature/phone")
        #expect(git.detached == false)
        #expect(git.upstream == "origin/feature/phone")
        #expect(git.ahead == 2)
        #expect(git.behind == 1)
        #expect(git.counts?.staged == 1)
        #expect(git.clean == false)
        #expect(git.mergeState == nil)
        #expect(git.lineStats?.additions == 42)
        #expect(git.files?.count == 2)
        #expect(git.files?.first?.kind == "modified")
        #expect(git.files?.first?.staged == true)
        #expect(git.filesTruncated == false)
    }

    @Test("githubPrReadiness ack data decodes readiness + nested snapshot + PR")
    func decodeReadinessAck() throws {
        let json = """
            {
              "accepted": true, "executed": true,
              "data": {
                "readiness": {
                  "canCreatePullRequest": false,
                  "shouldPushFirst": true,
                  "reason": "Push the current branch before creating a pull request.",
                  "warnings": ["gh: not logged in"],
                  "git": { "branch": "main", "ahead": 3, "behind": 0, "clean": true },
                  "pr": { "number": 12, "url": "https://github.com/o/r/pull/12", "state": "OPEN" }
                }
              }
            }
            """
        let ack = try JSONDecoder().decode(BridgeActionAck.self, from: Data(json.utf8))
        let readiness = try #require(ack.data?.readiness)
        #expect(readiness.canCreatePullRequest == false)
        #expect(readiness.shouldPushFirst == true)
        #expect(readiness.reason?.contains("Push the current branch") == true)
        #expect(readiness.warnings == ["gh: not logged in"])
        #expect(readiness.git?.branch == "main")
        #expect(readiness.pr?.number == 12)
    }

    @Test("githubPrStatus ack decodes a PR with capped checks; absent pr stays nil")
    func decodePrStatusAck() throws {
        let json = """
            {
              "accepted": true, "executed": true,
              "data": {
                "pr": {
                  "number": 7, "url": "https://github.com/o/r/pull/7",
                  "state": "OPEN", "isDraft": true,
                  "headRefName": "feature/phone", "baseRefName": "main",
                  "checks": [
                    { "name": "ci/test", "status": "completed", "conclusion": "success" },
                    { "name": "ci/lint", "status": "in_progress" }
                  ]
                }
              }
            }
            """
        let ack = try JSONDecoder().decode(BridgeActionAck.self, from: Data(json.utf8))
        let pr = try #require(ack.data?.pr)
        #expect(pr.number == 7)
        #expect(pr.isDraft == true)
        #expect(pr.checks?.count == 2)
        #expect(pr.checks?.first?.conclusion == "success")
        #expect(pr.checks?.last?.conclusion == nil)

        // "No PR for this branch" — executed ack with empty data.
        let emptyJson = """
            { "accepted": true, "executed": true, "message": "No pull request for this branch.", "data": {} }
            """
        let emptyAck = try JSONDecoder().decode(BridgeActionAck.self, from: Data(emptyJson.utf8))
        #expect(emptyAck.data?.pr == nil)
        #expect(emptyAck.data?.git == nil)
        #expect(emptyAck.data?.readiness == nil)
    }

    @Test("threadMediaFetch ack data decodes bounded transcript media")
    func decodeThreadMediaFetchAck() throws {
        let json = """
            {
              "accepted": true, "executed": true, "message": "Fetched transcript media.",
              "data": {
                "mediaId": "media-1",
                "rowId": "m7",
                "threadId": "t-1",
                "media": {
                  "id": "media-1",
                  "rowId": "m7",
                  "threadId": "t-1",
                  "name": "preview.png",
                  "source": "tool_result",
                  "mimeType": "image/png",
                  "dataBase64": "iVBORw0KGgo=",
                  "width": 64,
                  "height": 32,
                  "byteLength": 8,
                  "variant": "thumbnail"
                }
              }
            }
            """
        let ack = try JSONDecoder().decode(BridgeActionAck.self, from: Data(json.utf8))
        let data = try #require(ack.data)
        let media = try #require(data.media)
        #expect(data.mediaId == "media-1")
        #expect(media.id == "media-1")
        #expect(media.rowId == "m7")
        #expect(media.mimeType == "image/png")
        #expect(media.dataBase64 == "iVBORw0KGgo=")
        #expect(media.width == 64)
        #expect(media.variant == "thumbnail")
    }

    @Test("BridgeAction git helpers stamp typed payloads with replay metadata")
    func gitActionHelpersEncode() throws {
        let params = BridgeAction.gitCommit(
            workspaceId: "ws-1", message: "fix: from the phone", stageAll: true)
        let payloadBase64 = try #require(params["payloadBase64"] as? String)
        let payloadData = try #require(Data(base64Encoded: payloadBase64))
        let payload = try #require(
            try JSONSerialization.jsonObject(with: payloadData) as? [String: Any])

        #expect(payload["kind"] as? String == "gitCommit")
        #expect(payload["workspaceId"] as? String == "ws-1")
        #expect(payload["message"] as? String == "fix: from the phone")
        #expect(payload["stageAll"] as? Bool == true)
        // Replay/expiry stamps the Mac REQUIRES on mutating actions.
        #expect(payload["actionId"] as? String != nil)
        let issuedAt = try #require(payload["issuedAt"] as? Int)
        let expiresAt = try #require(payload["expiresAt"] as? Int)
        #expect(expiresAt > issuedAt)
    }

    @Test("githubCreatePr helper omits blank title/body and carries draft")
    func createPrHelperEncodes() throws {
        let params = BridgeAction.githubCreatePr(
            workspaceId: "ws-1", title: "  ", body: nil, draft: true)
        let payloadBase64 = try #require(params["payloadBase64"] as? String)
        let payloadData = try #require(Data(base64Encoded: payloadBase64))
        let payload = try #require(
            try JSONSerialization.jsonObject(with: payloadData) as? [String: Any])

        #expect(payload["kind"] as? String == "githubCreatePr")
        #expect(payload["title"] == nil)
        #expect(payload["body"] == nil)
        #expect(payload["draft"] as? Bool == true)

        let titled = BridgeAction.githubCreatePr(workspaceId: "ws-1", title: "Phone PR")
        let titledBase64 = try #require(titled["payloadBase64"] as? String)
        let titledData = try #require(Data(base64Encoded: titledBase64))
        let titledPayload = try #require(
            try JSONSerialization.jsonObject(with: titledData) as? [String: Any])
        #expect(titledPayload["title"] as? String == "Phone PR")
        #expect(titledPayload["draft"] as? Bool == false)
    }

    @Test("read-only git helpers encode their kinds")
    func readHelpersEncode() throws {
        for (params, expectedKind) in [
            (BridgeAction.gitSnapshot(workspaceId: "ws-1"), "gitSnapshot"),
            (BridgeAction.gitStageAll(workspaceId: "ws-1"), "gitStageAll"),
            (BridgeAction.gitPush(workspaceId: "ws-1", setUpstream: true), "gitPush"),
            (BridgeAction.githubPrStatus(workspaceId: "ws-1"), "githubPrStatus"),
            (BridgeAction.githubPrReadiness(workspaceId: "ws-1"), "githubPrReadiness"),
        ] {
            let payloadBase64 = try #require(params["payloadBase64"] as? String)
            let payloadData = try #require(Data(base64Encoded: payloadBase64))
            let payload = try #require(
                try JSONSerialization.jsonObject(with: payloadData) as? [String: Any])
            #expect(payload["kind"] as? String == expectedKind)
            #expect(payload["workspaceId"] as? String == "ws-1")
        }

        let quietSnapshot = BridgeAction.gitSnapshot(workspaceId: "ws-1", publish: false)
        let quietBase64 = try #require(quietSnapshot["payloadBase64"] as? String)
        let quietData = try #require(Data(base64Encoded: quietBase64))
        let quietPayload = try #require(
            try JSONSerialization.jsonObject(with: quietData) as? [String: Any])
        #expect(quietPayload["kind"] as? String == "gitSnapshot")
        #expect(quietPayload["publish"] as? Bool == false)
    }

    @Test("branch / checkout / PR-watch helpers encode their kinds")
    func branchAndWatchHelpersEncode() throws {
        func decode(_ params: [String: Any]) throws -> [String: Any] {
            let base64 = try #require(params["payloadBase64"] as? String)
            let data = try #require(Data(base64Encoded: base64))
            return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        }

        let branches = try decode(BridgeAction.gitBranches(workspaceId: "ws-1"))
        #expect(branches["kind"] as? String == "gitBranches")
        #expect(branches["workspaceId"] as? String == "ws-1")

        let checkout = try decode(
            BridgeAction.gitCheckout(workspaceId: "ws-1", branch: "feature/x"))
        #expect(checkout["kind"] as? String == "gitCheckout")
        #expect(checkout["branch"] as? String == "feature/x")

        // The watch carries workspaceId (for the allowlist gate) AND chatId
        // (what it actually acts on). The Mac rejects the payload without both.
        let watch = try decode(
            BridgeAction.githubWatchPr(workspaceId: "ws-1", chatId: "chat-1", watch: true))
        #expect(watch["kind"] as? String == "githubWatchPr")
        #expect(watch["workspaceId"] as? String == "ws-1")
        #expect(watch["chatId"] as? String == "chat-1")
        #expect(watch["watch"] as? Bool == true)

        let unwatch = try decode(
            BridgeAction.githubWatchPr(workspaceId: "ws-1", chatId: "chat-1", watch: false))
        #expect(unwatch["watch"] as? Bool == false)
    }

    @Test("gitBranches ack decodes branches and worktrees")
    func branchAckDecodes() throws {
        let json = """
            {"branches":[
               {"name":"master","isCurrent":true,"upstream":"origin/master"},
               {"name":"codex/lifecycle-qa","isCurrent":false,"worktreePath":"/tmp/wt-1"}
             ],
             "worktrees":[
               {"path":"/repo","isCurrent":true},
               {"path":"/tmp/wt-1","branch":"codex/lifecycle-qa","detached":false}
             ]}
            """
        let ack = try JSONDecoder().decode(
            BridgeActionAckData.self, from: Data(json.utf8))
        let branches = try #require(ack.branches)
        #expect(branches.count == 2)
        #expect(branches[0].name == "master")
        #expect(branches[0].isCurrent == true)
        #expect(branches[0].upstream == "origin/master")
        // A branch held by a linked worktree can't be checked out here — the
        // row needs this to say so instead of offering a doomed action.
        #expect(branches[1].worktreePath == "/tmp/wt-1")
        let worktrees = try #require(ack.worktrees)
        #expect(worktrees.count == 2)
        #expect(worktrees[0].isCurrent == true)
        #expect(worktrees[1].branch == "codex/lifecycle-qa")
    }

    @Test("githubWatchPr ack carries the Mac's final watch state")
    func watchAckDecodes() throws {
        // The Mac refuses when there is no open PR, so the acked value — not
        // the requested one — is what the toggle must settle on.
        let refused = try JSONDecoder().decode(
            BridgeActionAckData.self, from: Data(#"{"watching":false}"#.utf8))
        #expect(refused.watching == false)
        let accepted = try JSONDecoder().decode(
            BridgeActionAckData.self, from: Data(#"{"watching":true}"#.utf8))
        #expect(accepted.watching == true)
        // Older Macs omit the field entirely — must decode, not throw.
        let legacy = try JSONDecoder().decode(BridgeActionAckData.self, from: Data("{}".utf8))
        #expect(legacy.watching == nil)
        #expect(legacy.branches == nil)
    }

    @Test("threadMediaFetch helper encodes bounded media request")
    func threadMediaFetchHelperEncodes() throws {
        func decode(_ params: [String: Any]) throws -> [String: Any] {
            let payloadBase64 = try #require(params["payloadBase64"] as? String)
            let payloadData = try #require(Data(base64Encoded: payloadBase64))
            return try #require(
                try JSONSerialization.jsonObject(with: payloadData) as? [String: Any])
        }

        let thumbnail = BridgeAction.threadMediaFetch(
            workspaceId: "ws-1", threadId: "t-1", rowId: "m7", mediaId: "media-1",
            variant: "thumbnail", maxBytes: 128_000)
        let thumbnailPayload = try decode(thumbnail)
        #expect(thumbnailPayload["kind"] as? String == "threadMediaFetch")
        #expect(thumbnailPayload["workspaceId"] as? String == "ws-1")
        #expect(thumbnailPayload["threadId"] as? String == "t-1")
        #expect(thumbnailPayload["rowId"] as? String == "m7")
        #expect(thumbnailPayload["mediaId"] as? String == "media-1")
        #expect(thumbnailPayload["variant"] as? String == "thumbnail")
        #expect(thumbnailPayload["maxBytes"] as? Int == 128_000)
        #expect(thumbnailPayload["actionId"] as? String != nil)

        let full = BridgeAction.threadMediaFetch(
            workspaceId: "ws-1", threadId: "t-1", rowId: "m7", mediaId: "media-1",
            variant: "full", maxBytes: 8 * 1024 * 1024)
        let fullPayload = try decode(full)
        #expect(fullPayload["variant"] as? String == "full")
        #expect(fullPayload["maxBytes"] as? Int == 8 * 1024 * 1024)
    }

    @Test("threadMediaFetch range mode emits offset/length; unranged omits them")
    func threadMediaFetchRangeEncodes() throws {
        func decode(_ params: [String: Any]) throws -> [String: Any] {
            let payloadBase64 = try #require(params["payloadBase64"] as? String)
            let payloadData = try #require(Data(base64Encoded: payloadBase64))
            return try #require(
                try JSONSerialization.jsonObject(with: payloadData) as? [String: Any])
        }

        // Range mode: BOTH offset + length present → both keys emitted.
        let ranged = BridgeAction.threadMediaFetch(
            workspaceId: "ws-1", threadId: "t-1", rowId: "m7", mediaId: "media-1",
            variant: "full", maxBytes: 448 * 1024, offset: 1024, length: 448 * 1024)
        let rangedPayload = try decode(ranged)
        #expect(rangedPayload["offset"] as? Int == 1024)
        #expect(rangedPayload["length"] as? Int == 448 * 1024)
        #expect(rangedPayload["variant"] as? String == "full")

        // Unranged (default call, no offset/length) → keys MUST be absent so the
        // payload encodes byte-identically to the pre-range helper.
        let unranged = BridgeAction.threadMediaFetch(
            workspaceId: "ws-1", threadId: "t-1", rowId: "m7", mediaId: "media-1",
            variant: "thumbnail", maxBytes: 128_000)
        let unrangedPayload = try decode(unranged)
        #expect(unrangedPayload["offset"] == nil)
        #expect(unrangedPayload["length"] == nil)

        // Only one of the pair supplied → still omitted (both-or-nothing).
        let halfOffset = BridgeAction.threadMediaFetch(
            workspaceId: "ws-1", threadId: "t-1", rowId: "m7", mediaId: "media-1",
            offset: 1024)
        #expect(try decode(halfOffset)["offset"] == nil)
        let halfLength = BridgeAction.threadMediaFetch(
            workspaceId: "ws-1", threadId: "t-1", rowId: "m7", mediaId: "media-1",
            length: 4096)
        #expect(try decode(halfLength)["length"] == nil)
    }

    @Test("TranscriptMediaFetchResult decodes range fields and stays backward-compatible")
    func decodeRangeMediaFetchAck() throws {
        // Range-mode ack: totalBytes + offset present alongside the slice bytes.
        let rangeJson = """
            {
              "accepted": true, "executed": true, "message": "Fetched media slice.",
              "data": {
                "mediaId": "media-1",
                "media": {
                  "id": "media-1",
                  "mimeType": "video/mp4",
                  "dataBase64": "AAECAwQF",
                  "byteLength": 6,
                  "offset": 1024,
                  "totalBytes": 1048576,
                  "variant": "full"
                }
              }
            }
            """
        let rangeAck = try JSONDecoder().decode(BridgeActionAck.self, from: Data(rangeJson.utf8))
        let rangeMedia = try #require(rangeAck.data?.media)
        #expect(rangeMedia.totalBytes == 1_048_576)
        #expect(rangeMedia.offset == 1024)
        #expect(rangeMedia.byteLength == 6)
        #expect(rangeMedia.mimeType == "video/mp4")

        // A legacy (no-range) media payload still decodes; the new optionals → nil.
        let legacyJson = """
            {
              "id": "media-2",
              "mimeType": "image/png",
              "dataBase64": "iVBORw0KGgo=",
              "byteLength": 8,
              "variant": "thumbnail"
            }
            """
        let legacy = try JSONDecoder().decode(
            TranscriptMediaFetchResult.self, from: Data(legacyJson.utf8))
        #expect(legacy.totalBytes == nil)
        #expect(legacy.offset == nil)
        #expect(legacy.byteLength == 8)
    }
}
