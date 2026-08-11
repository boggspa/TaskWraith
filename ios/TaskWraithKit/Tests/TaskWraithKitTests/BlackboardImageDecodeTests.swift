import Foundation
import Testing

@testable import TaskWraithKit

struct BlackboardImageDecodeTests {
    @Test func decodesBoundedBlackboardImageMetadata() throws {
        let json = """
            {
              "id": "entry-1",
              "key": "observed-state",
              "value": "Captured during verification.",
              "category": "fact",
              "scope": "session",
              "images": [
                {
                  "attachmentId": "blackboard:entry-1:image:0:abc",
                  "name": "observed.png",
                  "mimeType": "image/png",
                  "byteLength": 1024,
                  "thumbnail": {
                    "dataBase64": "c21hbGw=",
                    "mimeType": "image/png",
                    "width": 80,
                    "height": 60
                  }
                }
              ]
            }
            """

        let entry = try JSONDecoder().decode(
            RemoteThreadSnapshot.BlackboardEntry.self,
            from: Data(json.utf8)
        )

        #expect(entry.images?.first?.attachmentId == "blackboard:entry-1:image:0:abc")
        #expect(entry.images?.first?.name == "observed.png")
        #expect(entry.images?.first?.thumbnail?.dataBase64 == "c21hbGw=")
        #expect(entry.images?.first?.thumbnail?.width == 80)
    }

    @Test func pollDecodesWithTallyAndStandingVote() throws {
        let json = """
            {"id":"poll-1","key":"vote","value":"Which migration order?","category":"decision",
             "scope":"round",
             "poll":{"options":["A first","B first"],
                     "votes":[{"voterId":"p-1","choice":"A first"},
                              {"voterId":"user","choice":"B first"}],
                     "userChoice":"B first"}}
            """
        let entry = try JSONDecoder().decode(
            RemoteThreadSnapshot.BlackboardEntry.self, from: Data(json.utf8))
        #expect(entry.poll?.options == ["A first", "B first"])
        #expect(entry.poll?.votes?.count == 2)
        #expect(entry.poll?.userChoice == "B first")
        // An ordinary note stays poll-less.
        let note = try JSONDecoder().decode(
            RemoteThreadSnapshot.BlackboardEntry.self,
            from: Data(#"{"id":"n","key":"k","value":"v","category":"note","scope":"chat"}"#.utf8))
        #expect(note.poll == nil)
    }

    @Test func pollVoteActionCarriesTheContract() throws {
        let params = BridgeAction.blackboardPollVote(
            workspaceId: "ws-1", threadId: "t-1", pollId: "poll-1", choice: "A first")
        let base64 = try #require(params["payloadBase64"] as? String)
        let data = try #require(Data(base64Encoded: base64))
        let payload = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(payload["kind"] as? String == "blackboardPollVote")
        #expect(payload["pollId"] as? String == "poll-1")
        #expect(payload["choice"] as? String == "A first")
    }
}
