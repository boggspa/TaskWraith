// taskwraith-e2ee-v1 — AES-256-GCM seal/open (Swift port of
// src/shared/e2ee/cipher.ts). 12-byte nonce = 4B BE direction prefix ‖ 8B BE
// seq; AAD = "sessionId:seq". CryptoKit's default GCM tag is 128-bit, matching
// Node's getAuthTag().

import Foundation
import CryptoKit

public struct SealedFrame: Sendable {
    public var nonce: Data
    public var ct: Data
    public var tag: Data
}

public enum TWCipher {
    public enum CipherError: Error, Equatable {
        case invalidSequence, invalidKeySize, nonceMismatch, badTagLength, openFailed
    }

    public static let maxWireSequence = 9_007_199_254_740_991

    private static func validateSequence(_ seq: Int) throws -> UInt64 {
        guard seq >= 0, seq <= maxWireSequence else { throw CipherError.invalidSequence }
        return UInt64(seq)
    }

    private static func validateAes256Key(_ key: SymmetricKey) throws {
        guard key.bitCount == 256 else { throw CipherError.invalidKeySize }
    }

    public static func buildNonce(_ direction: Direction, _ seq: Int) throws -> Data {
        let seqValue = try validateSequence(seq)
        var nonce = Data(count: 12)
        let prefix = direction.noncePrefix.bigEndian
        withUnsafeBytes(of: prefix) { nonce.replaceSubrange(0..<4, with: $0) }
        let seqBE = seqValue.bigEndian
        withUnsafeBytes(of: seqBE) { nonce.replaceSubrange(4..<12, with: $0) }
        return nonce
    }

    public static func buildAad(_ sessionId: String, _ seq: Int) throws -> Data {
        _ = try validateSequence(seq)
        return Data("\(sessionId):\(seq)".utf8)
    }

    public static func seal(
        key: SymmetricKey, direction: Direction, sessionId: String, seq: Int, plaintext: Data
    ) throws -> SealedFrame {
        try validateAes256Key(key)
        let nonce = try buildNonce(direction, seq)
        let sealedBox = try AES.GCM.seal(
            plaintext, using: key, nonce: AES.GCM.Nonce(data: nonce),
            authenticating: try buildAad(sessionId, seq))
        return SealedFrame(nonce: nonce, ct: sealedBox.ciphertext, tag: sealedBox.tag)
    }

    public static func open(
        key: SymmetricKey, direction: Direction, sessionId: String, seq: Int, frame: SealedFrame
    ) throws -> Data {
        try validateAes256Key(key)
        let expected = try buildNonce(direction, seq)
        guard frame.nonce == expected else { throw CipherError.nonceMismatch }
        guard frame.tag.count == 16 else { throw CipherError.badTagLength }
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: expected), ciphertext: frame.ct, tag: frame.tag)
            return try AES.GCM.open(box, using: key, authenticating: try buildAad(sessionId, seq))
        } catch {
            throw CipherError.openFailed
        }
    }
}
