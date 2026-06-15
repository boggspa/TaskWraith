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
    // bridges them. Token registration itself is requested by the session
    // model AFTER pairing succeeds (no cold-launch permission prompt).
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @StateObject private var model = RemoteSessionModel(
        identityStore: KeychainIdentitySeedStore(account: "remote-identity-seed"))

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onAppear { pushDelegate.model = model }
        }
    }
}

/// Receives the APNs device token + forwards it to the session model, which
/// ships it to the Mac as a registerApnsToken action. Tokens rotate — iOS
/// re-delivers on every registerForRemoteNotifications() call, and the model
/// re-registers on each launch once authorized.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
    weak var model: RemoteSessionModel?

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
        Task { @MainActor in
            self.model?.handleApnsToken(hex, env: env)
        }
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
        Task { @MainActor in
            guard let model = self.model else {
                completionHandler(.noData)
                return
            }
            let connected = await model.handleRemoteWake(reason: "remote-notification")
            completionHandler(connected ? .newData : .failed)
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

    func loadOrCreateSeed() throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
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
        return SecItemAdd(add as CFDictionary, nil)
    }
}
