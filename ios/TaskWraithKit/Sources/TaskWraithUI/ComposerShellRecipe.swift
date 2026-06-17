// ComposerShellRecipe.swift — the RESOLVED, ready-to-render description of a
// composer shell (the output of ComposerShellResolver) plus the resolution
// CONTEXT (theme + accessibility + presentation). Views read a
// `ResolvedComposerShell`, never a raw TWComposerStyle, so every per-style
// branch and every accessibility downgrade lives in the resolver (CS3) — the
// views just render. See ios/COMPOSER-SHELL-PARITY.md (Part C, E.5).
//
// This is the CONTRACT every per-style recipe (CS3b) and every consuming view
// (CS4–CS6) targets. Keep it stable.

import SwiftUI
#if canImport(UIKit)
    import UIKit
#endif
import TaskWraithKit

/// Surface material family. `glass` is the native default; `transparent` means
/// the surface draws no chrome and its children float (modular/satellite).
public enum ComposerShellMaterial: Equatable, Sendable {
    case glass
    case solid
    case paper
    case transparent
}

/// Control / chip / send-button silhouette.
public enum ComposerControlShape: Equatable, Sendable {
    case capsule
    case rounded(CGFloat)
    case rect(CGFloat)
}

/// The send-button glyph family (desktop App.tsx:20675-20685 mapping).
public enum ComposerSendGlyph: Equatable, Sendable {
    case returnArrow  // claude
    case arrowUp      // codex/gemini/cursor/grok/kimi (+ the shipped iOS default)
    case runTriangle  // desktop default + modular/terminal/stub/satellite/obsidian/alabaster
}

/// How the send button is filled.
public enum ComposerSendFill: Equatable, Sendable {
    case accent       // accent/success filled circle (default, modular, satellite)
    case neutral      // inverse-of-surface fill (grok, cursor, gemini, kimi, codex)
    case outline
    case plain        // transparent (claude squared enter)
}

/// Textarea / chrome font family.
public enum ComposerShellFontDesign: Equatable, Sendable {
    case system
    case monospaced  // terminal
    case serif       // stub
}

/// Above-row layout behavior (the desktop `:has()` row-presence switch).
public enum ComposerShellRowPolicy: Equatable, Sendable {
    case mergedInstrument  // default — stack fuses with the surface into one frame
    case tuckedTab         // grok — solo tab vs merged multi-row frame
    case floatAbove        // cursor, codex — git/PR rows detached above the stack
    case insideStack       // rows sit inside the stack as separate segments
}

/// Visible decorative chrome that needs bespoke drawing (CS6 premium effects).
public struct ComposerShellEffects: OptionSet, Equatable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let rimChase = ComposerShellEffects(rawValue: 1 << 0)          // obsidian, alabaster
    public static let paperGrain = ComposerShellEffects(rawValue: 1 << 1)        // stub
    public static let perforation = ComposerShellEffects(rawValue: 1 << 2)       // stub
    public static let terminalCaret = ComposerShellEffects(rawValue: 1 << 3)     // terminal
    public static let bracketChips = ComposerShellEffects(rawValue: 1 << 4)      // terminal
    public static let twoSurfaceSplit = ComposerShellEffects(rawValue: 1 << 5)   // obsidian, alabaster
    public static let transparentChrome = ComposerShellEffects(rawValue: 1 << 6) // modular, satellite
}

/// An inset rim/glow ring (desktop `box-shadow inset` parity).
public struct ComposerShellRim: Equatable, Sendable {
    public var color: Color
    public var width: CGFloat
    public var glow: Color?
    public init(color: Color, width: CGFloat = 1, glow: Color? = nil) {
        self.color = color
        self.width = width
        self.glow = glow
    }
}

public struct ComposerSendButton: Equatable, Sendable {
    public var glyph: ComposerSendGlyph
    public var shape: ComposerControlShape
    public var size: CGFloat
    public var fill: ComposerSendFill
    public var tint: Color
    public init(
        glyph: ComposerSendGlyph,
        shape: ComposerControlShape = .capsule,
        size: CGFloat = 40,
        fill: ComposerSendFill = .accent,
        tint: Color
    ) {
        self.glyph = glyph
        self.shape = shape
        self.size = size
        self.fill = fill
        self.tint = tint
    }
}

public struct ComposerShellPalette: Equatable, Sendable {
    public var surfaceFill: Color
    /// A distinct card-in-card typing panel (default's #141418 / codex's #252525).
    /// `nil` = the textarea sits directly on the surface.
    public var innerModuleFill: Color?
    public var border: Color
    public var focusAccent: Color
    public var textPrimary: Color
    public var placeholder: Color
    public var rim: ComposerShellRim?
    public init(
        surfaceFill: Color,
        innerModuleFill: Color? = nil,
        border: Color,
        focusAccent: Color,
        textPrimary: Color,
        placeholder: Color,
        rim: ComposerShellRim? = nil
    ) {
        self.surfaceFill = surfaceFill
        self.innerModuleFill = innerModuleFill
        self.border = border
        self.focusAccent = focusAccent
        self.textPrimary = textPrimary
        self.placeholder = placeholder
        self.rim = rim
    }
}

public struct ComposerShellGeometry: Equatable, Sendable {
    public var surfaceCornerRadius: CGFloat
    public var innerCornerRadius: CGFloat
    public var controlShape: ComposerControlShape
    public var surfacePadding: EdgeInsets
    public var rowSpacing: CGFloat
    public init(
        surfaceCornerRadius: CGFloat,
        innerCornerRadius: CGFloat = 0,
        controlShape: ComposerControlShape = .capsule,
        surfacePadding: EdgeInsets = EdgeInsets(),
        rowSpacing: CGFloat = 0
    ) {
        self.surfaceCornerRadius = surfaceCornerRadius
        self.innerCornerRadius = innerCornerRadius
        self.controlShape = controlShape
        self.surfacePadding = surfacePadding
        self.rowSpacing = rowSpacing
    }
}

/// The fully resolved shell — material + palette + geometry + behavior. Views
/// render this verbatim; a11y downgrades are already baked in by the resolver.
public struct ResolvedComposerShell: Equatable, Sendable {
    public var style: TWComposerStyle
    public var material: ComposerShellMaterial
    public var palette: ComposerShellPalette
    public var geometry: ComposerShellGeometry
    public var fontDesign: ComposerShellFontDesign
    public var sendButton: ComposerSendButton
    public var rowPolicy: ComposerShellRowPolicy
    public var effects: ComposerShellEffects
    /// True for shells that lock their own palette regardless of app theme
    /// (grok/cursor/terminal/obsidian/alabaster).
    public var themeImmune: Bool
    public init(
        style: TWComposerStyle,
        material: ComposerShellMaterial,
        palette: ComposerShellPalette,
        geometry: ComposerShellGeometry,
        fontDesign: ComposerShellFontDesign = .system,
        sendButton: ComposerSendButton,
        rowPolicy: ComposerShellRowPolicy = .insideStack,
        effects: ComposerShellEffects = [],
        themeImmune: Bool = false
    ) {
        self.style = style
        self.material = material
        self.palette = palette
        self.geometry = geometry
        self.fontDesign = fontDesign
        self.sendButton = sendButton
        self.rowPolicy = rowPolicy
        self.effects = effects
        self.themeImmune = themeImmune
    }
}

/// Inputs to recipe resolution: app theme + accessibility + presentation.
public struct ComposerShellContext: Equatable, Sendable {
    public enum Presentation: Equatable, Sendable {
        case main
        case welcome
        case miniSideChat
    }
    public var appIsLight: Bool
    public var reduceTransparency: Bool
    public var reduceMotion: Bool
    public var highContrast: Bool
    public var presentation: Presentation
    public var width: CGFloat?
    public var dynamicTypeLarge: Bool
    public var providerAccent: Color?

    public init(
        appIsLight: Bool,
        reduceTransparency: Bool = false,
        reduceMotion: Bool = false,
        highContrast: Bool = false,
        presentation: Presentation = .main,
        width: CGFloat? = nil,
        dynamicTypeLarge: Bool = false,
        providerAccent: Color? = nil
    ) {
        self.appIsLight = appIsLight
        self.reduceTransparency = reduceTransparency
        self.reduceMotion = reduceMotion
        self.highContrast = highContrast
        self.presentation = presentation
        self.width = width
        self.dynamicTypeLarge = dynamicTypeLarge
        self.providerAccent = providerAccent
    }

    /// Build the context live from the theme store + system accessibility.
    @MainActor public static func current(
        presentation: Presentation = .main,
        width: CGFloat? = nil,
        providerAccent: Color? = nil
    ) -> ComposerShellContext {
        var reduceTransparency = false
        var reduceMotion = false
        var highContrast = false
        #if canImport(UIKit)
            reduceTransparency = UIAccessibility.isReduceTransparencyEnabled
            reduceMotion = UIAccessibility.isReduceMotionEnabled
            highContrast = UIAccessibility.isDarkerSystemColorsEnabled
        #endif
        return ComposerShellContext(
            appIsLight: TWThemeStore.shared.systemTheme.isLight,
            reduceTransparency: reduceTransparency,
            reduceMotion: reduceMotion,
            highContrast: highContrast,
            presentation: presentation,
            width: width,
            providerAccent: providerAccent)
    }
}
