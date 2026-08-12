import CoreGraphics
import CoreText
import Foundation
import Metal

/// Shared geometry for overlay text, so the layout model and the renderer cannot
/// disagree about how wide a string is.
public enum StudioOverlayRenderMetrics {
    /// Printable ASCII, which is all a transport HUD needs: timecode, counters
    /// and short labels. Anything outside it renders as a space rather than
    /// tofu — a HUD is not a text engine and should not pretend to be one.
    public static let firstScalar: UInt8 = 32
    public static let lastScalar: UInt8 = 126
    public static var glyphCount: Int { Int(lastScalar - firstScalar) + 1 }

    /// Monospaced advance as a fraction of point size. Menlo measures 0.60021.
    public static let advanceRatio: Double = 0.6
    /// Cell height as a fraction of point size, leaving room for ascender and
    /// descender.
    public static let lineHeightRatio: Double = 1.25

    /// Rasterisation size. Text is drawn by scaling this cell, so it wants to be
    /// comfortably larger than the biggest on-screen size (22pt * 2x = 44px).
    public static let referenceSize: Double = 64

    /// The atlas cell must be a whole number of pixels or neighbouring glyphs
    /// bleed into each other. Rounding it ONCE here — and having both the atlas
    /// and the layout model derive from this single value — is what keeps
    /// predicted string width identical to drawn string width. Deriving the two
    /// independently from `advanceRatio` would put them ~1.5% apart, which
    /// right-aligned text turns into a visible overhang.
    public static let referenceCellWidth: Double = (referenceSize * advanceRatio).rounded()
    public static let referenceCellHeight: Double = (referenceSize * lineHeightRatio).rounded()

    /// Horizontal step between glyphs drawn at `pointSize`.
    public static func advance(forPointSize pointSize: Double) -> Double {
        referenceCellWidth / referenceSize * pointSize
    }

    /// Drawn height of a glyph cell at `pointSize`.
    public static func cellHeight(forPointSize pointSize: Double) -> Double {
        referenceCellHeight / referenceSize * pointSize
    }

    public static func width(of string: String, pointSize: Double) -> Double {
        advance(forPointSize: pointSize) * Double(string.count)
    }
}

public enum StudioTextAtlasError: Error, Equatable {
    case fontUnavailable
    case bitmapContextUnavailable
    case textureAllocationFailed
}

/// A monospaced ASCII glyph sheet baked into one Metal texture.
///
/// WHY AN ATLAS. The overlay has to draw text over live video every refresh. The
/// banked AVCDAW do-not-repeat note forbids a CPU-composited path over the
/// picture, and rasterising strings per frame would be exactly that — CoreText
/// into a bitmap into a texture upload, sixty times a second. Rasterising ONCE
/// at construction turns per-frame text into a handful of textured quads that
/// ride the same render pass and the same command buffer as the video.
///
/// Single-channel (.r8Unorm) coverage, not colour: the glyph supplies alpha and
/// the vertex supplies the tint, so one atlas serves every colour in the HUD.
public final class StudioTextAtlas {
    public static let columns = 16

    public let texture: MTLTexture
    public let cellWidth: Double
    public let cellHeight: Double
    private let rows: Int

    public init(device: MTLDevice, fontName: String = "Menlo") throws {
        let reference = StudioOverlayRenderMetrics.referenceSize
        // CTFontCreateWithName substitutes rather than failing, so a missing
        // Menlo degrades to the system font instead of losing the HUD entirely.
        let font = CTFontCreateWithName(fontName as CFString, reference, nil)

        let cellWidth = StudioOverlayRenderMetrics.referenceCellWidth
        let cellHeight = StudioOverlayRenderMetrics.referenceCellHeight
        let glyphCount = StudioOverlayRenderMetrics.glyphCount
        let rows = Int((Double(glyphCount) / Double(Self.columns)).rounded(.up))
        let atlasWidth = Int(cellWidth) * Self.columns
        let atlasHeight = Int(cellHeight) * rows

        guard
            let context = CGContext(
                data: nil,
                width: atlasWidth,
                height: atlasHeight,
                bitsPerComponent: 8,
                bytesPerRow: atlasWidth,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            )
        else {
            throw StudioTextAtlasError.bitmapContextUnavailable
        }
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: atlasWidth, height: atlasHeight))
        context.setFillColor(gray: 1, alpha: 1)
        context.setAllowsAntialiasing(true)
        context.setShouldAntialias(true)

        let descent = CTFontGetDescent(font)
        for index in 0..<glyphCount {
            let scalarValue = UInt8(Int(StudioOverlayRenderMetrics.firstScalar) + index)
            var character = UniChar(scalarValue)
            var glyph = CGGlyph()
            guard CTFontGetGlyphsForCharacters(font, &character, &glyph, 1), glyph != 0 else {
                continue
            }
            let column = index % Self.columns
            let row = index / Self.columns
            // CGBitmapContext memory row 0 is the TOP row, while its drawing
            // origin is bottom-left. Placing grid row `row` this many cells up
            // from the bottom therefore makes texture v increase downward, which
            // is the same direction the layout model uses.
            let rowFromBottom = rows - 1 - row
            var position = CGPoint(
                x: CGFloat(Double(column) * cellWidth),
                y: CGFloat(Double(rowFromBottom) * cellHeight + descent * 0.5)
            )
            CTFontDrawGlyphs(font, &glyph, &position, 1, context)
        }

        guard let data = context.data else {
            throw StudioTextAtlasError.bitmapContextUnavailable
        }

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .r8Unorm,
            width: atlasWidth,
            height: atlasHeight,
            mipmapped: false
        )
        descriptor.usage = .shaderRead
        descriptor.storageMode = device.hasUnifiedMemory ? .shared : .managed
        guard let texture = device.makeTexture(descriptor: descriptor) else {
            throw StudioTextAtlasError.textureAllocationFailed
        }
        texture.replace(
            region: MTLRegionMake2D(0, 0, atlasWidth, atlasHeight),
            mipmapLevel: 0,
            withBytes: data,
            bytesPerRow: atlasWidth
        )

        self.texture = texture
        self.cellWidth = cellWidth
        self.cellHeight = cellHeight
        self.rows = rows
    }

    /// Normalised atlas rect for a character, or nil when it is outside the
    /// printable ASCII sheet.
    public func uvRect(for character: Character) -> (u0: Double, v0: Double, u1: Double, v1: Double)? {
        guard let ascii = character.asciiValue,
            ascii >= StudioOverlayRenderMetrics.firstScalar,
            ascii <= StudioOverlayRenderMetrics.lastScalar
        else {
            return nil
        }
        let index = Int(ascii - StudioOverlayRenderMetrics.firstScalar)
        let column = index % Self.columns
        let row = index / Self.columns
        let atlasWidth = cellWidth * Double(Self.columns)
        let atlasHeight = cellHeight * Double(rows)
        return (
            u0: Double(column) * cellWidth / atlasWidth,
            v0: Double(row) * cellHeight / atlasHeight,
            u1: Double(column + 1) * cellWidth / atlasWidth,
            v1: Double(row + 1) * cellHeight / atlasHeight
        )
    }
}
