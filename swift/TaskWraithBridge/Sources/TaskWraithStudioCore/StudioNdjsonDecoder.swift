import Foundation

public enum StudioErrorCode: String, Codable {
    case parseError = "parse_error"
    case invalidRequest = "invalid_request"
    case methodNotFound = "method_not_found"
    case invalidParams = "invalid_params"
    case staleBase = "stale_base"
    case invalidOp = "invalid_op"
    case insertionInsideItem = "insertion_inside_item"
    case duplicateItem = "duplicate_item"
    case unrepresentableTime = "unrepresentable_time"
    case misalignedTime = "misaligned_time"
    case unsupportedProtocolVersion = "unsupported_protocol_version"
    case storeFailure = "store_failure"
}

public actor StudioErrorCodeProvider {
    public static let shared = StudioErrorCodeProvider()
    
    private let errorNumbers: [StudioErrorCode: Int] = [
        .parseError: -32700,
        .invalidRequest: -32600,
        .methodNotFound: -32601,
        .invalidParams: -32602,
        .staleBase: 4001,  // Normative spec: StudioProtocol.ts
        .invalidOp: 4002,
        .insertionInsideItem: 4003,
        .duplicateItem: 4004,
        .unrepresentableTime: 4005,
        .misalignedTime: 4006,
        .unsupportedProtocolVersion: 4007,
        .storeFailure: 4008
    ]
    
    public func errorNumber(for code: StudioErrorCode) -> Int {
        return errorNumbers[code] ?? -32000
    }
}

public struct StudioMessage: Codable {
    public let jsonrpc: String
    public let id: Int?
    public let method: String?
    public let params: [String: AnyCodable]?
    public let result: AnyCodable?
    public let error: StudioErrorPayload?
}

public struct StudioErrorPayload: Codable {
    public let code: Int
    public let message: String
    public let data: [String: AnyCodable]?
}

public enum StudioDecodeEvent {
    case message(StudioMessage)
    case decodeError(code: String, message: String)
}

public class StudioNdjsonDecoder {
    private var buffer = Data()
    private let maxLineBytes: Int
    private var skippingOversizedLine = false

    public init(maxLineBytes: Int = 4 * 1024 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    public func push(chunk: Data) -> [StudioDecodeEvent] {
        buffer.append(chunk)
        var events: [StudioDecodeEvent] = []
        while let lineEnd = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: 0..<lineEnd)
            buffer.removeSubrange(0...lineEnd)
            if skippingOversizedLine {
                skippingOversizedLine = false
                continue
            }
            if let event = decodeLine(lineData) {
                events.append(event)
            }
        }
        if !skippingOversizedLine && buffer.count > maxLineBytes {
            skippingOversizedLine = true
            buffer.removeAll()
            events.append(.decodeError(
                code: "line_too_long",
                message: "NDJSON line exceeded \(maxLineBytes) bytes without a line feed"
            ))
        }
        return events
    }

    private func decodeLine(_ lineData: Data) -> StudioDecodeEvent? {
        if lineData.count > maxLineBytes {
            return .decodeError(
                code: "line_too_long",
                message: "NDJSON line of \(lineData.count) bytes exceeds the \(maxLineBytes)-byte limit"
            )
        }
        var text = String(data: lineData, encoding: .utf8) ?? ""
        if text.last == "\r" {
            text.removeLast()
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        do {
            let message = try JSONDecoder().decode(StudioMessage.self, from: Data(text.utf8))
            return .message(message)
        } catch {
            return .decodeError(code: "parse_error", message: "invalid NDJSON line: \(error.localizedDescription)")
        }
    }
}

// MARK: - AnyCodable (for dynamic JSON params/result)
public struct AnyCodable: Codable {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            self.init(string)
        } else if let int = try? container.decode(Int.self) {
            self.init(int)
        } else if let double = try? container.decode(Double.self) {
            self.init(double)
        } else if let bool = try? container.decode(Bool.self) {
            self.init(bool)
        } else if let array = try? container.decode([AnyCodable].self) {
            self.init(array.map { $0.value })
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            self.init(dict.mapValues { $0.value })
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "AnyCodable value cannot be decoded"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let string as String:
            try container.encode(string)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let bool as Bool:
            try container.encode(bool)
        case let array as [Any]:
            try container.encode(array.map { AnyCodable($0) })
        case let dict as [String: Any]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "AnyCodable value cannot be encoded"
                )
            )
        }
    }
}