import Foundation
#if canImport(CoreGraphics)
    import CoreGraphics
#endif
#if canImport(ImageIO)
    import ImageIO
#endif

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
    case emptyCoordinateSpace
    case tooManyPrimitives(count: Int, maximum: Int)
    case tooManyStrokePoints(count: Int, maximum: Int)
    case markupTooLarge(bytes: Int, maximum: Int)
}

public enum MarkupFlattenError: Error, Equatable, Sendable {
    case undecodableImage
    case exceedsMaximum(received: Int, maximum: Int)
    case rasterExceedsMaximum(
        width: Int, height: Int, maximumDimension: Int, maximumPixels: Int)
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
            guard points.count <= MarkupPayload.maxStrokePoints else {
                throw MarkupValidationError.tooManyStrokePoints(
                    count: points.count, maximum: MarkupPayload.maxStrokePoints)
            }
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
    /// Wire bound for markup metadata riding an image attachment. An unbounded
    /// blob is a denial-of-service shape; 16 KiB holds 32 arrows or a dense
    /// stroke. Primitive count matches the host trust-boundary validator
    /// (`MAX_REMOTE_IMAGE_MARKUP_PRIMITIVES = 32`); the client must never
    /// accept what the host will reject.
    public static let maxEncodedBytes = 16 * 1024
    public static let maxPrimitives = 32
    public static let maxStrokePoints = 256

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
        try Self.enforceCounts(primitives)
        self.schemaVersion = schemaVersion
        self.attachmentId = attachmentId
        self.primitives = primitives
        try enforceEncodedSize()
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
        do {
            try Self.enforceCounts(primitives)
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .primitives,
                in: container,
                debugDescription: "markup exceeds bounded primitive counts")
        }
        self.schemaVersion = schemaVersion
        self.attachmentId = attachmentId
        self.primitives = primitives
        do {
            try enforceEncodedSize()
        } catch {
            throw DecodingError.dataCorruptedError(
                forKey: .primitives,
                in: container,
                debugDescription: "markup exceeds \(Self.maxEncodedBytes) encoded bytes")
        }
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

    public static func enforceCounts(_ primitives: [MarkupPrimitive]) throws {
        guard primitives.count <= maxPrimitives else {
            throw MarkupValidationError.tooManyPrimitives(
                count: primitives.count, maximum: maxPrimitives)
        }
        for primitive in primitives {
            try primitive.validate()
        }
    }

    public func encodedJSONData() throws -> Data {
        try JSONEncoder().encode(self)
    }

    fileprivate func enforceEncodedSize() throws {
        let data = try encodedJSONData()
        guard data.count <= Self.maxEncodedBytes else {
            throw MarkupValidationError.markupTooLarge(
                bytes: data.count, maximum: Self.maxEncodedBytes)
        }
    }
}

// MARK: - View / pixel / normalized coordinate space

/// A point in a 2D plane. Doubles rather than CoreGraphics so the mapping
/// is unit-testable on the macOS `swift test` build without UIKit.
public struct MarkupPoint: Sendable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct MarkupRect: Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var isEmpty: Bool { width <= 0 || height <= 0 }
}

/// Maps between three coordinate spaces that this feature keeps mixing up
/// at its boundary:
/// - **view**: the annotating control's bounds (gesture location)
/// - **fitted image**: the aspect-fit rectangle of the bitmap inside the view
/// - **pixels**: the bitmap's own width/height
///
/// Normalized coordinates (0...1) are relative to the *image*, not the view.
/// A letterboxed tap outside the fitted rect clamps onto the image edge.
/// Changing the view size must not change a stored normalized coordinate.
public struct MarkupCoordinateSpace: Sendable, Equatable {
    public var viewWidth: Double
    public var viewHeight: Double
    public var imageWidth: Double
    public var imageHeight: Double

    public init(viewWidth: Double, viewHeight: Double, imageWidth: Double, imageHeight: Double) {
        self.viewWidth = viewWidth
        self.viewHeight = viewHeight
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
    }

    /// Aspect-fit rect of the image inside the view, origin at the view's top-left.
    public var fittedImageRect: MarkupRect {
        guard viewWidth > 0, viewHeight > 0, imageWidth > 0, imageHeight > 0 else {
            return MarkupRect(x: 0, y: 0, width: 0, height: 0)
        }
        let viewAspect = viewWidth / viewHeight
        let imageAspect = imageWidth / imageHeight
        let width: Double
        let height: Double
        if imageAspect > viewAspect {
            width = viewWidth
            height = viewWidth / imageAspect
        } else {
            height = viewHeight
            width = viewHeight * imageAspect
        }
        return MarkupRect(
            x: (viewWidth - width) / 2,
            y: (viewHeight - height) / 2,
            width: width,
            height: height)
    }

    public var isUsable: Bool { !fittedImageRect.isEmpty }

    public func normalize(viewPoint: MarkupPoint) -> NormalizedCoordinate {
        let rect = fittedImageRect
        guard !rect.isEmpty else { return NormalizedCoordinate(x: 0, y: 0) }
        return NormalizedCoordinate(
            x: (viewPoint.x - rect.x) / rect.width,
            y: (viewPoint.y - rect.y) / rect.height)
    }

    public func viewPoint(from coord: NormalizedCoordinate) -> MarkupPoint {
        let rect = fittedImageRect
        return MarkupPoint(
            x: rect.x + coord.x * rect.width,
            y: rect.y + coord.y * rect.height)
    }

    /// Pixel coordinates in the source bitmap. Independent of view size.
    public func normalize(pixel: MarkupPoint) -> NormalizedCoordinate {
        guard imageWidth > 0, imageHeight > 0 else {
            return NormalizedCoordinate(x: 0, y: 0)
        }
        return NormalizedCoordinate(x: pixel.x / imageWidth, y: pixel.y / imageHeight)
    }

    public func pixel(from coord: NormalizedCoordinate) -> MarkupPoint {
        MarkupPoint(x: coord.x * imageWidth, y: coord.y * imageHeight)
    }
}

/// Records markup in normalized image space. View size can change between
/// gestures; stored primitives stay put because they are not view-relative.
public struct MarkupCaptureSession: Sendable, Equatable {
    public var space: MarkupCoordinateSpace
    public private(set) var primitives: [MarkupPrimitive]

    public init(space: MarkupCoordinateSpace, primitives: [MarkupPrimitive] = []) {
        self.space = space
        self.primitives = primitives
    }

    public mutating func addStroke(
        viewPoints: [MarkupPoint],
        color: MarkupColor,
        thickness: Double
    ) throws {
        try guardUsable()
        let points = viewPoints.map { space.normalize(viewPoint: $0) }
        let primitive = MarkupPrimitive.stroke(
            points: points, color: color, thickness: try MarkupPrimitive.validatedThickness(thickness))
        try primitive.validate()
        primitives.append(primitive)
    }

    public mutating func addRect(
        start: MarkupPoint,
        end: MarkupPoint,
        color: MarkupColor,
        thickness: Double
    ) throws {
        try guardUsable()
        let primitive = MarkupPrimitive.rect(
            start: space.normalize(viewPoint: start),
            end: space.normalize(viewPoint: end),
            color: color,
            thickness: try MarkupPrimitive.validatedThickness(thickness))
        try primitive.validate()
        primitives.append(primitive)
    }

    public mutating func addArrow(
        start: MarkupPoint,
        end: MarkupPoint,
        color: MarkupColor,
        thickness: Double
    ) throws {
        try guardUsable()
        let primitive = MarkupPrimitive.arrow(
            start: space.normalize(viewPoint: start),
            end: space.normalize(viewPoint: end),
            color: color,
            thickness: try MarkupPrimitive.validatedThickness(thickness))
        try primitive.validate()
        primitives.append(primitive)
    }

    public mutating func undoLast() {
        if !primitives.isEmpty { primitives.removeLast() }
    }

    /// Bind these primitives to the attachment that will actually be produced.
    /// An id that does not resolve is worse than no id — refuse empty ids here.
    public func makePayload(attachmentId: String) throws -> MarkupPayload {
        try MarkupPayload(attachmentId: attachmentId, primitives: primitives)
    }

    private func guardUsable() throws {
        guard space.isUsable else { throw MarkupValidationError.emptyCoordinateSpace }
    }
}

/// Stamps a `MarkupPayload` onto the existing image-attachment wire dict
/// (`name` / `mimeType` / `dataBase64`). No new host contract: unknown keys
/// ride the payload the composer already sends.
public enum MarkupAttachmentAssembly {
    /// JSON object form of the payload, suitable for a `[String: Any]` wire dict.
    public static func jsonObject(_ payload: MarkupPayload) throws -> [String: Any] {
        let data = try payload.encodedJSONData()
        guard data.count <= MarkupPayload.maxEncodedBytes else {
            throw MarkupValidationError.markupTooLarge(
                bytes: data.count, maximum: MarkupPayload.maxEncodedBytes)
        }
        let object = try JSONSerialization.jsonObject(with: data)
        guard let dict = object as? [String: Any] else {
            throw MarkupValidationError.emptyAttachmentId
        }
        return dict
    }

    /// Bind markup onto an ordinary image attachment. Returns nil — and does
    /// not stamp — when the dict's `id` is missing or does not match the
    /// payload. A dangling `attachmentId` is worse than omitting markup.
    public static func stamp(_ payload: MarkupPayload, onto wire: [String: Any]) -> [String: Any]? {
        guard let id = wire["id"] as? String,
            id == payload.attachmentId,
            !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        guard let markup = try? jsonObject(payload) else { return nil }
        var out = wire
        out["markup"] = markup
        return out
    }

    /// Produce a wire dict whose `id` is the payload's `attachmentId`.
    /// Refuses when those two ids would disagree.
    public static func makeWireDict(
        attachmentId: String,
        name: String,
        mimeType: String,
        dataBase64: String,
        payload: MarkupPayload
    ) -> [String: Any]? {
        let trimmed = attachmentId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, payload.attachmentId == trimmed else { return nil }
        let wire: [String: Any] = [
            "id": trimmed,
            "name": name,
            "mimeType": mimeType,
            "dataBase64": dataBase64,
        ]
        return stamp(payload, onto: wire)
    }
}

/// Rasterizes markup primitives into the source bitmap so the provider sees
/// the annotation, not a clean screenshot. Coordinates stay on the payload
/// separately — flattening is for eyes, coordinates are for reasoning.
/// Reuses the 8 MiB assembler cap; exceeding it is a refusal, never silent.
public enum MarkupFlattener {
    public static let maxEncodedBytes = FullSizeMediaAssembler.maxBytes
    /// Bounds the decoded bitmap before allocating the RGBA drawing context.
    /// An 8 MiB compressed image can otherwise expand into hundreds of MiB.
    public static let maxRasterDimension = 8_192
    public static let maxRasterPixels = 24_000_000
    /// Thickness is stored in annotating-view points. A 3pt stroke on a ~400pt
    /// preview must stay visible on a 1600px screenshot.
    public static let thicknessReferenceDimension: Double = 400

    /// Empty primitives return `imageData` unchanged (identity). Non-empty
    /// markup is burned into a JPEG. The result is required to differ from
    /// the source — a flatten that no-ops would pass a shape test and fail
    /// the user.
    public static func flatten(
        imageData: Data,
        primitives: [MarkupPrimitive],
        maxEncodedBytes: Int = maxEncodedBytes,
        maxRasterDimension: Int = maxRasterDimension,
        maxRasterPixels: Int = maxRasterPixels
    ) throws -> Data {
        guard !primitives.isEmpty else { return imageData }
        #if canImport(CoreGraphics) && canImport(ImageIO)
            guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
                let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil),
                cgImage.width > 0, cgImage.height > 0
            else {
                throw MarkupFlattenError.undecodableImage
            }
            let width = cgImage.width
            let height = cgImage.height
            guard maxRasterDimension > 0,
                maxRasterPixels > 0,
                width <= maxRasterDimension,
                height <= maxRasterDimension,
                width <= maxRasterPixels / height
            else {
                throw MarkupFlattenError.rasterExceedsMaximum(
                    width: width,
                    height: height,
                    maximumDimension: maxRasterDimension,
                    maximumPixels: maxRasterPixels)
            }
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            guard let ctx = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else {
                throw MarkupFlattenError.undecodableImage
            }
            ctx.interpolationQuality = .high
            ctx.setShouldAntialias(true)
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            // Image is drawn in default CG space (origin bottom-left). Flip so
            // primitive y=0 is the top of the bitmap, matching the payload.
            ctx.translateBy(x: 0, y: CGFloat(height))
            ctx.scaleBy(x: 1, y: -1)
            let scale = min(Double(width), Double(height)) / thicknessReferenceDimension
            for primitive in primitives {
                draw(primitive, in: ctx, width: Double(width), height: Double(height), scale: scale)
            }
            guard let flattened = ctx.makeImage() else {
                throw MarkupFlattenError.undecodableImage
            }
            var smallest: Data?
            for quality in [0.9, 0.7, 0.55, 0.4] as [Double] {
                guard let jpeg = encodeJPEG(flattened, quality: quality) else { continue }
                smallest = jpeg
                if jpeg.count <= maxEncodedBytes {
                    return jpeg
                }
            }
            let received = smallest?.count ?? flattened.width * flattened.height * 4
            throw MarkupFlattenError.exceedsMaximum(
                received: received, maximum: maxEncodedBytes)
        #else
            throw MarkupFlattenError.undecodableImage
        #endif
    }

    #if canImport(CoreGraphics) && canImport(ImageIO)
        private static func encodeJPEG(_ image: CGImage, quality: Double) -> Data? {
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                data, "public.jpeg" as CFString, 1, nil)
            else { return nil }
            let options: [CFString: Any] = [
                kCGImageDestinationLossyCompressionQuality: quality
            ]
            CGImageDestinationAddImage(destination, image, options as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            return data as Data
        }

        private static func draw(
            _ primitive: MarkupPrimitive,
            in ctx: CGContext,
            width: Double,
            height: Double,
            scale: Double
        ) {
            switch primitive {
            case .stroke(let points, let color, let thickness):
                guard let first = points.first else { return }
                applyStroke(color, thickness: thickness, scale: scale, in: ctx)
                ctx.beginPath()
                ctx.move(to: cgPoint(first, width: width, height: height))
                for point in points.dropFirst() {
                    ctx.addLine(to: cgPoint(point, width: width, height: height))
                }
                ctx.strokePath()
            case .rect(let start, let end, let color, let thickness):
                applyStroke(color, thickness: thickness, scale: scale, in: ctx)
                let a = cgPoint(start, width: width, height: height)
                let b = cgPoint(end, width: width, height: height)
                ctx.stroke(
                    CGRect(
                        x: min(a.x, b.x),
                        y: min(a.y, b.y),
                        width: abs(a.x - b.x),
                        height: abs(a.y - b.y)))
            case .arrow(let start, let end, let color, let thickness):
                let a = cgPoint(start, width: width, height: height)
                let b = cgPoint(end, width: width, height: height)
                let lineWidth = pixelThickness(thickness, scale: scale)
                applyStroke(color, thickness: thickness, scale: scale, in: ctx)
                ctx.beginPath()
                ctx.move(to: a)
                ctx.addLine(to: b)
                ctx.strokePath()
                let dx = b.x - a.x
                let dy = b.y - a.y
                let length = hypot(dx, dy)
                guard length > 0 else { return }
                let ux = dx / length
                let uy = dy / length
                let head = max(8, lineWidth * 4)
                let left = CGPoint(
                    x: b.x - ux * head + uy * head * 0.4,
                    y: b.y - uy * head - ux * head * 0.4)
                let right = CGPoint(
                    x: b.x - ux * head - uy * head * 0.4,
                    y: b.y - uy * head + ux * head * 0.4)
                ctx.beginPath()
                ctx.move(to: b)
                ctx.addLine(to: left)
                ctx.move(to: b)
                ctx.addLine(to: right)
                ctx.strokePath()
            }
        }

        private static func applyStroke(
            _ color: MarkupColor, thickness: Double, scale: Double, in ctx: CGContext
        ) {
            ctx.setStrokeColor(
                CGColor(
                    red: color.r, green: color.g, blue: color.b, alpha: color.a))
            ctx.setLineCap(.round)
            ctx.setLineJoin(.round)
            ctx.setLineWidth(pixelThickness(thickness, scale: scale))
        }

        private static func pixelThickness(_ thickness: Double, scale: Double) -> CGFloat {
            CGFloat(max(1, thickness * max(scale, 0.25)))
        }

        private static func cgPoint(
            _ coord: NormalizedCoordinate, width: Double, height: Double
        ) -> CGPoint {
            CGPoint(x: coord.x * width, y: coord.y * height)
        }
    #endif
}
