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
