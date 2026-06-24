// Cross-impl with src/shared/e2ee/pushSeal.test.ts — the SAME deterministic
// vector (macSeed=0x11*32, deviceSeed=0x22*32, salt=0x33*24, nonce=0x44*12)
// proves Node-seal == Swift-open, including the empty-salt HKDF + X25519
// derivation agreeing across Node `crypto` and CryptoKit.

import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Push envelope (cross-impl with pushSeal.ts)")
struct PushSealTests {
    let macSeed = Data(repeating: 0x11, count: 32)
    let deviceSeed = Data(repeating: 0x22, count: 32)
    let pairId = "iphone-deadbeefcafe0001"
    let macAgreePubB64 = "i/Qc4tBuMe7vbrJm/d1Yolgav+fosm0AH1/AzFo3gzo="
    let deviceAgreePubB64 = "pYM/oH/HIoY+iuQOxH3DC9L9u+XJoY1Wn9FHqc/TBi8="
    let ctB64 = "Hdt+wOMmBetV7rgtUpqHrpGcxnFHS1OZlnP94dyveJWUAhP4DTmKZTlV12Q="
    let tagB64 = "BKS3ITwl8IlcEpzpF0ZOtg=="
    let expectedPlaintext = "{\"t\":\"Codex finished\",\"b\":\"3 files changed\"}"

    private func vectorEnvelope(ct: String? = nil) -> PushEnvelope {
        PushEnvelope(
            v: 1,
            salt: Data(repeating: 0x33, count: 24),
            nonce: Data(repeating: 0x44, count: 12),
            ct: Data(base64Encoded: ct ?? ctB64)!,
            tag: Data(base64Encoded: tagB64)!)
    }

    @Test("agreement public keys match the Node vector (empty-salt HKDF + X25519 parity)")
    func agreementParity() throws {
        #expect(try TWPushSeal.agreementPublicRaw(fromSeed: macSeed).base64EncodedString() == macAgreePubB64)
        #expect(
            try TWPushSeal.agreementPublicRaw(fromSeed: deviceSeed).base64EncodedString()
                == deviceAgreePubB64)
    }

    @Test("opens the Node-sealed cross-impl vector")
    func opensNodeVector() throws {
        let plaintext = try TWPushSeal.open(
            envelope: vectorEnvelope(),
            deviceSeed: deviceSeed,
            senderAgreePubRaw: Data(base64Encoded: macAgreePubB64)!,
            pairId: pairId)
        #expect(String(data: plaintext, encoding: .utf8) == expectedPlaintext)
    }

    @Test("rejects a tampered ciphertext (GCM tag)")
    func rejectsTamper() throws {
        var ct = Data(base64Encoded: ctB64)!
        ct[0] ^= 0xFF
        #expect(throws: (any Error).self) {
            try TWPushSeal.open(
                envelope: vectorEnvelope(ct: ct.base64EncodedString()),
                deviceSeed: deviceSeed,
                senderAgreePubRaw: Data(base64Encoded: macAgreePubB64)!,
                pairId: pairId)
        }
    }

    @Test("rejects a blob delivered to the wrong pairing (AAD binds pairId)")
    func rejectsWrongPairing() throws {
        #expect(throws: (any Error).self) {
            try TWPushSeal.open(
                envelope: vectorEnvelope(),
                deviceSeed: deviceSeed,
                senderAgreePubRaw: Data(base64Encoded: macAgreePubB64)!,
                pairId: "iphone-someotherpairing")
        }
    }

    @Test("rejects an envelope from an unpaired sender (wrong agreement key)")
    func rejectsUnpairedSender() throws {
        let stranger = try TWPushSeal.agreementPublicRaw(fromSeed: Data(repeating: 0x99, count: 32))
        #expect(throws: (any Error).self) {
            try TWPushSeal.open(
                envelope: vectorEnvelope(),
                deviceSeed: deviceSeed,
                senderAgreePubRaw: stranger,
                pairId: pairId)
        }
    }

    @Test("parse() round-trips the twpush JSON object shape")
    func parseShape() throws {
        let obj: [String: Any] = ["v": 1, "s": "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMz", "n": "RERERERERERERERE", "ct": ctB64, "tag": tagB64]
        let env = try #require(TWPushSeal.parse(obj))
        #expect(env.v == 1)
        #expect(env.salt.count == 24)
        #expect(env.nonce.count == 12)
        #expect(TWPushSeal.parse(["v": 1]) == nil)
    }
}
