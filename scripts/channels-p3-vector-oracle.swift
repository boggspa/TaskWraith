#!/usr/bin/env swift

import CoreFoundation
import CryptoKit
import Darwin
import Foundation

enum OracleError: Error, CustomStringConvertible {
    case invalid(String)

    var description: String {
        switch self {
        case .invalid(let message):
            return message
        }
    }
}

func requireDictionary(_ value: Any, _ label: String) throws -> [String: Any] {
    guard let dictionary = value as? [String: Any] else {
        throw OracleError.invalid("\(label) must be an object")
    }
    return dictionary
}

func requireArray(_ value: Any?, _ label: String) throws -> [Any] {
    guard let array = value as? [Any] else {
        throw OracleError.invalid("\(label) must be an array")
    }
    return array
}

func requireString(_ value: Any?, _ label: String) throws -> String {
    guard let string = value as? String else {
        throw OracleError.invalid("\(label) must be a string")
    }
    return string
}

func jsonString(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
        switch scalar.value {
        case 0x08:
            result += "\\b"
        case 0x09:
            result += "\\t"
        case 0x0a:
            result += "\\n"
        case 0x0c:
            result += "\\f"
        case 0x0d:
            result += "\\r"
        case 0x22:
            result += "\\\""
        case 0x5c:
            result += "\\\\"
        case 0x00 ... 0x1f:
            result += String(format: "\\u%04x", scalar.value)
        default:
            result.unicodeScalars.append(scalar)
        }
    }
    return result + "\""
}

func canonicalJSON(_ value: Any) throws -> String {
    if value is NSNull {
        return "null"
    }
    if let string = value as? String {
        return jsonString(string)
    }
    if let number = value as? NSNumber {
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return number.boolValue ? "true" : "false"
        }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite,
              doubleValue.rounded(.towardZero) == doubleValue,
              abs(doubleValue) <= 9_007_199_254_740_991
        else {
            throw OracleError.invalid("canonical number is not a safe integer")
        }
        return number.stringValue
    }
    if let array = value as? [Any] {
        return "[" + (try array.map(canonicalJSON)).joined(separator: ",") + "]"
    }
    if let dictionary = value as? [String: Any] {
        let fields = try dictionary.keys.sorted().map { key in
            guard let field = dictionary[key] else {
                throw OracleError.invalid("canonical object field is missing")
            }
            return jsonString(key) + ":" + (try canonicalJSON(field))
        }
        return "{" + fields.joined(separator: ",") + "}"
    }
    throw OracleError.invalid("canonical value is not JSON")
}

func strictBase64(_ value: String, bytes: Int) -> Data? {
    guard !value.isEmpty,
          let decoded = Data(base64Encoded: value, options: []),
          decoded.count == bytes,
          decoded.base64EncodedString() == value
    else {
        return nil
    }
    return decoded
}

func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func statement(domain: String, value: Any) throws -> Data {
    Data((domain + "\n" + (try canonicalJSON(value))).utf8)
}

func parseWireJSON(_ value: String) throws -> Any {
    guard let data = value.data(using: .utf8) else {
        throw OracleError.invalid("wire JSON is not UTF-8")
    }
    return try JSONSerialization.jsonObject(with: data)
}

func run() throws -> [String: Any] {
    guard CommandLine.arguments.count == 2 else {
        throw OracleError.invalid("usage: channels-p3-vector-oracle.swift <vectors.json>")
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let root = try requireDictionary(try JSONSerialization.jsonObject(with: data), "fixture")
    guard (root["schemaVersion"] as? NSNumber)?.intValue == 1 else {
        throw OracleError.invalid("fixture schema is unsupported")
    }

    let ownerPublic = try requireString(root["ownerPublicKeyB64"], "owner public key")
    let agentPublic = try requireString(root["agentPublicKeyB64"], "agent public key")
    guard let ownerRaw = strictBase64(ownerPublic, bytes: 32),
          let agentRaw = strictBase64(agentPublic, bytes: 32)
    else {
        throw OracleError.invalid("fixture public key is not canonical base64")
    }
    let publicKeys = [
        "owner": try Curve25519.Signing.PublicKey(rawRepresentation: ownerRaw),
        "agent": try Curve25519.Signing.PublicKey(rawRepresentation: agentRaw)
    ]

    let vectors = try requireArray(root["vectors"], "vectors")
    var vectorResults: [[String: Any]] = []
    for (index, rawVector) in vectors.enumerated() {
        let vector = try requireDictionary(rawVector, "vector \(index)")
        let label = try requireString(vector["label"], "vector label")
        let domain = try requireString(vector["domain"], "vector domain")
        let signer = try requireString(vector["signer"], "vector signer")
        let expectedCanonical = try requireString(
            vector["expectedCanonicalJson"],
            "expected canonical JSON"
        )
        let expectedSha256 = try requireString(vector["expectedSha256"], "expected SHA-256")
        let signatureB64 = try requireString(vector["signatureB64"], "signature")
        guard let value = vector["value"] else {
            throw OracleError.invalid("vector value is missing")
        }
        let actualCanonical = try canonicalJSON(value)
        guard actualCanonical == expectedCanonical else {
            throw OracleError.invalid("\(label) canonical bytes differ")
        }
        let signed = try statement(domain: domain, value: value)
        let digest = sha256Hex(signed)
        guard digest == expectedSha256 else {
            throw OracleError.invalid("\(label) SHA-256 differs")
        }
        guard let signature = strictBase64(signatureB64, bytes: 64),
              let publicKey = publicKeys[signer],
              publicKey.isValidSignature(signature, for: signed)
        else {
            throw OracleError.invalid("\(label) Ed25519 signature is invalid")
        }
        vectorResults.append([
            "label": label,
            "sha256": digest,
            "signatureVerified": true
        ])
    }

    let objectOrder = try requireDictionary(root["objectOrderWirePair"] as Any, "object order")
    let orderDomain = try requireString(objectOrder["domain"], "object-order domain")
    let first = try parseWireJSON(try requireString(objectOrder["first"], "first wire JSON"))
    let second = try parseWireJSON(try requireString(objectOrder["second"], "second wire JSON"))
    let firstStatement = try statement(domain: orderDomain, value: first)
    let secondStatement = try statement(domain: orderDomain, value: second)
    let orderDigest = try requireString(objectOrder["expectedSha256"], "object-order SHA-256")
    guard firstStatement == secondStatement, sha256Hex(firstStatement) == orderDigest else {
        throw OracleError.invalid("object key order changed canonical bytes")
    }

    let arrayOrder = try requireDictionary(root["arrayOrderMutation"] as Any, "array order")
    let arrayDomain = try requireString(arrayOrder["domain"], "array-order domain")
    guard let arrayValue = arrayOrder["value"] else {
        throw OracleError.invalid("array-order value is missing")
    }
    let arrayDigest = sha256Hex(try statement(domain: arrayDomain, value: arrayValue))
    let expectedArrayDigest = try requireString(
        arrayOrder["expectedSha256"],
        "array-order SHA-256"
    )
    guard arrayDigest == expectedArrayDigest, arrayDigest != orderDigest else {
        throw OracleError.invalid("array order was not preserved")
    }

    let invalidBase64 = try requireArray(root["invalidBase64"], "invalid base64")
    for (index, rawValue) in invalidBase64.enumerated() {
        let value = try requireString(rawValue, "invalid base64 \(index)")
        guard strictBase64(value, bytes: 32) == nil else {
            throw OracleError.invalid("invalid base64 \(index) was accepted")
        }
    }

    return [
        "schemaVersion": 1,
        "language": "swift",
        "vectorCount": vectorResults.count,
        "vectors": vectorResults,
        "objectOrderIndependent": true,
        "arrayOrderPreserved": true,
        "invalidBase64Rejected": invalidBase64.count
    ]
}

do {
    let result = try run()
    let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data(("Channels P3 Swift oracle failed: \(error)\n").utf8))
    exit(1)
}
