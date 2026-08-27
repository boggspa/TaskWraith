import Foundation

// MARK: - Full-size media assembly (item 7 foundation)

/// Hard cap for a full-size image download. Matches `RemoteSessionModel.fetchThreadMedia`.
public enum FullSizeMediaLimits: Sendable {
    public static let maxBytes = 8 * 1024 * 1024
    /// Mac `threadMediaFetch` range slices are hard-clamped to 448 KiB.
    public static let chunkLength = 448 * 1024
}

public enum FullSizeMediaFetchError: Error, Equatable, Sendable {
    case empty
    case truncated(received: Int, expected: Int)
    case exceedsMaximum(received: Int, maximum: Int)
    case inconsistentTotal(previous: Int, next: Int)
    case invalidTotal(Int)
    case undecodableImage
}

/// Accumulates range-mode media slices into one bounded blob.
/// Empty or partial termination is a failure, never a completed image.
public struct FullSizeMediaAssembler: Sendable {
    public static let maxBytes = FullSizeMediaLimits.maxBytes
    public static let chunkLength = FullSizeMediaLimits.chunkLength

    private var buffer = Data()
    private var declaredTotal: Int?

    public init() {}

    public var receivedByteCount: Int { buffer.count }

    public var isComplete: Bool {
        guard let declaredTotal else { return false }
        return buffer.count == declaredTotal
    }

    public var needsMore: Bool { !isComplete }

    public mutating func append(chunk: Data, totalBytes: Int) throws {
        guard totalBytes > 0 else {
            throw FullSizeMediaFetchError.invalidTotal(totalBytes)
        }
        guard totalBytes <= Self.maxBytes else {
            throw FullSizeMediaFetchError.exceedsMaximum(
                received: totalBytes, maximum: Self.maxBytes)
        }
        if let declaredTotal {
            guard declaredTotal == totalBytes else {
                throw FullSizeMediaFetchError.inconsistentTotal(
                    previous: declaredTotal, next: totalBytes)
            }
        }
        guard !chunk.isEmpty else {
            throw FullSizeMediaFetchError.truncated(
                received: buffer.count, expected: totalBytes)
        }
        let remainingCap = Self.maxBytes - buffer.count
        guard chunk.count <= remainingCap else {
            throw FullSizeMediaFetchError.exceedsMaximum(
                received: buffer.count + chunk.count, maximum: Self.maxBytes)
        }
        let nextCount = buffer.count + chunk.count
        guard nextCount <= totalBytes else {
            throw FullSizeMediaFetchError.inconsistentTotal(
                previous: totalBytes, next: nextCount)
        }
        declaredTotal = totalBytes
        buffer.append(chunk)
    }

    public func finish() throws -> Data {
        guard let declaredTotal else {
            throw FullSizeMediaFetchError.empty
        }
        guard !buffer.isEmpty else {
            throw FullSizeMediaFetchError.empty
        }
        guard buffer.count == declaredTotal else {
            throw FullSizeMediaFetchError.truncated(
                received: buffer.count, expected: declaredTotal)
        }
        return buffer
    }
}

// MARK: - Markup coordinates

public enum MarkupValidationError: Error, Equatable, Sendable {
    case invalidThickness(Double)
    case emptyStroke
    case emptyAttachmentId
    case unsupportedSchemaVersion(Int)
}

/// A normalized, resolution-independent coordinate in the range 0.0 to 1.0.
/// Origin (0, 0) is the top-left of the image.
/// Decoding goes through the clamping init so Codable cannot bypass the invariant.
public struct NormalizedCoordinate: Codable, Sendable, Hashable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = Self.clampUnit(x)
        self.y = Self.clampUnit(y)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let x = try container.decode(Double.self, forKey: .x)
        let y = try container.decode(Double.self, forKey: .y)
        guard x.isFinite, y.isFinite else {
            throw DecodingError.dataCorruptedError(
                forKey: .x,
                in: container,
                debugDescription: "Coordinates must be finite")
        }
        self.init(x: x, y: y)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(x, forKey: .x)
        try container.encode(y, forKey: .y)
    }

    private enum CodingKeys: String, CodingKey {
        case x, y
    }

    private static func clampUnit(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(max(value, 0), 1)
    }
}

/// A color representation for markup elements. Components are clamped to 0...1.
public struct MarkupColor: Codable, Sendable, Hashable {
    public let r: Double
    public let g: Double
    public let b: Double
    public let a: Double

    public init(r: Double, g: Double, b: Double, a: Double = 1.0) {
        self.r = Self.clampUnit(r)
        self.g = Self.clampUnit(g)
        self.b = Self.clampUnit(b)
        self.a = Self.clampUnit(a)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let r = try container.decode(Double.self, forKey: .r)
        let g = try container.decode(Double.self, forKey: .g)
        let b = try container.decode(Double.self, forKey: .b)
        let a = try container.decodeIfPresent(Double.self, forKey: .a) ?? 1.0
        guard r.isFinite, g.isFinite, b.isFinite, a.isFinite else {
            throw DecodingError.dataCorruptedError(
                forKey: .r,
                in: container,
                debugDescription: "Color components must be finite")
        }
        self.init(r: r, g: g, b: b, a: a)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(r, forKey: .r)
        try container.encode(g, forKey: .g)
        try container.encode(b, forKey: .b)
        try container.encode(a, forKey: .a)
    }

    public static let red = MarkupColor(r: 1, g: 0, b: 0)
    public static let green = MarkupColor(r: 0, g: 1, b: 0)
    public static let blue = MarkupColor(r: 0, g: 0, b: 1)

    private enum CodingKeys: String, CodingKey {
        case r, g, b, a
    }

    private static func clampUnit(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        return min(max(value, 0), 1)
    }
}

/// Supported primitive types for image markup.
public enum MarkupPrimitive: Codable, Sendable, Hashable {
    public static let minThickness: Double = 0.25
    public static let maxThickness: Double = 64

    /// A continuous stroke, defined by a list of points.
    case stroke(points: [NormalizedCoordinate], color: MarkupColor, thickness: Double)
    /// A rectangle, defined by its top-left and bottom-right corners.
    case rect(start: NormalizedCoordinate, end: NormalizedCoordinate, color: MarkupColor, thickness: Double)
    /// An arrow, pointing from start to end.
    case arrow(start: NormalizedCoordinate, end: NormalizedCoordinate, color: MarkupColor, thickness: Double)

    public static func validatedThickness(_ value: Double) throws -> Double {
        guard value.isFinite, value >= minThickness, value <= maxThickness else {
            throw MarkupValidationError.invalidThickness(value)
        }
        return value
    }

    public func validate() throws {
        switch self {
        case .stroke(let points, _, let thickness):
            _ = try Self.validatedThickness(thickness)
            guard !points.isEmpty else { throw MarkupValidationError.emptyStroke }
        case .rect(_, _, _, let thickness), .arrow(_, _, _, let thickness):
            _ = try Self.validatedThickness(thickness)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, points, start, end, color, thickness
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let color = try container.decode(MarkupColor.self, forKey: .color)
        let rawThickness = try container.decode(Double.self, forKey: .thickness)
        let thickness: Double
        do {
            thickness = try Self.validatedThickness(rawThickness)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .thickness,
                in: container,
                debugDescription: "invalid thickness")
        }
        switch type {
        case "stroke":
            let points = try container.decode([NormalizedCoordinate].self, forKey: .points)
            guard !points.isEmpty else {
                throw DecodingError.dataCorruptedError(
                    forKey: .points,
                    in: container,
                    debugDescription: "stroke requires at least one point")
            }
            self = .stroke(points: points, color: color, thickness: thickness)
        case "rect":
            let start = try container.decode(NormalizedCoordinate.self, forKey: .start)
            let end = try container.decode(NormalizedCoordinate.self, forKey: .end)
            self = .rect(start: start, end: end, color: color, thickness: thickness)
        case "arrow":
            let start = try container.decode(NormalizedCoordinate.self, forKey: .start)
            let end = try container.decode(NormalizedCoordinate.self, forKey: .end)
            self = .arrow(start: start, end: end, color: color, thickness: thickness)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: container, debugDescription: "Unknown primitive type")
        }
    }

    public func encode(to encoder: Encoder) throws {
        try validate()
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .stroke(let points, let color, let thickness):
            try container.encode("stroke", forKey: .type)
            try container.encode(points, forKey: .points)
            try container.encode(color, forKey: .color)
            try container.encode(thickness, forKey: .thickness)
        case .rect(let start, let end, let color, let thickness):
            try container.encode("rect", forKey: .type)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
            try container.encode(color, forKey: .color)
            try container.encode(thickness, forKey: .thickness)
        case .arrow(let start, let end, let color, let thickness):
            try container.encode("arrow", forKey: .type)
            try container.encode(start, forKey: .start)
            try container.encode(end, forKey: .end)
            try container.encode(color, forKey: .color)
            try container.encode(thickness, forKey: .thickness)
        }
    }
}

/// Attachment-bound markup that crosses the phone/host boundary.
/// `schemaVersion` and `attachmentId` are required so later revisions can be versioned.
public struct MarkupPayload: Codable, Sendable, Hashable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let attachmentId: String
    public let primitives: [MarkupPrimitive]

    public init(
        attachmentId: String,
        primitives: [MarkupPrimitive],
        schemaVersion: Int = MarkupPayload.currentSchemaVersion
    ) throws {
        guard !attachmentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MarkupValidationError.emptyAttachmentId
        }
        guard schemaVersion == Self.currentSchemaVersion else {
            throw MarkupValidationError.unsupportedSchemaVersion(schemaVersion)
        }
        for primitive in primitives {
            try primitive.validate()
        }
        self.schemaVersion = schemaVersion
        self.attachmentId = attachmentId
        self.primitives = primitives
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == Self.currentSchemaVersion else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "unsupported schemaVersion \(schemaVersion)")
        }
        let attachmentId = try container.decode(String.self, forKey: .attachmentId)
        guard !attachmentId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .attachmentId,
                in: container,
                debugDescription: "attachmentId must be non-empty")
        }
        let primitives = try container.decode([MarkupPrimitive].self, forKey: .primitives)
        for primitive in primitives {
            try primitive.validate()
        }
        self.schemaVersion = schemaVersion
        self.attachmentId = attachmentId
        self.primitives = primitives
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(attachmentId, forKey: .attachmentId)
        try container.encode(primitives, forKey: .primitives)
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, attachmentId, primitives
    }
}
