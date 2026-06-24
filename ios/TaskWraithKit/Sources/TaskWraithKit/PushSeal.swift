// taskwraith-e2ee-v1 — encrypted PUSH envelope (Swift twin of
// src/shared/e2ee/pushSeal.ts).
//
// The Notification Service Extension opens a blob the Mac sealed OFFLINE (no
// live session, so the per-connection content keys are unavailable). A static
// shared secret is derived from the two paired identities; see the TS file for
// the full construction + security rationale. This target (TaskWraithKit) has
// zero UIKit/app dependencies, so the NSE can link just this.
//
// The cross-impl vector in PushSealTests pins Node-seal == Swift-open byte-exact
// — in particular that the empty-salt HKDF + X25519-from-HKDF-output agree
// across Node `crypto` and CryptoKit.

import Foundation
import CryptoKit

public struct PushEnvelope: Sendable {
    public let v: Int
    public let salt: Data   // 24B HKDF salt (derives the per-push AEAD subkey)
    public let nonce: Data  // 12B AES-GCM nonce
    public let ct: Data
    public let tag: Data    // 16B AES-GCM tag

    public init(v: Int, salt: Data, nonce: Data, ct: Data, tag: Data) {
        self.v = v
        self.salt = salt
        self.nonce = nonce
        self.ct = ct
        self.tag = tag
    }
}

public enum TWPushError: Error, Sendable {
    case unsupportedVersion(Int)
    case malformed
    case openFailed
}

public enum TWPushSeal {
    private static let agreementInfo = Data("taskwraith-push-agreement-v1".utf8)
    private static let aeadInfo = Data("taskwraith-push-v1 aead".utf8)
    private static let aadPrefix = "taskwraith-push-v1|"

    /// Derive the dedicated X25519 push-agreement private key from a 32-byte
    /// identity seed via HKDF. This is NOT an Ed25519->X25519 conversion — it's
    /// a separate, domain-separated key whose only input is the same secret
    /// seed. Matches `deriveAgreementKeyPair` on the Node side byte-for-byte.
    public static func agreementPrivateKey(fromSeed seed: Data) throws
        -> Curve25519.KeyAgreement.PrivateKey
    {
        let scalar = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: seed), salt: Data(),
            info: agreementInfo, outputByteCount: 32)
        return try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: scalar.withUnsafeBytes { Data($0) })
    }

    /// The raw 32-byte agreement public key the device publishes to its Mac once
    /// (over the live E2EE session, at APNs-token registration).
    public static func agreementPublicRaw(fromSeed seed: Data) throws -> Data {
        try agreementPrivateKey(fromSeed: seed).publicKey.rawRepresentation
    }

    /// Open an envelope the paired Mac sealed for this device. Throws on ANY
    /// failure — the NSE maps every throw to the generic fallback, never a
    /// partial / error notification.
    public static func open(
        envelope: PushEnvelope, deviceSeed: Data, senderAgreePubRaw: Data, pairId: String
    ) throws -> Data {
        guard envelope.v == 1 else { throw TWPushError.unsupportedVersion(envelope.v) }
        guard envelope.tag.count == 16, envelope.nonce.count == 12 else {
            throw TWPushError.malformed
        }
        let devPriv = try agreementPrivateKey(fromSeed: deviceSeed)
        let senderPub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: senderAgreePubRaw)
        let secret = try devPriv.sharedSecretFromKeyAgreement(with: senderPub)
        let ssData = secret.withUnsafeBytes { Data($0) }
        if ssData.allSatisfy({ $0 == 0 }) { throw TWPushError.openFailed }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ssData), salt: envelope.salt,
            info: aeadInfo, outputByteCount: 32)
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: envelope.nonce),
                ciphertext: envelope.ct, tag: envelope.tag)
            return try AES.GCM.open(
                box, using: key, authenticating: Data((aadPrefix + pairId).utf8))
        } catch {
            throw TWPushError.openFailed
        }
    }

    /// Parse the `twpush` object from an APNs payload's userInfo into an
    /// envelope. Returns nil on any shape mismatch (→ generic fallback).
    public static func parse(_ obj: [String: Any]) -> PushEnvelope? {
        guard let v = obj["v"] as? Int,
            let s = (obj["s"] as? String).flatMap({ Data(base64Encoded: $0) }),
            let n = (obj["n"] as? String).flatMap({ Data(base64Encoded: $0) }),
            let ct = (obj["ct"] as? String).flatMap({ Data(base64Encoded: $0) }),
            let tag = (obj["tag"] as? String).flatMap({ Data(base64Encoded: $0) })
        else { return nil }
        return PushEnvelope(v: v, salt: s, nonce: n, ct: ct, tag: tag)
    }
}
