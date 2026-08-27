import Testing

import TaskWraithKit

@Suite("Transcript media public construction")
struct TranscriptMediaFetchResultPublicInitializerTests {
    @Test("UI clients can construct an assembled full-size media result")
    func constructsAcrossTheModuleBoundary() {
        let result = TranscriptMediaFetchResult(
            id: "media-1",
            rowId: "row-1",
            threadId: "thread-1",
            name: "annotated.jpg",
            source: "transcript",
            mimeType: "image/jpeg",
            dataBase64: "AA==",
            width: 640,
            height: 480,
            byteLength: 1,
            variant: "full")

        #expect(result.id == "media-1")
        #expect(result.rowId == "row-1")
        #expect(result.threadId == "thread-1")
        #expect(result.variant == "full")
        #expect(result.totalBytes == nil)
        #expect(result.offset == nil)
    }
}
