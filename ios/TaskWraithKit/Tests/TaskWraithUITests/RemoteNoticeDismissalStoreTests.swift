import Foundation
import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

@Suite("Remote notice dismissal store")
struct RemoteNoticeDismissalStoreTests {
    private func freshDefaults() -> UserDefaults {
        let suite = "test.tw.notice-dismissal.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func notice(_ id: String, dismissible: Bool? = true) -> FirstLaunchNotice {
        FirstLaunchNotice(
            id: id, kind: "addition", title: "T", body: "B", tone: "default",
            accent: nil, icon: nil, dismissible: dismissible, groups: nil)
    }

    @Test("a fresh store reports nothing dismissed")
    func nothingDismissedByDefault() {
        let defaults = freshDefaults()
        #expect(RemoteNoticeDismissalStore.isDismissed("a", defaults: defaults) == false)
        #expect(
            RemoteNoticeDismissalStore.dismissedIds(
                among: [notice("a"), notice("b")], defaults: defaults) == [])
    }

    @Test("dismiss persists and round-trips through the store")
    func dismissPersists() {
        let defaults = freshDefaults()
        RemoteNoticeDismissalStore.dismiss("new-additions", defaults: defaults)
        #expect(RemoteNoticeDismissalStore.isDismissed("new-additions", defaults: defaults))
        #expect(RemoteNoticeDismissalStore.isDismissed("other", defaults: defaults) == false)
    }

    @Test("dismissedIds returns only the dismissed subset of a notice list")
    func dismissedSubset() {
        let defaults = freshDefaults()
        RemoteNoticeDismissalStore.dismiss("b", defaults: defaults)
        let ids = RemoteNoticeDismissalStore.dismissedIds(
            among: [notice("a"), notice("b"), notice("c")], defaults: defaults)
        #expect(ids == ["b"])
    }

    @Test("the key format matches the tw.*.dismissed convention")
    func keyFormat() {
        #expect(RemoteNoticeDismissalStore.key("new-additions-2026-07-10")
            == "tw.appNotice.new-additions-2026-07-10.dismissed")
    }
}
