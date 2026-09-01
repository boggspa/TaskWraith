import Foundation
import Testing

#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import ImageIO
#endif

@testable import TaskWraithUI

@Suite("Provider logo assets")
struct ProviderLogoAssetTests {
    private struct PixelStats {
        var transparent = 0
        var chromatic = 0
        var black = 0
        var light = 0
        var opaqueColours = Set<UInt32>()
    }

    private func decodedPixelStats(at url: URL) throws -> PixelStats {
        #if canImport(CoreGraphics) && canImport(ImageIO)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let bytesPerRow = image.width * 4
        guard
            let context = CGContext(
                data: nil,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                    | CGBitmapInfo.byteOrder32Big.rawValue),
            let data = context.data
        else {
            throw CocoaError(.fileReadCorruptFile)
        }
        context.draw(
            image,
            in: CGRect(x: 0, y: 0, width: image.width, height: image.height))

        let pixels = data.assumingMemoryBound(to: UInt8.self)
        var stats = PixelStats()
        for offset in stride(from: 0, to: bytesPerRow * image.height, by: 4) {
            let red = pixels[offset]
            let green = pixels[offset + 1]
            let blue = pixels[offset + 2]
            let alpha = pixels[offset + 3]
            if alpha == 0 {
                stats.transparent += 1
            }
            guard alpha > 220 else { continue }
            let high = max(red, max(green, blue))
            let low = min(red, min(green, blue))
            if Int(high) - Int(low) > 30 {
                stats.chromatic += 1
            }
            if high < 24 {
                stats.black += 1
            }
            if low > 230 {
                stats.light += 1
            }
            stats.opaqueColours.insert(
                UInt32(red) << 16 | UInt32(green) << 8 | UInt32(blue))
        }
        return stats
        #else
        throw CocoaError(.featureUnsupported)
        #endif
    }

    @Test func fullColourMarksUseOneAssetAcrossAppearances() {
        for provider in ["gemini", "codex", "claude", "kimi", "antigravity", "mistral", "deepseek"] {
            let expected = "provider-logo-\(provider)"
            #expect(
                ProviderLogoAssetResolver.assetName(
                    for: provider, darkBackground: false) == expected)
            #expect(
                ProviderLogoAssetResolver.assetName(
                    for: provider, darkBackground: true) == expected)
        }
    }

    @Test func monochromeMarksChooseTheSurfaceSpecificAsset() {
        for provider in ["cursor", "grok", "ollama", "pi", "cerebras", "devin"] {
            #expect(
                ProviderLogoAssetResolver.assetName(
                    for: provider, darkBackground: false)
                    == "provider-logo-\(provider)-on-light")
            #expect(
                ProviderLogoAssetResolver.assetName(
                    for: provider, darkBackground: true)
                    == "provider-logo-\(provider)-on-dark")
        }
    }

    @Test func providerKeysAreNormalizedAndFallbacksRemainUnmapped() {
        #expect(
            ProviderLogoAssetResolver.assetName(
                for: "  CoDeX\n", darkBackground: true) == "provider-logo-codex")
        #expect(
            ProviderLogoAssetResolver.assetName(
                for: "ensemble", darkBackground: true) == nil)
        #expect(
            ProviderLogoAssetResolver.assetName(
                for: "qwen", darkBackground: false) == nil)
        #expect(
            ProviderLogoAssetResolver.assetName(
                for: nil, darkBackground: false) == nil)
    }

    @Test func newMarksUseTheSameOpticalBalanceAsDesktop() {
        #expect(ProviderLogoAssetResolver.opticalScale(for: " pi ") == 1.32)
        #expect(ProviderLogoAssetResolver.opticalScale(for: "MISTRAL") == 1.08)
        #expect(ProviderLogoAssetResolver.opticalScale(for: "codex") == 1)
    }

    @Test func everyResolvedAssetIsABundledPNG() throws {
        let names = [
            "provider-logo-gemini",
            "provider-logo-codex",
            "provider-logo-claude",
            "provider-logo-kimi",
            "provider-logo-antigravity",
            "provider-logo-cursor-on-light",
            "provider-logo-cursor-on-dark",
            "provider-logo-grok-on-light",
            "provider-logo-grok-on-dark",
            "provider-logo-ollama-on-light",
            "provider-logo-ollama-on-dark",
            "provider-logo-pi-on-light",
            "provider-logo-pi-on-dark",
            "provider-logo-mistral",
            "provider-logo-deepseek",
            "provider-logo-cerebras-on-light",
            "provider-logo-cerebras-on-dark",
            "provider-logo-devin-on-light",
            "provider-logo-devin-on-dark",
        ]
        let pngSignature = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

        for name in names {
            let url = try #require(ProviderLogoAssetResolver.resourceURL(for: name))
            let data = try Data(contentsOf: url)
            #expect(data.prefix(pngSignature.count) == pngSignature)
        }
    }

    @Test func devinMarkIsMonochromeOnATransparentCanvasForBothSurfaces() throws {
        // The official favicon is a black three-hexagon mark with real alpha-0
        // pixels; the on-dark file is its recorded RGB inverse (white, same alpha).
        let light = try #require(
            ProviderLogoAssetResolver.resourceURL(for: "provider-logo-devin-on-light"))
        let lightStats = try decodedPixelStats(at: light)
        #expect(lightStats.transparent > 0)
        #expect(lightStats.black > 0)
        #expect(lightStats.chromatic == 0)

        let dark = try #require(
            ProviderLogoAssetResolver.resourceURL(for: "provider-logo-devin-on-dark"))
        let darkStats = try decodedPixelStats(at: dark)
        #expect(darkStats.transparent == lightStats.transparent)
        #expect(darkStats.light > 0)
        #expect(darkStats.chromatic == 0)
    }

    @MainActor
    @Test func ensembleGlyphPreservesItsBundledFullColourArtwork() throws {
        #expect(ProviderGlyphIcon.usesOriginalArtwork(provider: nil, isEnsemble: true))
        #expect(ProviderGlyphIcon.usesOriginalArtwork(provider: " EnSeMbLe ", isEnsemble: false))
        #expect(!ProviderGlyphIcon.usesOriginalArtwork(provider: "codex", isEnsemble: false))
        #expect(ProviderGlyphIcon.bundledResourceURL(for: "codex") == nil)
        #expect(ProviderGlyphIcon.bundledResourceURL(for: "ollama") == nil)

        let url = try #require(ProviderGlyphIcon.bundledResourceURL(for: "ensemble"))
        let data = try Data(contentsOf: url)
        let pngSignature = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        #expect(data.prefix(pngSignature.count) == pngSignature)

        let stats = try decodedPixelStats(at: url)
        #expect(stats.transparent > 0)
        #expect(stats.chromatic > 0)
        #expect(stats.black > 0)
        #expect(stats.light > 0)
        #expect(stats.opaqueColours.count > 100)

        var iosRoot = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 {
            iosRoot.deleteLastPathComponent()
        }
        let appAssetDirectory = iosRoot.appendingPathComponent(
            "TaskWraithApp/Assets.xcassets/provider-glyph-ensemble.imageset")
        let appAssetData = try Data(
            contentsOf: appAssetDirectory.appendingPathComponent("provider-glyph-ensemble.png"))
        #expect(appAssetData == data)

        let contentsData = try Data(
            contentsOf: appAssetDirectory.appendingPathComponent("Contents.json"))
        let contents = try #require(
            JSONSerialization.jsonObject(with: contentsData) as? [String: Any])
        let properties = try #require(contents["properties"] as? [String: Any])
        #expect(properties["template-rendering-intent"] as? String == "original")

        let packageResources = iosRoot.appendingPathComponent(
            "TaskWraithKit/Sources/TaskWraithUI/Resources")
        let packageGlyphs = try FileManager.default.contentsOfDirectory(
            atPath: packageResources.path
        ).filter { $0.hasPrefix("provider-glyph-") }.sorted()
        #expect(packageGlyphs == ["provider-glyph-ensemble.png"])

        let appAssets = iosRoot.appendingPathComponent("TaskWraithApp/Assets.xcassets")
        let appGlyphSets = try FileManager.default.contentsOfDirectory(
            atPath: appAssets.path
        ).filter { $0.hasPrefix("provider-glyph-") }.sorted()
        #expect(appGlyphSets == ["provider-glyph-ensemble.imageset"])
    }
}
