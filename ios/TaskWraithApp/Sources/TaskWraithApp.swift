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
    private static let questionCategoryId = "TW_QUESTION"
    private static let approveActionId = "TW_APPROVE"
    private static let denyActionId = "TW_DENY"
    private static let openActionId = "TW_OPEN"

    override init() {
        // Back the host store + identity seed with the App Group + shared
        // keychain group the Notification Service Extension reads, so it can
        // decrypt rich pushes while the app is backgrounded/closed. Migrate any
        // pre-existing `.standard` host document into the shared suite first
        // (no-op once moved; never clobbers newer shared data).
        let sharedDefaults = UserDefaults(suiteName: TWPushKeyAccess.appGroup) ?? .standard
        UserDefaultsPairedHostStore.migrate(from: .standard, to: sharedDefaults)
        self.model = RemoteSessionModel(
            identityStore: KeychainIdentitySeedStore(
                account: "remote-identity-seed",
                accessGroup: TWPushKeyAccess.keychainAccessGroup),
            pairingStore: UserDefaultsPairedHostStore(defaults: sharedDefaults))
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
        let open = UNNotificationAction(
            identifier: Self.openActionId, title: "Open", options: [.foreground])
        let approvalCategory = UNNotificationCategory(
            identifier: Self.approvalCategoryId, actions: [approve, deny],
            intentIdentifiers: [], options: [])
        let questionCategory = UNNotificationCategory(
            identifier: Self.questionCategoryId, actions: [open],
            intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([
            approvalCategory, questionCategory
        ])
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

    // Foreground presentation policy. Blocking pushes (approval/question) keep
    // showing with their action buttons. Completions are special-cased so the
    // phone shows ONE rich banner, never two: our own local rich banner (posted
    // by the model from the E2EE projection) always shows; the Mac's generic
    // routing-only runComplete/runFailed twin is dropped while foregrounded
    // because the model already surfaces the rich version (or intentionally
    // stays quiet when the thread is on-screen).
    func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        if userInfo["tw_rich_local"] != nil {
            completionHandler([.banner, .sound, .list])
            return
        }
        if let reason = userInfo["reason"] as? String, reason == "runComplete" || reason == "runFailed" {
            completionHandler([])
            return
        }
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
        if (actionId == UNNotificationDefaultActionIdentifier || actionId == Self.openActionId),
            let threadId
        {
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
    /// Fully-qualified shared keychain access group (e.g.
    /// `8CZML8FK2D.com.taskwraith.companion.shared`, == `TWPushKeyAccess
    /// .keychainAccessGroup`). When set, the seed is kept in this shared group so
    /// the Notification Service Extension can read it to decrypt rich pushes
    /// while the app is closed; a pre-existing seed in the app's default group is
    /// COPIED in (never deleted — the Mac pinned this identity, it must survive).
    /// nil preserves the original single-group behaviour (used by unit tests).
    let accessGroup: String?
    private let keychain: any KeychainSeedAccessing

    init(
        account: String,
        accessGroup: String? = nil,
        keychain: any KeychainSeedAccessing = SystemKeychainSeedAccess()
    ) {
        self.account = account
        self.accessGroup = accessGroup
        self.keychain = keychain
    }

    func loadOrCreateSeed() throws -> Data {
        guard let accessGroup else { return try loadOrCreateLegacy() }
        return try loadOrCreateShared(accessGroup: accessGroup)
    }

    /// Original single-group behaviour (no shared access group) — kept
    /// byte-for-byte so the app's pre-rich-push reads + unit tests retain their
    /// exact semantics (incl. the "corrupt Keychain record" error message).
    private func loadOrCreateLegacy() throws -> Data {
        switch readSeed(group: nil) {
        case .ok(let seed):
            return seed
        case .corrupt(let size):
            throw IdentitySeedStoreError.readFailed("corrupt Keychain record (\(size) bytes)")
        case .missing:
            let seed = Curve25519.Signing.PrivateKey().rawRepresentation
            let addStatus = add(seed, group: nil)
            guard addStatus == errSecSuccess else {
                throw IdentitySeedStoreError.persistFailed("Keychain add failed (\(addStatus))")
            }
            return seed
        case .error(let status):
            throw IdentitySeedStoreError.readFailed("Keychain read failed (\(status))")
        }
    }

    /// Shared-group behaviour (rich pushes): (1) prefer the shared-group copy
    /// (fresh installs + after migration); (2) else COPY a legacy seed from the
    /// app's default group into the shared group, never deleting the original;
    /// (3) else mint a fresh seed directly into the shared group.
    private func loadOrCreateShared(accessGroup: String) throws -> Data {
        switch readSeed(group: accessGroup) {
        case .ok(let seed):
            return seed
        case .missing:
            break
        case .corrupt, .error:
            // The shared access group is NOT a usable identity source, so do not
            // let it brick the device. `.error` is typically -34018
            // errSecMissingEntitlement: this build's signing lacks the
            // `…companion.shared` Keychain-Sharing entitlement because that
            // capability was never provisioned on the Apple Developer portal (the
            // NSE / App-Group "activation"). `.corrupt` is a bad shared copy.
            // Either way, fall back to the app's OWN default group, which is
            // always readable and holds the pinned seed — the shared copy is only
            // ever a convenience mirror for the Notification Service Extension,
            // never the source of truth. (Field incident 2026-06-25: this read
            // threw on -34018 and stranded both paired devices on the "Device
            // identity unavailable" screen; reinstall couldn't help because
            // Keychain items survive app deletion.) A genuinely locked device
            // re-fails the default read below and still surfaces the recovery UI.
            return try loadOrCreateLegacy()
        }
        // A nil group makes SecItem search ALL the app's access groups, so this
        // finds a legacy seed in the app's default group.
        switch readSeed(group: nil) {
        case .ok(let legacy):
            let status = add(legacy, group: accessGroup)
            // errSecDuplicateItem: a shared copy already raced in — equally fine.
            guard status == errSecSuccess || status == errSecDuplicateItem else {
                throw IdentitySeedStoreError.persistFailed("Keychain migrate failed (\(status))")
            }
            return legacy
        case .corrupt(let size):
            throw IdentitySeedStoreError.readFailed("corrupt Keychain record (\(size) bytes)")
        case .error(let status):
            throw IdentitySeedStoreError.readFailed("Keychain read failed (\(status))")
        case .missing:
            break
        }
        let seed = Curve25519.Signing.PrivateKey().rawRepresentation
        let addStatus = add(seed, group: accessGroup)
        guard addStatus == errSecSuccess else {
            throw IdentitySeedStoreError.persistFailed("Keychain add failed (\(addStatus))")
        }
        return seed
    }

    private enum SeedRead {
        case ok(Data)
        case missing
        case corrupt(Int)
        case error(OSStatus)
    }

    private func readSeed(group: String?) -> SeedRead {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        var item: CFTypeRef?
        let status = keychain.copyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, data.count == 32 else {
                return .corrupt((item as? Data)?.count ?? -1)
            }
            return .ok(data)
        case errSecItemNotFound:
            return .missing
        default:
            return .error(status)
        }
    }

    private func add(_ data: Data, group: String?) -> OSStatus {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return keychain.add(query as CFDictionary, nil)
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
