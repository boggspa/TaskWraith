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
}
