import XCTest
import Security
import UIKit
import TaskWraithUI
@testable import TaskWraith

@MainActor
final class TaskWraithAppLifecycleTests: XCTestCase {
    func testKeychainIdentitySeedPersistsAndRejectsCorruptRecords() throws {
        let account = "test-remote-identity-seed-\(UUID().uuidString)"
        let keychain = FakeKeychainSeedAccess()
        let store = KeychainIdentitySeedStore(account: account, keychain: keychain)

        let first = try store.loadOrCreateSeed()
        let second = try store.loadOrCreateSeed()
        XCTAssertEqual(first.count, 32)
        XCTAssertEqual(second, first)

        keychain.storedData = Data([0x01, 0x02, 0x03])

        XCTAssertThrowsError(try store.loadOrCreateSeed()) { error in
            guard case IdentitySeedStoreError.readFailed(let detail) = error else {
                XCTFail("Expected readFailed for corrupt Keychain seed, got \(error)")
                return
            }
            XCTAssertTrue(detail.contains("corrupt Keychain record"))
        }
    }

    func testAppDelegateOwnsModelAndCompletesSilentWakeWithoutSwiftUIAttach() throws {
        let delegate = PushAppDelegate()

        XCTAssertFalse(delegate.model.hasStoredPairing)

        let completed = expectation(description: "silent wake completed")

        delegate.application(UIApplication.shared, didReceiveRemoteNotification: [:]) { result in
            XCTAssertEqual(result, .failed)
            completed.fulfill()
        }

        wait(for: [completed], timeout: 2)
    }

    func testReviewRequiredInfoPlistEntriesArePresent() throws {
        let appBundle = Bundle(identifier: "com.taskwraith.companion") ?? Bundle.main

        let cameraUsage = try XCTUnwrap(
            appBundle.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String)
        XCTAssertTrue(cameraUsage.localizedCaseInsensitiveContains("pairing QR"))

        let backgroundModes = try XCTUnwrap(
            appBundle.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])
        XCTAssertTrue(backgroundModes.contains("remote-notification"))

        // The app qualifies for the export-compliance exemption, so the
        // manifest declares ITSAppUsesNonExemptEncryption = false (see
        // project.yml). Assert the shipped value rather than the inverse.
        let encryptionFlag = try XCTUnwrap(
            appBundle.object(forInfoDictionaryKey: "ITSAppUsesNonExemptEncryption") as? Bool)
        XCTAssertFalse(encryptionFlag)
    }

    // ── Shared-keychain seed migration (rich pushes) ──────────────────────────
    // The Notification Service Extension can only read the seed from the shared
    // access group, so an existing seed must be COPIED there — never moved out
    // of the app's default group (the Mac pinned this identity).

    func testSharedGroupSeedMigratesLegacyWithoutDeletingIt() throws {
        let keychain = FakeGroupKeychainSeedAccess()
        let legacy = Data(repeating: 0xAB, count: 32)
        keychain.slots[FakeGroupKeychainSeedAccess.defaultSlot] = legacy
        let group = "8CZML8FK2D.com.taskwraith.companion.shared"
        let store = KeychainIdentitySeedStore(
            account: "acct", accessGroup: group, keychain: keychain)

        let seed = try store.loadOrCreateSeed()

        XCTAssertEqual(seed, legacy) // the pinned identity is preserved
        XCTAssertEqual(keychain.slots[group], legacy) // copied into the shared group
        // Legacy copy must survive (never deleted before/after the shared copy).
        XCTAssertEqual(keychain.slots[FakeGroupKeychainSeedAccess.defaultSlot], legacy)
    }

    func testSharedGroupSeedPrefersExistingSharedCopy() throws {
        let keychain = FakeGroupKeychainSeedAccess()
        let group = "8CZML8FK2D.com.taskwraith.companion.shared"
        let shared = Data(repeating: 0x11, count: 32)
        keychain.slots[group] = shared
        keychain.slots[FakeGroupKeychainSeedAccess.defaultSlot] = Data(repeating: 0x22, count: 32)
        let store = KeychainIdentitySeedStore(
            account: "acct", accessGroup: group, keychain: keychain)

        XCTAssertEqual(try store.loadOrCreateSeed(), shared) // shared wins, no re-migrate
    }

    func testSharedGroupSeedMintsIntoSharedGroupWhenAbsent() throws {
        let keychain = FakeGroupKeychainSeedAccess()
        let group = "8CZML8FK2D.com.taskwraith.companion.shared"
        let store = KeychainIdentitySeedStore(
            account: "acct", accessGroup: group, keychain: keychain)

        let first = try store.loadOrCreateSeed()
        XCTAssertEqual(first.count, 32)
        XCTAssertEqual(keychain.slots[group], first) // minted directly into shared
        XCTAssertNil(keychain.slots[FakeGroupKeychainSeedAccess.defaultSlot]) // not the default
        XCTAssertEqual(try store.loadOrCreateSeed(), first) // stable across reads
    }
}

private final class FakeKeychainSeedAccess: KeychainSeedAccessing, @unchecked Sendable {
    var storedData: Data?
    var addStatus: OSStatus = errSecSuccess
    var copyStatus: OSStatus?

    func copyMatching(
        _ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?
    ) -> OSStatus {
        if let copyStatus { return copyStatus }
        guard let storedData else { return errSecItemNotFound }
        result?.pointee = storedData as CFData
        return errSecSuccess
    }

    func add(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        guard addStatus == errSecSuccess else { return addStatus }
        let values = query as NSDictionary
        storedData = values[kSecValueData as String] as? Data
        return errSecSuccess
    }
}

/// Keychain fake that models multiple access groups, so the shared-group seed
/// migration can be exercised. A query WITHOUT an explicit access group searches
/// "all groups" (Apple's SecItem semantics) — modeled as: the default slot
/// first, else any group slot.
private final class FakeGroupKeychainSeedAccess: KeychainSeedAccessing, @unchecked Sendable {
    static let defaultSlot = "__default__"
    var slots: [String: Data] = [:]

    func copyMatching(
        _ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?
    ) -> OSStatus {
        let q = query as NSDictionary
        if let group = q[kSecAttrAccessGroup as String] as? String {
            guard let data = slots[group] else { return errSecItemNotFound }
            result?.pointee = data as CFData
            return errSecSuccess
        }
        if let data = slots[Self.defaultSlot] ?? slots.values.first {
            result?.pointee = data as CFData
            return errSecSuccess
        }
        return errSecItemNotFound
    }

    func add(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        let q = query as NSDictionary
        guard let data = q[kSecValueData as String] as? Data else { return errSecParam }
        let group = (q[kSecAttrAccessGroup as String] as? String) ?? Self.defaultSlot
        if slots[group] != nil { return errSecDuplicateItem }
        slots[group] = data
        return errSecSuccess
    }
}
