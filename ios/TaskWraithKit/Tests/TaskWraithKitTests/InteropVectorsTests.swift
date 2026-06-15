// Cross-implementation interop vectors — the contract that keeps the CryptoKit
// port byte-identical to the Node lib. Every expected constant here is also
// asserted by src/shared/e2ee/crossImplVectors.test.ts from the SAME fixed
// inputs. If either side drifts, one of the two suites fails.

import Foundation
import CryptoKit
import Testing

@testable import TaskWraithKit

private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
private func fromHex(_ s: String) -> Data {
    var data = Data(capacity: s.count / 2)
    var idx = s.startIndex
    while idx < s.endIndex {
        let next = s.index(idx, offsetBy: 2)
        data.append(UInt8(s[idx..<next], radix: 16)!)
        idx = next
    }
    return data
}
private func fill(_ byte: UInt8, _ count: Int = 32) -> Data { Data(repeating: byte, count: count) }
private func captureCipherError(_ operation: () throws -> Void) -> TWCipher.CipherError? {
    do {
        try operation()
        #expect(Bool(false))
    } catch let error as TWCipher.CipherError {
        return error
    } catch {
        #expect(Bool(false))
    }
    return nil
}

private let sessionId = "vector-session"
private let macEph = try! TWKeys.ephemeral(fromSeed: fill(0x11))
private let iphoneEph = try! TWKeys.ephemeral(fromSeed: fill(0x22))
private let macId = try! TWKeys.identity(fromSeed: fill(0x33))
private let iphoneId = try! TWKeys.identity(fromSeed: fill(0x44))
private let clientNonce = fill(0xAA, 16)
private let serverNonce = fill(0xBB, 16)

@Suite("cross-impl interop vectors")
struct InteropVectorsTests {
    @Test("raw public keys derive from the fixed seeds")
    func publicKeys() {
        #expect(hex(macEph.publicKey.rawRepresentation)
            == "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13")
        #expect(hex(iphoneEph.publicKey.rawRepresentation)
            == "0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20")
        #expect(hex(macId.publicKey.rawRepresentation)
            == "17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce")
        #expect(hex(iphoneId.publicKey.rawRepresentation)
            == "d759793bbc13a2819a827c76adb6fba8a49aee007f49f2d0992d99b825ad2c48")
    }

    private func transcript() -> Data {
        TWKeySchedule.transcriptHash(
            TranscriptInputs(
                sessionId: sessionId,
                clientEphemeralPubKeyB64: Base64.encode(iphoneEph.publicKey.rawRepresentation),
                serverEphemeralPubKeyB64: Base64.encode(macEph.publicKey.rawRepresentation),
                clientNonceB64: Base64.encode(clientNonce),
                serverNonceB64: Base64.encode(serverNonce),
                macIdentityPubKeyB64: Base64.encode(macId.publicKey.rawRepresentation),
                iphoneIdentityPubKeyB64: Base64.encode(iphoneId.publicKey.rawRepresentation)))
    }

    @Test("transcript hash + confirm code")
    func transcriptAndCode() {
        let t = transcript()
        #expect(hex(t) == "9b9764575b8a73a88377d24588d88331e84bc7969972b2a50019fe1c0fdb264f")
        #expect(TWKeySchedule.confirmCode(t) == "390103")
    }

    @Test("X25519 shared secret agrees both directions")
    func sharedSecret() throws {
        let a = try TWKeys.sharedSecret(macEph, iphoneEph.publicKey)
        let b = try TWKeys.sharedSecret(iphoneEph, macEph.publicKey)
        #expect(a == b)
        #expect(hex(a) == "9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056")
    }

    @Test("HKDF directional session keys")
    func sessionKeys() throws {
        let ikm = try TWKeys.sharedSecret(macEph, iphoneEph.publicKey)
        let keys = TWKeySchedule.deriveSessionKeys(
            ikm: ikm, clientNonce: clientNonce, serverNonce: serverNonce)
        let m2i = keys.macToIphone.withUnsafeBytes { Data($0) }
        let i2m = keys.iphoneToMac.withUnsafeBytes { Data($0) }
        #expect(hex(m2i) == "c328ecb05aed3e0c14dc8b25c0f2a4abf4300495c6a158f586d0833bd0b30a0c")
        #expect(hex(i2m) == "9a72c741f010d393760f6fab2eb408d047e8014d0d5bda52c50ffb2171a863f0")
    }

    @Test("AES-256-GCM seal matches the golden nonce/ct/tag and opens back")
    func sealOpen() throws {
        let key = SymmetricKey(
            data: fromHex("c328ecb05aed3e0c14dc8b25c0f2a4abf4300495c6a158f586d0833bd0b30a0c"))
        let plaintext = Data(#"{"msgId":1,"method":"bridge.runEvent","params":{"n":42}}"#.utf8)
        let sealed = try TWCipher.seal(
            key: key, direction: .macToIphone, sessionId: sessionId, seq: 0, plaintext: plaintext)
        #expect(hex(sealed.nonce) == "000000010000000000000000")
        #expect(hex(sealed.ct)
            == "9eaacd940b78937c9689aa5b22b9d8151f7da06583bb95e9b4f72329fe2ac832066a363840346e697e774e5bbea2ddaa4d5512d17ed28f6d")
        #expect(hex(sealed.tag) == "e02aef7c8b154d6fce01878e3e6d649d")
        let opened = try TWCipher.open(
            key: key, direction: .macToIphone, sessionId: sessionId, seq: 0, frame: sealed)
        #expect(opened == plaintext)
    }

    @Test("AES-GCM nonce vectors cover both directions and wire sequence bounds")
    func nonceVectors() throws {
        #expect(hex(try TWCipher.buildNonce(.macToIphone, 0)) == "000000010000000000000000")
        #expect(hex(try TWCipher.buildNonce(.iphoneToMac, 5)) == "000000020000000000000005")
        #expect(hex(try TWCipher.buildNonce(.macToIphone, TWCipher.maxWireSequence))
            == "00000001001fffffffffffff")
        #expect(captureCipherError {
            _ = try TWCipher.buildNonce(.iphoneToMac, TWCipher.maxWireSequence + 1)
        } == .invalidSequence)
    }

    @Test("cipher rejects invalid sequence values without trapping")
    func invalidSequenceRejected() throws {
        let key = SymmetricKey(
            data: fromHex("c328ecb05aed3e0c14dc8b25c0f2a4abf4300495c6a158f586d0833bd0b30a0c"))
        let frame = SealedFrame(
            nonce: Data(repeating: 0, count: 12), ct: Data(), tag: Data(repeating: 0, count: 16))

        #expect(captureCipherError {
            _ = try TWCipher.buildNonce(.iphoneToMac, -1)
        } == .invalidSequence)
        #expect(captureCipherError {
            _ = try TWCipher.buildAad(sessionId, -1)
        } == .invalidSequence)
        #expect(captureCipherError {
            _ = try TWCipher.seal(
                key: key, direction: .iphoneToMac, sessionId: sessionId, seq: -1,
                plaintext: Data())
        } == .invalidSequence)
        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key, direction: .iphoneToMac, sessionId: sessionId, seq: -1, frame: frame)
        } == .invalidSequence)
    }

    @Test("cipher enforces AES-256 keys")
    func rejectsNonAes256Keys() throws {
        let key128 = SymmetricKey(data: Data(repeating: 0x11, count: 16))
        let key192 = SymmetricKey(data: Data(repeating: 0x22, count: 24))
        let frame = SealedFrame(
            nonce: try TWCipher.buildNonce(.macToIphone, 0), ct: Data(),
            tag: Data(repeating: 0, count: 16))

        #expect(captureCipherError {
            _ = try TWCipher.seal(
                key: key128, direction: .macToIphone, sessionId: sessionId, seq: 0,
                plaintext: Data())
        } == .invalidKeySize)
        #expect(captureCipherError {
            _ = try TWCipher.seal(
                key: key192, direction: .macToIphone, sessionId: sessionId, seq: 0,
                plaintext: Data())
        } == .invalidKeySize)
        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key128, direction: .macToIphone, sessionId: sessionId, seq: 0, frame: frame)
        } == .invalidKeySize)
        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key192, direction: .macToIphone, sessionId: sessionId, seq: 0, frame: frame)
        } == .invalidKeySize)
    }

    @Test("open maps authentication failures to openFailed")
    func openFailedMapping() throws {
        let key = SymmetricKey(
            data: fromHex("c328ecb05aed3e0c14dc8b25c0f2a4abf4300495c6a158f586d0833bd0b30a0c"))
        let wrongKey = SymmetricKey(data: Data(repeating: 0x55, count: 32))
        let plaintext = Data(#"{"msgId":1,"method":"bridge.runEvent","params":{"n":42}}"#.utf8)
        let sealed = try TWCipher.seal(
            key: key, direction: .macToIphone, sessionId: sessionId, seq: 0, plaintext: plaintext)

        var tamperedCt = sealed.ct
        tamperedCt[tamperedCt.startIndex] ^= 0x01
        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key, direction: .macToIphone, sessionId: sessionId, seq: 0,
                frame: SealedFrame(nonce: sealed.nonce, ct: tamperedCt, tag: sealed.tag))
        } == .openFailed)

        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key, direction: .macToIphone, sessionId: "wrong-session", seq: 0,
                frame: sealed)
        } == .openFailed)
        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: wrongKey, direction: .macToIphone, sessionId: sessionId, seq: 0,
                frame: sealed)
        } == .openFailed)
    }

    @Test("open preserves local validation errors")
    func openLocalValidationErrors() throws {
        let key = SymmetricKey(
            data: fromHex("c328ecb05aed3e0c14dc8b25c0f2a4abf4300495c6a158f586d0833bd0b30a0c"))
        let plaintext = Data(#"{"msgId":1,"method":"bridge.runEvent","params":{"n":42}}"#.utf8)
        let sealed = try TWCipher.seal(
            key: key, direction: .macToIphone, sessionId: sessionId, seq: 0, plaintext: plaintext)

        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key, direction: .macToIphone, sessionId: sessionId, seq: 0,
                frame: SealedFrame(
                    nonce: try TWCipher.buildNonce(.macToIphone, 1), ct: sealed.ct,
                    tag: sealed.tag))
        } == .nonceMismatch)
        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key, direction: .macToIphone, sessionId: sessionId, seq: 0,
                frame: SealedFrame(
                    nonce: sealed.nonce, ct: sealed.ct, tag: Data(sealed.tag.dropLast())))
        } == .badTagLength)

        var longTag = sealed.tag
        longTag.append(0)
        #expect(captureCipherError {
            _ = try TWCipher.open(
                key: key, direction: .macToIphone, sessionId: sessionId, seq: 0,
                frame: SealedFrame(nonce: sealed.nonce, ct: sealed.ct, tag: longTag))
        } == .badTagLength)
    }

    @Test("Ed25519 cross-verification: a Node signature verifies under CryptoKit")
    func signature() throws {
        // NOTE: CryptoKit's Ed25519 signing is RANDOMIZED (hedged against fault
        // attacks), whereas Node's `crypto.sign(null, ...)` is deterministic per
        // RFC 8032 — so the two produce DIFFERENT signature bytes for the same
        // key+message. Both are valid: the protocol only ever verifies, never
        // compares signature bytes. The real interop property is cross-
        // verification, asserted here (Node→iOS) and exercised live in T4d
        // (iOS→Node, via the Mac verifying the phone's clientAuth).
        let t = transcript()

        // (1) A signature produced by the NODE lib over this transcript (the
        // golden vector) verifies under the CryptoKit-imported public key.
        let nodeSig = fromHex(
            "7e293c15123713d7392c0e4902313b51aca0d7fb5bb37cee64ac7e76d1e556cf5e6067f5c380ddd7600a5e7bc44a40ebc5db72d0a5fe838d9997d3f2e5635708")
        #expect(TWKeys.verify(nodeSig, of: t, with: macId.publicKey))

        // (2) A fresh CryptoKit signature round-trips (and, being randomized,
        // is expected NOT to equal the Node bytes).
        let swiftSig = try TWKeys.sign(t, with: macId)
        #expect(TWKeys.verify(swiftSig, of: t, with: macId.publicKey))
        #expect(swiftSig != nodeSig)
    }

    @Test("resolve signing strings are byte-stable")
    func resolveStrings() {
        let macKey = Base64.encode(macId.publicKey.rawRepresentation)
        let phoneKey = Base64.encode(iphoneId.publicKey.rawRepresentation)
        #expect(
            TWResolve.registerSigningString(
                macIdentityPubKey: macKey, sessionId: sessionId, allowedPeers: [phoneKey],
                issuedAt: 1_700_000_000_000, ttlMs: 3_600_000)
                == "taskwraith-resolve-v1|register|F8t5+ytBIPKx7GXkGY1uCLKOgT/rAeSkAIObheGAgM4=|vector-session|11l5O7wTooGagnx2rbb7qKSa7gB/SfLQmS2ZuCWtLEg=|1700000000000|3600000")
        #expect(
            TWResolve.resolveSigningString(
                macIdentityPubKey: macKey, iphoneIdentityPubKey: phoneKey,
                nonce: Base64.encode(fill(0xCC, 16)), issuedAt: 1_700_000_000_000)
                == "taskwraith-resolve-v1|resolve|F8t5+ytBIPKx7GXkGY1uCLKOgT/rAeSkAIObheGAgM4=|11l5O7wTooGagnx2rbb7qKSa7gB/SfLQmS2ZuCWtLEg=|zMzMzMzMzMzMzMzMzMzMzA==|1700000000000")
    }
}
