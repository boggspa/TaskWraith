import Testing

@testable import TaskWraithUI

@Suite("Offline composer send policy")
struct OfflineComposerSendPolicyTests {
    @Test("offline text is accepted into the durable outbox")
    func offlineTextQueues() {
        #expect(
            OfflineComposerSendPolicy.decide(
                shouldQueue: true,
                threadId: "thread-1",
                text: "  keep this  ",
                attachmentCount: 0)
                == .queueText("keep this"))
    }

    @Test("offline text plus an image is refused as one intact draft")
    func offlineTextAndImageStayTogether() {
        #expect(
            OfflineComposerSendPolicy.decide(
                shouldQueue: true,
                threadId: "thread-1",
                text: "fix the marked area",
                attachmentCount: 1)
                == .refuseAttachments)
    }

    @Test("an offline attachment-only send is also refused")
    func offlineImageOnlyIsRefused() {
        #expect(
            OfflineComposerSendPolicy.decide(
                shouldQueue: true,
                threadId: "thread-1",
                text: "",
                attachmentCount: 1)
                == .refuseAttachments)
    }

    @Test("online sends stay on the ordinary attachment-capable path")
    func onlineAttachmentsSendNormally() {
        #expect(
            OfflineComposerSendPolicy.decide(
                shouldQueue: false,
                threadId: "thread-1",
                text: "fix this",
                attachmentCount: 1)
                == .sendNormally)
    }
}
