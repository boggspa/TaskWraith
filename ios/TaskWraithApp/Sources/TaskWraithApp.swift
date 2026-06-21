// TaskWraith iOS companion — app entry point. Thin shell over TaskWraithUI's
// RootView + RemoteSessionModel (which wraps the proven RelayTransportClient).
// Compiled by the Xcode app target (see ../README.md), NOT by SwiftPM — so the
// @main App and the iOS-only Keychain store live here, outside the package.

import SwiftUI
import UIKit
import UserNotifications
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
final class PushAppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    let model: RemoteSessionModel

    /// Category id carried on blocking pushes (mirrors Http2ApnsPusher's
    /// APNS_CATEGORY_APPROVAL); selects the Approve/Deny action buttons.
    private static let approvalCategoryId = "TW_APPROVAL"
    private static let approveActionId = "TW_APPROVE"
    private static let denyActionId = "TW_DENY"

    override init() {
        self.model = RemoteSessionModel(
            identityStore: KeychainIdentitySeedStore(account: "remote-identity-seed"))
        super.init()
    }

    func application(
        _: UIApplication,
        didFinishLaunchingWithOptions _: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set the delegate + register categories UNCONDITIONALLY at launch
        // (before any auth check) — registration is idempotent and must precede
        // the first push, or its category id resolves to no action buttons.
        UNUserNotificationCenter.current().delegate = self
        registerNotificationCategories()
        return true
    }

    func applicationDidBecomeActive(_: UIApplication) {
        // Reconcile the home-screen icon with the stored preference on foreground.
        // Cheap no-op when already in sync (iOS persists the choice itself), so
        // this never re-triggers the system "changed icon" alert.
        TWAppIconController.reconcile()
    }

    private func registerNotificationCategories() {
        // .authenticationRequired is MANDATORY: Face ID / passcode must clear
        // before the handler fires, so a bystander can't approve from a locked
        // screen. .destructive tints Deny.
        let approve = UNNotificationAction(
            identifier: Self.approveActionId, title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(
            identifier: Self.denyActionId, title: "Deny",
            options: [.destructive, .authenticationRequired])
        let approvalCategory = UNNotificationCategory(
            identifier: Self.approvalCategoryId, actions: [approve, deny],
            intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([approvalCategory])
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

    // Show blocking pushes (with their action buttons) even when foregrounded.
    func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Lock-screen Approve/Deny + plain-tap deep link.
    func userNotificationCenter(
        _: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let actionId = response.actionIdentifier
        // approvalId === toolCallId on the Mac; accept toolCallId as a
        // forward-compat fallback if a future push adds it explicitly.
        let toolCallId = (userInfo["toolCallId"] as? String) ?? (userInfo["approvalId"] as? String)
        let threadId = userInfo["threadId"] as? String
        let workspaceId = userInfo["workspaceId"] as? String

        if actionId == Self.approveActionId || actionId == Self.denyActionId {
            guard let toolCallId else {
                completionHandler()
                return
            }
            let decision = actionId == Self.approveActionId ? "accept" : "decline"
            // Hold a background-task assertion across the reconnect+ack; end it
            // (and call completionHandler) on EVERY path so iOS never sees a hung
            // handler.
            var bgTask: UIBackgroundTaskIdentifier = .invalid
            bgTask = UIApplication.shared.beginBackgroundTask(withName: "notif-action") {
                if bgTask != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTask)
                    bgTask = .invalid
                }
            }
            Task { @MainActor in
                let ok = await model.sendApprovalDecisionFromNotification(
                    toolCallId: toolCallId, decision: decision,
                    workspaceId: workspaceId, threadId: threadId)
                if !ok {
                    // Reconnect missed the background window (Mac offline, cold
                    // cellular, or Keychain locked before first unlock). The
                    // Mac's auto-deny timer is the safety net; nudge the user.
                    postLocalNotification("Couldn't reach your Mac — open TaskWraith to respond.")
                }
                completionHandler()
                if bgTask != .invalid {
                    UIApplication.shared.endBackgroundTask(bgTask)
                    bgTask = .invalid
                }
            }
            return
        }

        // Plain tap (or the fallback local notification's tap) → deep-link to
        // the thread's approval card.
        if actionId == UNNotificationDefaultActionIdentifier, let threadId {
            model.handleNotificationTap(threadId: threadId)
        }
        completionHandler()
    }

    private func postLocalNotification(_ body: String) {
        let content = UNMutableNotificationContent()
        content.title = "TaskWraith"
        content.body = body
        let request = UNNotificationRequest(
            identifier: "tw-local-\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
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
