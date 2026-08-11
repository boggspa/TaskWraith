// taskwraith-push-trigger-v1 — Tier-2 push gateway signing (Swift port of
// src/shared/e2ee/push.ts). The phone signs APNs register/deregister requests
// with its Keychain identity so the project relay can hold a routing-only
// token table without ever trusting a client-asserted pairID. The trigger
// verb is Mac-signed and never constructed on this side; its signing string
// lives here anyway so the byte contract has exactly one Swift home.
//
// LOCKED with src/shared/e2ee/crossImplVectors.test.ts golden vectors (the
// design doc left the register/deregister byte layout unwritten — these two
// files author it): pipe-joined fields, String(Bool) booleans, ms-epoch
// issuedAt, protocol id 'taskwraith-push-trigger-v1' (deliberately NOT the
// doc's 'taskwraith-push-v1', which is already PushSeal's domain-separation
// prefix).

import CryptoKit
import Foundation

public enum TWPush {
    public static let id = "taskwraith-push-trigger-v1"

    public static func apnsRegisterSigningString(
        macIdentityPubKey: String, iphoneIdentityPubKey: String,
        deviceTokenHex: String, env: String, notifyFinishedTurns: Bool,
        issuedAt: Int64, nonce: String
    ) -> String {
        [
            id, "apns-register", macIdentityPubKey, iphoneIdentityPubKey,
            deviceTokenHex, env, String(notifyFinishedTurns),
            String(issuedAt), nonce,
        ].joined(separator: "|")
    }

    public static func apnsDeregisterSigningString(
        macIdentityPubKey: String, iphoneIdentityPubKey: String,
        issuedAt: Int64, nonce: String
    ) -> String {
        [id, "apns-deregister", macIdentityPubKey, iphoneIdentityPubKey, String(issuedAt), nonce]
            .joined(separator: "|")
    }

    public static func triggerSigningString(
        macIdentityPubKey: String, targetIphoneIdentityPubKey: String,
        reason: String, threadId: String?, runId: String?, taskId: String?,
        collapseId: String, issuedAt: Int64, nonce: String
    ) -> String {
        [
            id, "trigger", macIdentityPubKey, targetIphoneIdentityPubKey, reason,
            threadId ?? "", runId ?? "", taskId ?? "", collapseId,
            String(issuedAt), nonce,
        ].joined(separator: "|")
    }

    public struct ApnsRegisterRequest: Codable, Sendable {
        public var v = 1
        public var macIdentityPubKey: String
        public var iphoneIdentityPubKey: String
        public var deviceTokenHex: String
        public var env: String
        public var notifyFinishedTurns: Bool
        public var issuedAt: Int64
        public var nonce: String
        public var sig: String
    }

    public struct ApnsDeregisterRequest: Codable, Sendable {
        public var v = 1
        public var macIdentityPubKey: String
        public var iphoneIdentityPubKey: String
        public var issuedAt: Int64
        public var nonce: String
        public var sig: String
    }

    /// Build a phone-signed register. `env` must be exactly "production" or
    /// "sandbox" (from #if DEBUG); the relay validates it verbatim, and it is
    /// INSIDE the signature so a middlebox cannot re-aim the device at the
    /// wrong Apple gateway. Same for the notifyFinishedTurns opt-out.
    public static func signApnsRegisterRequest(
        identity: Curve25519.Signing.PrivateKey, macIdentityPubKey: String,
        deviceTokenHex: String, env: String, notifyFinishedTurns: Bool,
        nonce: Data, issuedAt: Int64
    ) throws -> ApnsRegisterRequest {
        let iphoneIdentityPubKey = Base64.encode(identity.publicKey.rawRepresentation)
        let nonceB64 = Base64.encode(nonce)
        let message = apnsRegisterSigningString(
            macIdentityPubKey: macIdentityPubKey, iphoneIdentityPubKey: iphoneIdentityPubKey,
            deviceTokenHex: deviceTokenHex, env: env,
            notifyFinishedTurns: notifyFinishedTurns, issuedAt: issuedAt, nonce: nonceB64)
        let sig = try identity.signature(for: Data(message.utf8))
        return ApnsRegisterRequest(
            macIdentityPubKey: macIdentityPubKey, iphoneIdentityPubKey: iphoneIdentityPubKey,
            deviceTokenHex: deviceTokenHex, env: env,
            notifyFinishedTurns: notifyFinishedTurns, issuedAt: issuedAt,
            nonce: nonceB64, sig: Base64.encode(sig))
    }

    public static func signApnsDeregisterRequest(
        identity: Curve25519.Signing.PrivateKey, macIdentityPubKey: String,
        nonce: Data, issuedAt: Int64
    ) throws -> ApnsDeregisterRequest {
        let iphoneIdentityPubKey = Base64.encode(identity.publicKey.rawRepresentation)
        let nonceB64 = Base64.encode(nonce)
        let message = apnsDeregisterSigningString(
            macIdentityPubKey: macIdentityPubKey, iphoneIdentityPubKey: iphoneIdentityPubKey,
            issuedAt: issuedAt, nonce: nonceB64)
        let sig = try identity.signature(for: Data(message.utf8))
        return ApnsDeregisterRequest(
            macIdentityPubKey: macIdentityPubKey, iphoneIdentityPubKey: iphoneIdentityPubKey,
            issuedAt: issuedAt, nonce: nonceB64, sig: Base64.encode(sig))
    }
}
