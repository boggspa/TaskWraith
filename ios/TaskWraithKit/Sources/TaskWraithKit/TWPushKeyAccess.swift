// TWPushKeyAccess — shared key/identity access for rich (encrypted) pushes. Used
// by BOTH the app (to WRITE the seed into the shared keychain group + the paired
// hosts into the App Group) and the Notification Service Extension (to READ them
// for decryption). The identifiers MUST match the entitlements on both targets.

import Foundation
import Security

public enum TWPushKeyAccess {
    /// App Group container shared between the app + the NSE.
    public static let appGroup = "group.com.TaskWraith.companion"
    /// Fully-qualified keychain access group (<TeamID>.<group>) shared likewise.
    /// The `kSecAttrAccessGroup` value passed to SecItem* must be fully qualified
    /// (the `$(AppIdentifierPrefix)` substitution only happens in the .entitlements).
    public static let keychainAccessGroup = "8CZML8FK2D.com.taskwraith.companion.shared"

    static let keychainService = "com.taskwraith.companion"
    static let keychainAccount = "remote-identity-seed"

    /// The phone's 32-byte identity seed from the SHARED keychain access group
    /// (readable by both the app and the NSE after first unlock). nil if it's
    /// absent, not yet migrated into the shared group, or the device is locked.
    public static func deviceSeed() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrAccessGroup as String: keychainAccessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data, data.count == 32
        else { return nil }
        return data
    }

    /// The App-Group-backed paired-host store (each record carries the host's
    /// `macAgreePub`). Falls back to `.standard` only if the App Group container
    /// is unavailable — in the NSE that means no hosts (→ generic fallback).
    public static func pairedHostStore() -> PairedHostStore {
        UserDefaultsPairedHostStore(defaults: UserDefaults(suiteName: appGroup) ?? .standard)
    }
}
