// TaskWraith iOS companion — app entry point. Thin shell over TaskWraithUI's
// RootView + RemoteSessionModel (which wraps the proven RelayTransportClient).
// Compiled by the Xcode app target (see ../README.md), NOT by SwiftPM — so the
// @main App and the iOS-only Keychain store live here, outside the package.

import SwiftUI
import UIKit
import Security
import CryptoKit
import TaskWraithKit
import TaskWraithUI

@main
struct TaskWraithApp: App {
    // SwiftUI has no native hook for the APNs token callbacks — the adaptor
    // owns the session model so background APNs launches can reconnect even
    // before SwiftUI gets an onAppear.
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate

    var body: some Scene {
        WindowGroup {
            RootView(model: pushDelegate.model)
        }
    }
}

/// Receives the APNs device token + forwards it to the session model, which
/// ships it to the Mac as a registerApnsToken action. Tokens rotate — iOS
/// re-delivers on every registerForRemoteNotifications() call, and the model
/// re-registers on each launch once authorized.
@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    let model: RemoteSessionModel

    override init() {
        self.model = RemoteSessionModel(
            identityStore: KeychainIdentitySeedStore(account: "remote-identity-seed"))
        super.init()
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
            let env = "sandbox"
        #else
            let env = "production"
        #endif
        model.handleApnsToken(hex, env: env)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[tw] APNs registration failed: \(error.localizedDescription)")
    }

    func application(
        _: UIApplication,
        didReceiveRemoteNotification _: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // Hold a background-task assertion across the async reconnect/handshake.
        // Without it iOS can suspend us mid-flight so the completion handler
        // never fires — which the OS counts as a hung wake and penalises with
        // fewer future background launches. End it idempotently on every path.
        var bgTask: UIBackgroundTaskIdentifier = .invalid
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "remote-wake") {
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
        }
        Task { @MainActor in
            let connected = await model.handleRemoteWake(reason: "remote-notification")
            completionHandler(connected ? .newData : .failed)
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
        }
    }
}

/// Keychain-backed identity seed (32-byte Ed25519 raw representation), generated
/// once and reused so the Mac's pin survives reinstall-free app launches. Stored
/// with `ThisDeviceOnly` accessibility — the transport identity must never sync
/// to another device.
///
/// Security review (residual MED, fixed): generation happens ONLY when the
/// Keychain positively reports the item absent (errSecItemNotFound). Any other
/// read failure — and any write failure — throws so the shell can show a
/// recovery screen, instead of silently becoming a stranger the Mac refuses.
struct KeychainIdentitySeedStore: IdentitySeedStore {
    let service = "com.taskwraith.companion"
    let account: String
    private let keychain: any KeychainSeedAccessing

    init(account: String, keychain: any KeychainSeedAccessing = SystemKeychainSeedAccess()) {
        self.account = account
        self.keychain = keychain
    }

    func loadOrCreateSeed() throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = keychain.copyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, data.count == 32 else {
                let size = (item as? Data)?.count ?? -1
                throw IdentitySeedStoreError.readFailed("corrupt Keychain record (\(size) bytes)")
            }
            return data
        case errSecItemNotFound:
            let seed = Curve25519.Signing.PrivateKey().rawRepresentation
            let addStatus = add(seed)
            guard addStatus == errSecSuccess else {
                throw IdentitySeedStoreError.persistFailed("Keychain add failed (\(addStatus))")
            }
            return seed
        default:
            throw IdentitySeedStoreError.readFailed("Keychain read failed (\(status))")
        }
    }

    private func add(_ data: Data) -> OSStatus {
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return keychain.add(add as CFDictionary, nil)
    }
}

protocol KeychainSeedAccessing: Sendable {
    func copyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    func add(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
}

struct SystemKeychainSeedAccess: KeychainSeedAccessing {
    func copyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        SecItemCopyMatching(query, result)
    }

    func add(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        SecItemAdd(query, result)
    }
}
