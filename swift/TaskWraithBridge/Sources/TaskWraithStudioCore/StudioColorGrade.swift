import Foundation

/// Grading-aware preview (mission outcome 8), deliberately bounded.
///
/// SCOPE IS THE MISSION'S, NOT MINE: Original/Effect bypass, a display
/// transform, ONE externally supplied LUT, and a split comparison. "Do not grow
/// a full grading suite unless the owner expands scope" is explicit and the
/// owner has not expanded it, so there is no LUT stack, no CDL, no curves, no
/// scopes and no per-channel controls here. The seam exists for a colourist
/// tool; this is a preview.

/// What the viewer is showing.
public enum StudioGradeMode: String, Equatable, Sendable, CaseIterable {
    /// The picture with NO grading code executed at all — see the note on
    /// StudioVideoFrameRenderer's three pipelines.
    case original
    case effect
    /// Both, in one pass, split at a vertical boundary.
    case split

    public var label: String {
        switch self {
        case .original: return "ORIG"
        case .effect: return "FX"
        case .split: return "SPLIT"
        }
    }
}

/// Transfer-function conversion applied on the way to the display.
///
/// Decoded video is Rec.709-ENCODED. A Mac display expects sRGB. Those two
/// transfer curves are NOT the same — 709's toe is linear to 0.081 with a 1/0.45
/// power above it, sRGB's is linear to 0.04045 with a 1/2.4 power — so handing
/// 709 values straight to an sRGB surface is approximately right and exactly
/// wrong, most visibly in the shadows. This is the one display transform the
/// viewer actually needs today.
public enum StudioDisplayTransform: String, Equatable, Sendable, CaseIterable {
    /// Pass through. Honest default: doing nothing is what the viewer did
    /// before this slice, and changing that silently would be its own defect.
    case none
    case rec709ToSRGB

    public var label: String {
        self == .none ? "xf off" : "709>sRGB"
    }

    /// Reference implementation, used by tests to check the shader agrees.
    ///
    /// Kept on the CPU ONLY as an oracle. Per the banked AVCDAW note the
    /// transform itself belongs in the shader; this exists so a test can assert
    /// the GPU result against an independently-derived value rather than
    /// against itself.
    public func apply(_ value: Double) -> Double {
        guard self == .rec709ToSRGB else { return value }
        let linear = Self.rec709ToLinear(value)
        return Self.linearToSRGB(linear)
    }

    static func rec709ToLinear(_ encoded: Double) -> Double {
        if encoded < 0.081 { return encoded / 4.5 }
        return pow((encoded + 0.099) / 1.099, 1.0 / 0.45)
    }

    static func linearToSRGB(_ linear: Double) -> Double {
        if linear <= 0.003_130_8 { return linear * 12.92 }
        return 1.055 * pow(linear, 1.0 / 2.4) - 0.055
    }
}

public struct StudioGradeSettings: Equatable, Sendable {
    public var mode: StudioGradeMode
    public var displayTransform: StudioDisplayTransform
    /// Split boundary in normalised width. Left of it shows Original.
    public var splitPosition: Float
    /// Blend of the LUT against the ungraded picture, for a bounded preview.
    public var lutAmount: Float

    public init(
        mode: StudioGradeMode = .original,
        displayTransform: StudioDisplayTransform = .none,
        splitPosition: Float = 0.5,
        lutAmount: Float = 1.0
    ) {
        self.mode = mode
        self.displayTransform = displayTransform
        self.splitPosition = min(max(splitPosition, 0), 1)
        self.lutAmount = min(max(lutAmount, 0), 1)
    }

    /// True when nothing would change the picture. Used to keep the HUD honest
    /// rather than to skip work: a mode that claims "FX" while doing nothing is
    /// the same lie as a bypass that is not a bypass.
    public var isNeutral: Bool {
        displayTransform == .none && lutAmount == 0
    }
}

public enum StudioLutError: Error, Equatable {
    case missingSize
    case unsupportedSize(Int)
    case entryCountMismatch(expected: Int, found: Int)
    case malformedEntry(line: Int)
    case valueOutOfRange(line: Int)
}

/// An externally supplied 3D LUT, parsed from the Iridas/Adobe `.cube` format.
///
/// `.cube` because it is what colourists actually hand over — DaVinci, Baselight
/// and every LUT pack export it. Parsing is FAIL-CLOSED: a malformed LUT throws
/// rather than loading partially, because a half-loaded LUT would grade the
/// picture wrongly and look deliberate.
public struct StudioColorLut: Equatable, Sendable {
    /// 33 is the usual export size; 64 is the largest anyone ships. The cap is a
    /// resource bound, not taste: a 256-cube would be 64 MB of texture.
    public static let maximumSize = 64

    public let size: Int
    /// RGB triples, R varying fastest, matching the .cube contract.
    public let entries: [SIMD3<Float>]

    public init(size: Int, entries: [SIMD3<Float>]) throws {
        guard size >= 2, size <= Self.maximumSize else {
            throw StudioLutError.unsupportedSize(size)
        }
        let expected = size * size * size
        guard entries.count == expected else {
            throw StudioLutError.entryCountMismatch(expected: expected, found: entries.count)
        }
        self.size = size
        self.entries = entries
    }

    /// Identity LUT — a test control, and the thing an "identity coefficients"
    /// bypass would be indistinguishable from. That is exactly why the real
    /// bypass does not run this code at all.
    public static func identity(size: Int = 2) throws -> StudioColorLut {
        var entries: [SIMD3<Float>] = []
        entries.reserveCapacity(size * size * size)
        let last = Float(size - 1)
        for blue in 0..<size {
            for green in 0..<size {
                for red in 0..<size {
                    entries.append(
                        SIMD3(Float(red) / last, Float(green) / last, Float(blue) / last)
                    )
                }
            }
        }
        return try StudioColorLut(size: size, entries: entries)
    }

    public static func parseCube(_ text: String) throws -> StudioColorLut {
        var size: Int?
        var entries: [SIMD3<Float>] = []

        for (index, rawLine) in text.components(separatedBy: .newlines).enumerated() {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            // Comments and the metadata keys we do not need are skipped rather
            // than rejected: a real .cube carries TITLE and DOMAIN lines and
            // refusing them would reject most files in the wild.
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("TITLE") || line.hasPrefix("DOMAIN_") { continue }
            if line.hasPrefix("LUT_1D_SIZE") {
                throw StudioLutError.unsupportedSize(1)
            }
            if line.hasPrefix("LUT_3D_SIZE") {
                let parts = line.split(separator: " ").compactMap { Int($0) }
                guard let parsed = parts.first else {
                    throw StudioLutError.malformedEntry(line: index + 1)
                }
                size = parsed
                continue
            }

            let numbers = line.split(whereSeparator: { $0 == " " || $0 == "\t" })
                .compactMap { Float($0) }
            guard numbers.count == 3 else {
                throw StudioLutError.malformedEntry(line: index + 1)
            }
            guard numbers.allSatisfy({ $0.isFinite }) else {
                throw StudioLutError.valueOutOfRange(line: index + 1)
            }
            entries.append(SIMD3(numbers[0], numbers[1], numbers[2]))
        }

        guard let size else { throw StudioLutError.missingSize }
        return try StudioColorLut(size: size, entries: entries)
    }

    /// Flattened RGBA float data for a 3D texture upload.
    public var textureData: [Float] {
        var data: [Float] = []
        data.reserveCapacity(entries.count * 4)
        for entry in entries {
            data.append(entry.x)
            data.append(entry.y)
            data.append(entry.z)
            data.append(1)
        }
        return data
    }
}
