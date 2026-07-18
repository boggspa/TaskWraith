import Foundation
import Testing

@testable import TaskWraithUI

@Suite("Provider logo assets")
struct ProviderLogoAssetTests {
    @Test func fullColourProvidersUseOneAssetAcrossAppearances() {
        for provider in ["gemini", "codex", "claude", "kimi"] {
            let expected = "provider-logo-\(provider)"
            #expect(
                ProviderLogoAssetResolver.assetName(
                    for: provider, darkBackground: false) == expected)
            #expect(
                ProviderLogoAssetResolver.assetName(
                    for: provider, darkBackground: true) == expected)
        }
    }

    @Test func monochromeProvidersChooseTheSurfaceSpecificAsset() {
        for provider in ["cursor", "grok", "ollama"] {
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

    @Test func everyResolvedAssetIsABundledPNG() throws {
        let names = [
            "provider-logo-gemini",
            "provider-logo-codex",
            "provider-logo-claude",
            "provider-logo-kimi",
            "provider-logo-cursor-on-light",
            "provider-logo-cursor-on-dark",
            "provider-logo-grok-on-light",
            "provider-logo-grok-on-dark",
            "provider-logo-ollama-on-light",
            "provider-logo-ollama-on-dark",
        ]
        let pngSignature = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

        for name in names {
            let url = try #require(ProviderLogoAssetResolver.resourceURL(for: name))
            let data = try Data(contentsOf: url)
            #expect(data.prefix(pngSignature.count) == pngSignature)
        }
    }
}
