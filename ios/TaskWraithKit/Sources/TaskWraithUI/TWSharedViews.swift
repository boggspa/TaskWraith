// Reusable chrome — ghost masthead, sidebar pill headers, rim highlights,
// and the hierarchical provider → model picker tree.

import SwiftUI
import TaskWraithKit

#if canImport(UIKit)
import UIKit
#endif

/// Loads `ghost-mark.png` from the SwiftPM resource bundle, falling back to
/// the host app's asset catalog (Xcode embeds TaskWraithUI resources
/// separately — `Image("ghost-mark", bundle: .module)` alone can miss).
public struct GhostMarkView: View {
    public var size: CGFloat = 34

    public init(size: CGFloat = 34) { self.size = size }

    public var body: some View {
        Group {
            if let image = Self.loadImage() {
                image
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "sparkles")
                    .font(.system(size: size * 0.55, weight: .semibold))
                    .foregroundStyle(TWTheme.chroma3)
            }
        }
        .frame(width: size, height: size)
    }

    private static func loadImage() -> Image? {
        #if canImport(UIKit)
        if let url = Bundle.module.url(forResource: "ghost-mark", withExtension: "png"),
            let data = try? Data(contentsOf: url),
            let ui = UIImage(data: data)
        {
            return Image(uiImage: ui)
        }
        if let ui = UIImage(named: "ghost-mark") {
            return Image(uiImage: ui)
        }
        #endif
        return nil
    }
}

public struct GhostMonolineMarkView: View {
    public var size: CGFloat = 58
    public var glow: Bool = true
    /// Optional override for the mark colour. Defaults to the theme mono tone;
    /// callers that want a provider-tinted mark (e.g. a running thread row) pass
    /// an accent here.
    public var tint: Color? = nil
    /// Optional override for the GLOW/halo colour, independent of the mark.
    /// Callers that want a provider-hued halo behind an otherwise mono mark —
    /// the transcript "Working…" indicator — pass the accent here; the mark
    /// itself stays mono unless `tint` is also set. Defaults to the brand
    /// chroma when nil.
    public var glowTint: Color? = nil

    public init(
        size: CGFloat = 58, glow: Bool = true, tint: Color? = nil, glowTint: Color? = nil
    ) {
        self.size = size
        self.glow = glow
        self.tint = tint
        self.glowTint = glowTint
    }

    public var body: some View {
        ZStack {
            if glow {
                Circle()
                    .fill(
                        RadialGradient(
                            gradient: Gradient(
                                stops: [
                                    .init(color: glowBase.opacity(0.34), location: 0),
                                    .init(
                                        color: glowBase.opacity(0.16),
                                        location: 0.46
                                    ),
                                    .init(color: glowBase.opacity(0), location: 0.76)
                                ]
                            ),
                            center: .center,
                            startRadius: 0,
                            endRadius: size * 0.46
                        )
                    )
                    .frame(width: size * 0.9, height: size * 0.9)
                    .blur(radius: size * 0.08)
                    .scaleEffect(1.08)
            }
            Group {
                if let image = Self.cachedImage {
                    image
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                } else {
                    Image(systemName: "sparkles")
                        .font(.system(size: size * 0.55, weight: .semibold))
                }
            }
            .foregroundStyle(tint ?? markColor)
            .shadow(color: shadowColor, radius: 1, y: 1)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var markColor: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.76) : Color.white.opacity(0.94)
    }

    /// Halo colour — a provider accent when the caller passes `glowTint`
    /// (transcript "Working…"), else the neutral brand chroma.
    private var glowBase: Color { glowTint ?? TWTheme.chroma1Default }

    private var shadowColor: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.white.opacity(0.4) : Color.black.opacity(0.24)
    }

    /// Loaded once (disk read + decode), not per `body` — the mark now renders
    /// inside the live transcript's activity anchor, a hot re-render path.
    private static let cachedImage: Image? = {
        #if canImport(UIKit)
        if let url = Bundle.module.url(forResource: "ghost-mark-monoline", withExtension: "png"),
            let data = try? Data(contentsOf: url),
            let ui = UIImage(data: data)
        {
            return Image(uiImage: ui.withRenderingMode(.alwaysTemplate))
        }
        if let ui = UIImage(named: "ghost-mark-monoline") {
            return Image(uiImage: ui.withRenderingMode(.alwaysTemplate))
        }
        #endif
        return nil
    }()
}

public struct TaskWraithMonolineBrandView: View {
    public var markSize: CGFloat = 64
    public var titleSize: CGFloat = 24

    public init(markSize: CGFloat = 64, titleSize: CGFloat = 24) {
        self.markSize = markSize
        self.titleSize = titleSize
    }

    public var body: some View {
        VStack(spacing: 14) {
            GhostMonolineMarkView(size: markSize)
            Text("TaskWraith")
                .font(titleFont)
                .foregroundStyle(TWTheme.textSecondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("TaskWraith"))
    }

    private var titleFont: Font {
        #if canImport(UIKit)
            if UIFont(name: "AvenirNext-Bold", size: titleSize) != nil {
                return .custom("AvenirNext-Bold", size: titleSize, relativeTo: .title3)
            }
        #endif
        return .system(size: titleSize, weight: .bold, design: .default)
    }
}

/// Desktop sidebar section header — all-caps label in a subtle pill.
/// Liquid-Glass capsule section header with a disclosure chevron — the
/// sidebar's structural chrome (Active Runs / Pinned / Recents / Workspaces /
/// Global Chats), matching the desktop sidebar's pill headers. Glass on
/// OS 26+, ultra-thin material capsule below.
struct GlassPillHeader: View {
    let title: String
    var systemImage: String? = nil
    var usesEnsembleGlyph = false
    var count: Int? = nil
    var collapsed: Bool = false
    var onToggle: (() -> Void)? = nil
    @Environment(\.appScale) private var appScale
    @State private var toggleHapticTick = 0

    var body: some View {
        Button {
            toggleHapticTick += 1
            withAnimation(.easeInOut(duration: 0.18)) { onToggle?() }
        } label: {
            HStack(spacing: appScale.scaled(6)) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TWTheme.textTertiary)
                if usesEnsembleGlyph {
                    ProviderGlyphIcon(provider: "ensemble", isEnsemble: true, size: 13)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                }
                Text(title)
                    .font(.subheadline.weight(.semibold))
                if let count, count > 0 {
                    NumericTickText(
                        value: count,
                        font: .caption2.weight(.semibold).monospacedDigit(),
                        color: TWTheme.textTertiary)
                        .padding(.horizontal, appScale.scaled(6))
                        .padding(.vertical, 1)
                        .background(TWTheme.surface3, in: Capsule())
                }
            }
            .foregroundStyle(TWTheme.textSecondary)
            .padding(.horizontal, appScale.scaled(12))
            .padding(.vertical, appScale.scaled(6))
            .modifier(GlassPillBackground())
        }
        .buttonStyle(.plain)
        .disabled(onToggle == nil)
        .motionHaptic(MotionHaptics.selection, trigger: toggleHapticTick)
        .accessibilityLabel(glassPillAccessibilityLabel)
        .accessibilityHint(onToggle != nil ? "Double tap to expand or collapse." : "")
        .accessibilityAddTraits(.isHeader)
    }

    private var glassPillAccessibilityLabel: String {
        var parts = [title]
        if let count, count > 0 {
            parts.append("\(count) items")
        }
        if onToggle != nil {
            parts.append(collapsed ? "collapsed" : "expanded")
        }
        return parts.joined(separator: ", ")
    }
}

/// Capsule chrome for the pill headers: real Liquid Glass where the OS has
/// it, an ultra-thin material capsule with the rim-highlight stroke below.
private struct GlassPillBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            content.glassEffect(.regular, in: Capsule())
        } else {
            content
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(TWTheme.border))
        }
    }
}

struct PillSectionHeader: View {
    let title: String
    var systemImage: String? = nil
    var trailing: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption2)
            }
            // Inline flat header — SF Pro, sentence case (the capsule
            // container + ALL-CAPS treatment read as chrome, not structure).
            Text(title)
                .font(.subheadline.weight(.semibold))
            Spacer(minLength: 4)
            if let trailing {
                Text(trailing)
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(TWTheme.surface3, in: Capsule())
                    .foregroundStyle(TWTheme.textTertiary)
            }
        }
        .foregroundStyle(TWTheme.textSecondary)
        .padding(.vertical, 4)
    }
}

/// Inset rim ring — mirrors the desktop sidebar / composer rim-highlight idiom.
struct RimHighlight: ViewModifier {
    var accent: Color? = nil

    func body(content: Content) -> some View {
        content
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(
                        (accent ?? TWTheme.textPrimary).opacity(0.14),
                        lineWidth: 1)
            )
            .shadow(
                color: (accent ?? TWTheme.textPrimary).opacity(0.06),
                radius: 8, x: 0, y: 0)
    }
}

extension View {
    func rimHighlight(accent: Color? = nil) -> some View {
        modifier(RimHighlight(accent: accent))
    }
}

struct ToolbarIconPillLabel: View {
    let title: String
    let systemImage: String?
    var isActive: Bool = false
    var usesEnsembleGlyph: Bool = false

    init(
        _ title: String, systemImage: String? = nil, isActive: Bool = false,
        usesEnsembleGlyph: Bool = false
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isActive = isActive
        self.usesEnsembleGlyph = usesEnsembleGlyph
    }

    var body: some View {
        Group {
            if usesEnsembleGlyph {
                ProviderGlyphIcon(provider: "ensemble", isEnsemble: true, size: 15)
            } else if let systemImage {
                Image(systemName: systemImage)
            }
        }
            .toolbarIconPillChrome(isActive: isActive)
            .accessibilityLabel(Text(title))
            .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

struct ToolbarIconSegmentLabel: View {
    let title: String
    let systemImage: String
    var isActive: Bool = false
    var leadingDivider: Bool = false

    init(
        _ title: String,
        systemImage: String,
        isActive: Bool = false,
        leadingDivider: Bool = false
    ) {
        self.title = title
        self.systemImage = systemImage
        self.isActive = isActive
        self.leadingDivider = leadingDivider
    }

    var body: some View {
        Label(title, systemImage: systemImage)
            .labelStyle(.iconOnly)
            .toolbarIconSegmentChrome(isActive: isActive, leadingDivider: leadingDivider)
            .accessibilityLabel(Text(title))
            .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

struct ToolbarIconPillGroup<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    var body: some View {
        HStack(spacing: 0) {
            content()
        }
        .toolbarIconPillGroupChrome()
    }
}

private struct ToolbarIconPillChromeModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.appScale) private var appScale
    var isActive: Bool = false

    func body(content: Content) -> some View {
        let isLight = TWThemeStore.shared.systemTheme.isLight
        let fill =
            reduceTransparency
            ? (isLight ? TWTheme.surface1 : TWTheme.surface2)
            : (isLight ? Color.white.opacity(0.80) : Color.black.opacity(0.80))
        let rim = isLight ? Color.black : Color.white
        let symbol = isLight ? Color.black.opacity(0.86) : Color.white.opacity(0.94)
        let shadow = isLight ? Color.black.opacity(0.18) : Color.black.opacity(0.46)
        let topRim = isLight ? rim.opacity(0.36) : rim.opacity(0.60)
        let bottomRim = isLight ? rim.opacity(0.12) : rim.opacity(0.18)
        let accent = TWTheme.chroma1
        let shape = Capsule()

        content
            .font(.system(size: appScale.scaled(15), weight: .semibold))
            .foregroundStyle(symbol)
            .frame(width: appScale.scaled(34), height: appScale.scaled(34))
            .background {
                if !reduceTransparency && TWTheme.composerGlassEnabled {
                    shape.fill(.ultraThinMaterial)
                }
                shape.fill(fill)
            }
            .overlay {
                if isActive {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [
                                    accent.opacity(0.24),
                                    accent.opacity(0.10),
                                    Color.clear
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 29, height: 29)
                }
            }
            .overlay(
                shape.strokeBorder(rim.opacity(isLight ? 0.34 : 0.46), lineWidth: 0.85)
            )
            .overlay {
                if isActive {
                    Circle()
                        .strokeBorder(accent.opacity(0.44), lineWidth: 1)
                        .frame(width: 30, height: 30)
                }
            }
            .overlay(
                shape.inset(by: 0.75)
                    .strokeBorder(
                        LinearGradient(
                            colors: [topRim, rim.opacity(0.08), bottomRim],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1.1
                    )
            )
            .shadow(color: shadow, radius: isLight ? 6 : 8, x: 0, y: 2)
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.42)
    }
}

private struct ToolbarIconPillGroupChromeModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        let isLight = TWThemeStore.shared.systemTheme.isLight
        let fill =
            reduceTransparency
            ? (isLight ? TWTheme.surface1 : TWTheme.surface2)
            : (isLight ? Color.white.opacity(0.80) : Color.black.opacity(0.80))
        let rim = isLight ? Color.black : Color.white
        let shadow = isLight ? Color.black.opacity(0.18) : Color.black.opacity(0.46)
        let shape = Capsule()

        content
            .padding(.horizontal, 1)
            .padding(.vertical, 1)
            .background {
                if !reduceTransparency && TWTheme.composerGlassEnabled {
                    shape.fill(.ultraThinMaterial)
                }
                shape.fill(fill)
            }
            .overlay(
                shape.strokeBorder(rim.opacity(isLight ? 0.34 : 0.46), lineWidth: 0.85)
            )
            .overlay(
                shape.inset(by: 0.75)
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                rim.opacity(isLight ? 0.28 : 0.52),
                                rim.opacity(0.08),
                                rim.opacity(isLight ? 0.10 : 0.16)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1.1
                    )
            )
            .shadow(color: shadow, radius: isLight ? 6 : 8, x: 0, y: 2)
            .contentShape(shape)
    }
}

private struct ToolbarIconSegmentChromeModifier: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled
    var isActive: Bool = false
    var leadingDivider: Bool = false

    func body(content: Content) -> some View {
        let isLight = TWThemeStore.shared.systemTheme.isLight
        let rim = isLight ? Color.black : Color.white
        let symbol = isLight ? Color.black.opacity(0.86) : Color.white.opacity(0.94)
        let accent = TWTheme.chroma1

        content
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(symbol)
            // Wider cell than the icon so adjacent segments in a group aren't
            // visually cramped (the icons read as "too close together" at 34pt).
            .frame(width: 40, height: 34)
            .background {
                if isActive {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [
                                    accent.opacity(0.24),
                                    accent.opacity(0.10),
                                    Color.clear
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 29, height: 29)
                }
            }
            .overlay {
                if isActive {
                    Circle()
                        .strokeBorder(accent.opacity(0.44), lineWidth: 1)
                        .frame(width: 30, height: 30)
                }
            }
            .overlay(alignment: .leading) {
                if leadingDivider {
                    Rectangle()
                        .fill(rim.opacity(0.24))
                        .frame(width: 0.5, height: 20)
                }
            }
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.42)
    }
}

extension View {
    func toolbarIconPillChrome(isActive: Bool = false) -> some View {
        modifier(ToolbarIconPillChromeModifier(isActive: isActive))
    }

    func toolbarIconPillGroupChrome() -> some View {
        modifier(ToolbarIconPillGroupChromeModifier())
    }

    func toolbarIconSegmentChrome(
        isActive: Bool = false,
        leadingDivider: Bool = false
    ) -> some View {
        modifier(
            ToolbarIconSegmentChromeModifier(
                isActive: isActive,
                leadingDivider: leadingDivider
            )
        )
    }
}

private struct SidebarInnerRimModifier: ViewModifier {
    @Environment(\.horizontalSizeClass) private var sizeClass
    let edge: HorizontalEdge

    func body(content: Content) -> some View {
        content
            .overlay(alignment: edge == .leading ? .leading : .trailing) {
                if sizeClass == .regular {
                    SidebarInnerRim(edge: edge)
                        .allowsHitTesting(false)
                }
            }
    }
}

private struct SidebarInnerRim: View {
    let edge: HorizontalEdge

    var body: some View {
        let isLight = TWThemeStore.shared.systemTheme.isLight
        let line = isLight ? Color.black.opacity(0.12) : Color.white.opacity(0.14)
        let glow = isLight ? Color.black.opacity(0.055) : Color.white.opacity(0.12)
        ZStack(alignment: edge == .leading ? .leading : .trailing) {
            LinearGradient(
                colors: edge == .leading ? [glow, .clear] : [.clear, glow],
                startPoint: .leading,
                endPoint: .trailing
            )
            .frame(width: 14)
            Rectangle()
                .fill(line)
                .frame(width: 0.5)
        }
        .frame(width: 14)
        .frame(maxHeight: .infinity)
    }
}

extension View {
    func iPadSidebarInnerRim(edge: HorizontalEdge) -> some View {
        modifier(SidebarInnerRimModifier(edge: edge))
    }
}

// ── Composer shell glass (thread dock) ─────────────────────────────────────
// Frost is constrained to the 16pt shell — material is filled *in* the shape,
// composited, then clipped so nothing bleeds into safeAreaInset margins.
// Inner rows stay clear. Falls back to opaque surfaces when Reduce
// Transparency is enabled.

private struct ComposerShellGlassModifier: ViewModifier {
    var cornerRadius: CGFloat = 16

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        // Rim: top-lit gradient stroke (desktop composer parity) — light
        // themes invert to a subtle dark rim.
        let rimTop: Color =
            TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.10) : Color.white.opacity(0.18)
        let rimBottom: Color =
            TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.02) : Color.white.opacity(0.02)
        Group {
            if TWTheme.composerGlassEnabled {
                if #available(iOS 26.0, macOS 26.0, *) {
                    content
                        .background(shape.fill(TWTheme.composerBg.opacity(0.18)))
                        .glassEffect(.regular, in: shape)
                } else {
                    content
                        .background {
                            shape
                                .fill(.ultraThinMaterial)
                                .overlay(
                                    shape.fill(
                                        TWTheme.composerBg.opacity(
                                            TWTheme.composerGlassTintOpacity)))
                        }
                }
            } else {
                content
                    .background(shape.fill(TWTheme.composerBg))
            }
        }
        .compositingGroup()
        .mask(shape)
        .overlay(shape.strokeBorder(TWTheme.border, lineWidth: 1))
        .overlay(
            shape.inset(by: 0.5)
                .strokeBorder(
                    LinearGradient(
                        colors: [rimTop, rimBottom],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
        )
    }
}

@MainActor
func composerAttachedRowFill() -> AnyShapeStyle {
    if TWTheme.composerGlassEnabled {
        return AnyShapeStyle(Color.clear)
    }
    return AnyShapeStyle(TWTheme.surface1)
}

@MainActor
func composerInputRowFill() -> AnyShapeStyle {
    AnyShapeStyle(TWTheme.surface2.opacity(TWTheme.composerGlassEnabled ? 0.86 : 0.72))
}

extension View {
    /// Frosted glass + border clipped to the composer shell bounds.
    func composerShellGlass(cornerRadius: CGFloat = 16) -> some View {
        modifier(ComposerShellGlassModifier(cornerRadius: cornerRadius))
    }
}

// ── Sheet liquid glass (B spec) ───────────────────────────────────────────
// Sheet-presentation sibling of composerShellGlass — same tier constants,
// applied via presentationBackground on iOS sheets.

#if os(iOS)
    /// Clears opaque system List/Form/Navigation hosts that otherwise paint
    /// over `presentationBackground` glass. Intentionally does **not** walk
    /// every superview wiping `backgroundColor` — that path also hits
    /// `UIVisualEffectView` / sheet presentation layers and collapses liquid
    /// glass into an opaque gray plate.
    private struct TWClearGlassHostBackground: UIViewRepresentable {
        func makeUIView(context: Context) -> UIView {
            let view = UIView()
            view.isUserInteractionEnabled = false
            view.backgroundColor = .clear
            view.isOpaque = false
            return view
        }

        func updateUIView(_ uiView: UIView, context: Context) {
            DispatchQueue.main.async {
                Self.clearOpaqueGlassHosts(from: uiView)
            }
        }

        private static func clearOpaqueGlassHosts(from uiView: UIView) {
            func shouldSkip(_ view: UIView) -> Bool {
                if view is UIVisualEffectView { return true }
                let name = String(describing: type(of: view))
                // Presentation/glass material hosts must keep their effect layers.
                if name.contains("VisualEffect")
                    || name.contains("Glass")
                    || name.contains("Material")
                    || name.contains("UIDropShadow")
                {
                    return true
                }
                return false
            }

            func clearListHosts(in root: UIView) {
                if shouldSkip(root) { return }
                if let table = root as? UITableView {
                    table.backgroundColor = .clear
                    table.isOpaque = false
                    table.backgroundView = nil
                    table.sectionIndexBackgroundColor = .clear
                }
                if let collection = root as? UICollectionView {
                    collection.backgroundColor = .clear
                    collection.isOpaque = false
                    collection.backgroundView = nil
                }
                for child in root.subviews {
                    clearListHosts(in: child)
                }
            }

            func clearControllerView(_ view: UIView) {
                if shouldSkip(view) { return }
                view.backgroundColor = .clear
                view.isOpaque = false
                clearListHosts(in: view)
            }

            // Near ancestors only (hosting + scroll wrappers) — stop before
            // window / sheet presentation chrome.
            var node: UIView? = uiView
            var depth = 0
            while let current = node, depth < 8 {
                if current is UIWindow { break }
                let name = String(describing: type(of: current))
                if name.contains("Presentation") || name.contains("SheetContainer") {
                    break
                }
                if !shouldSkip(current) {
                    let isHost =
                        depth <= 3
                        || current is UITableView
                        || current is UICollectionView
                        || current is UIScrollView
                        || name.contains("Hosting")
                        || name.contains("Navigation")
                        || name.contains("UIKit")
                    if isHost {
                        current.backgroundColor = .clear
                        current.isOpaque = false
                        if let table = current as? UITableView {
                            table.backgroundView = nil
                            table.sectionIndexBackgroundColor = .clear
                        }
                        if let collection = current as? UICollectionView {
                            collection.backgroundView = nil
                        }
                    }
                }
                node = current.superview
                depth += 1
            }

            var responder: UIResponder? = uiView.next
            while let current = responder {
                if current is UIWindow { break }
                if let controller = current as? UIViewController {
                    clearControllerView(controller.view)
                    if let nav = controller as? UINavigationController {
                        clearControllerView(nav.view)
                        for child in nav.viewControllers {
                            clearControllerView(child.view)
                        }
                    }
                    if let nav = controller.navigationController {
                        clearControllerView(nav.view)
                    }
                }
                responder = current.next
            }
        }
    }

    /// One backdrop shared by sheet and full-screen-cover presentations.
    ///
    /// This view must live inside presented content over a clear presentation
    /// host. A glassEffect placed in `presentationBackground` samples the
    /// sheet container's neutral backing instead of the presenting transcript,
    /// reproducing the opaque gray plate.
    private struct TWSheetGlassBackdrop: View {
        var cornerRadius: CGFloat
        var rimmed: Bool

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            let isLight = TWThemeStore.shared.systemTheme.isLight
            let rimTop: Color =
                isLight ? Color.black.opacity(0.10) : Color.white.opacity(0.18)
            let rimBottom: Color =
                isLight ? Color.black.opacity(0.02) : Color.white.opacity(0.02)
            // Every iOS presentation owns the same adaptive theme wash. The
            // fill is deliberately translucent so Liquid Glass can still
            // refract/blur the presenting view, while text never rides the
            // nearly bare background exposed by full-screen covers.
            let backdropFill = TWTheme.appBg.opacity(
                TWGlassSheetSurfacePolicy.backdropFillAlpha(
                    glassEnabled: TWTheme.composerGlassEnabled))

            Group {
                if !TWTheme.composerGlassEnabled {
                    shape.fill(backdropFill)
                } else if #available(iOS 26.0, macOS 26.0, *) {
                    shape
                        .fill(Color.clear)
                        .glassEffect(.clear, in: shape)
                        // The theme colour belongs above the sampled glass so
                        // 0.72 means the same thing for every host.
                        .overlay(shape.fill(backdropFill))
                } else {
                    shape
                        .fill(.ultraThinMaterial)
                        .overlay(shape.fill(backdropFill))
                }
            }
            .ignoresSafeArea()
            .overlay { rimOverlay(shape: shape, rimTop: rimTop, rimBottom: rimBottom) }
        }

        @ViewBuilder
        private func rimOverlay(shape: RoundedRectangle, rimTop: Color, rimBottom: Color) -> some View {
            if rimmed {
                shape.strokeBorder(TWTheme.border, lineWidth: 1)
                shape.inset(by: 0.5)
                    .strokeBorder(
                        LinearGradient(
                            colors: [rimTop, rimBottom],
                            startPoint: .top,
                            endPoint: .bottom),
                        lineWidth: 1)
            }
        }
    }

    private struct TWSheetGlassSurfaceModifier: ViewModifier {
        var cornerRadius: CGFloat
        var rimmed: Bool

        func body(content: Content) -> some View {
            content.background {
                TWSheetGlassBackdrop(cornerRadius: cornerRadius, rimmed: rimmed)
            }
        }
    }
#endif

private struct TWGlassSheetHostedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// True for content hosted inside a `twSheetLiquidGlass` or
    /// `twFullScreenLiquidGlass` presentation. A full-bleed opaque canvas
    /// smothers the glass backdrop, so panes shared with non-glass hosts
    /// (e.g. iPad Diff Studio split) check this to keep glass covers transparent
    /// while non-glass hosts keep the opaque app canvas.
    var twGlassSheetHosted: Bool {
        get { self[TWGlassSheetHostedKey.self] }
        set { self[TWGlassSheetHostedKey.self] = newValue }
    }
}

/// Chrome wash for surfaces riding the glass sheet backdrop, shared by every
/// glass-hosted sheet (Diff Studio's DiffStudioSheetGlassPolicy delegates its
/// chrome tier here).
enum TWGlassSheetSurfacePolicy {
    /// Adaptive app-background wash under every iOS sheet, full-screen cover,
    /// popover and picker glass surface. The theme supplies the light/dark
    /// colour; one alpha keeps presentation hosts visually consistent.
    static let standardBackdropFillAlpha = 0.72

    static func backdropFillAlpha(glassEnabled: Bool) -> Double {
        glassEnabled ? standardBackdropFillAlpha : 1.0
    }

    /// Alpha for chrome surfaces (list/form rows, cards, header bars) over the
    /// glass backdrop; nil keeps the host's default opaque fill. Reduce
    /// Transparency (glassEnabled false) keeps surfaces fully opaque over the
    /// backdrop's opaque tier.
    ///
    /// Light-family themes need a much heavier wash than dark ones: `surface1`
    /// is near-white there, so at the dark-tuned 0.35 alpha a row reads as
    /// indistinguishable from the equally pale glass backdrop behind it —
    /// rows lose their card separation and the whole sheet reads as flat gray.
    /// Dark themes don't have this problem (a dark wash over a dark backdrop
    /// still shows up), so only the light path is bumped — mirrors
    /// `ToolbarIconPillChromeModifier`'s isLight ? white.opacity(0.80) split.
    static func chromeFillAlpha(glassSheetHosted: Bool, glassEnabled: Bool, isLight: Bool = false) -> Double? {
        guard glassSheetHosted else { return nil }
        guard glassEnabled else { return 1.0 }
        return isLight ? 0.72 : 0.35
    }
}

/// Translucent row/card fill over the glass sheet backdrop; nil = keep the
/// system default fill (content not glass-hosted).
@MainActor
func twGlassSheetChromeFill(glassSheetHosted: Bool) -> Color? {
    guard
        let alpha = TWGlassSheetSurfacePolicy.chromeFillAlpha(
            glassSheetHosted: glassSheetHosted,
            glassEnabled: TWTheme.composerGlassEnabled,
            isLight: TWThemeStore.shared.systemTheme.isLight)
    else { return nil }
    return TWTheme.surface1.opacity(alpha)
}

private struct TWGlassSheetRowBackgroundModifier: ViewModifier {
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    func body(content: Content) -> some View {
        content.listRowBackground(twGlassSheetChromeFill(glassSheetHosted: glassSheetHosted))
    }
}

private struct TWGlassSheetListCanvasModifier: ViewModifier {
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    @ViewBuilder
    func body(content: Content) -> some View {
        // Hide the opaque system List canvas and keep the host clear so the
        // liquid-glass presentationBackground reads through empty areas.
        if glassSheetHosted {
            content
                .scrollContentBackground(.hidden)
                .background(Color.clear)
        } else {
            content.scrollContentBackground(.automatic)
        }
    }
}

extension View {
    /// Attach to List/Form Sections inside a `twSheetLiquidGlass` sheet:
    /// translucent chrome wash over the glass; system row fill elsewhere.
    func twGlassSheetRowBackground() -> some View {
        modifier(TWGlassSheetRowBackgroundModifier())
    }

    /// Attach to the List/Form itself: clears the opaque scroll canvas so the
    /// glass backdrop reads through; keeps the system canvas elsewhere.
    func twGlassSheetListCanvas() -> some View {
        modifier(TWGlassSheetListCanvasModifier())
    }
}

extension View {
    /// Shared host hygiene for liquid-glass presentations: clear UIKit nav/
    /// hosting backgrounds so `presentationBackground` glass is not covered by
    /// system gray, and stamp `twGlassSheetHosted` for content panes.
    @ViewBuilder
    fileprivate func twGlassPresentationHostChrome() -> some View {
        #if os(iOS)
            self
                .toolbarBackground(.hidden, for: .navigationBar)
                .background(Color.clear)
                .background(TWClearGlassHostBackground())
                .environment(\.twGlassSheetHosted, true)
        #else
            self
        #endif
    }

    /// Liquid-glass sheet chrome. Apply to the root of sheet content (inside
    /// any NavigationStack). iOS-only; non-iOS is pass-through.
    ///
    /// Glass is applied directly to the presented content over a clear
    /// presentation background so it can refract the view behind the sheet.
    @ViewBuilder
    func twSheetLiquidGlass(
        detents: Set<PresentationDetent> = [.medium, .large],
        cornerRadius: CGFloat = 32,
        rimmed: Bool = true
    ) -> some View {
        #if os(iOS)
            self
                .presentationDetents(detents)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(cornerRadius)
                .presentationBackground(.clear)
                .modifier(
                    TWSheetGlassSurfaceModifier(
                        cornerRadius: cornerRadius,
                        rimmed: rimmed))
                .twGlassPresentationHostChrome()
        #else
            self
        #endif
    }

    /// Liquid-glass chrome for fullScreenCover hosts (Diff Studio / Files).
    /// Same transparent + glassEffect surface and `twGlassSheetHosted` flag as
    /// sheets, without presentation detents or sheet corner rims.
    @ViewBuilder
    func twFullScreenLiquidGlass() -> some View {
        #if os(iOS)
            self
                .presentationBackground(.clear)
                .modifier(TWSheetGlassSurfaceModifier(cornerRadius: 0, rimmed: false))
                .twGlassPresentationHostChrome()
        #else
            self
        #endif
    }
}

/// Subtle two-line toolbar title — thread nav, Diff Studio, Files, roster.
public struct TWPrincipalTitle: View {
    let title: String
    let subtitle: String?

    public init(title: String, subtitle: String? = nil) {
        self.title = title
        self.subtitle = subtitle
    }

    public var body: some View {
        VStack(alignment: .center, spacing: 1) {
            Text(title)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.78)
                .truncationMode(.tail)
                .multilineTextAlignment(.center)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                    .truncationMode(.middle)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .accessibilityElement(children: .combine)
    }
}

/// Static formatters for always-visible transcript footer times (C2).
enum TWTranscriptTimestampFormat {
    private static let today: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()
    private static let other: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM, HH:mm"
        return formatter
    }()

    static func footerCaption(iso timestamp: String) -> String? {
        guard let date = twParseISODate(timestamp) else { return nil }
        let formatter = Calendar.current.isDateInToday(date) ? today : other
        return formatter.string(from: date)
    }
}

/// Splits a settled-row speaker tag into display label and optional model chip.
/// Single parse so label and chip can never disagree.
func twSettledRowSpeakerSplit(from speaker: String?) -> (label: String, chip: String?) {
    guard let speaker, !speaker.isEmpty else { return ("", nil) }
    guard let open = speaker.lastIndex(of: "("),
        speaker.hasSuffix(")"),
        open < speaker.index(before: speaker.endIndex)
    else { return (speaker, nil) }
    let model = String(speaker[speaker.index(after: open)..<speaker.index(before: speaker.endIndex)])
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !model.isEmpty else { return (speaker, nil) }
    let label = String(speaker[..<open]).trimmingCharacters(in: .whitespacesAndNewlines)
    return (label.isEmpty ? speaker : label, model)
}

/// Model chip text extracted from a settled-row speaker tag "(Model)" suffix.
func twSettledRowModelChip(from speaker: String?) -> String? {
    twSettledRowSpeakerSplit(from: speaker).chip
}

/// House surface for custom picker panels.
///
/// iOS/macOS 26 gets a compositor-backed Liquid Glass background with the
/// adaptive wash composited above it and picker content above both. Older
/// systems use the real system ultra-thin material; Reduce Transparency gets
/// an opaque theme surface instead of blur.
///
/// `tint` is deliberately optional. Picker call sites can attach semantic
/// accent colour without inventing another material implementation.
private struct TWPickerGlassSurfaceModifier: ViewModifier {
    var tint: Color?
    var cornerRadius: CGFloat
    var interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast

    @ViewBuilder
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        #if os(iOS)
            let legibilityFill = TWTheme.appBg.opacity(
                TWGlassSheetSurfacePolicy.backdropFillAlpha(
                    glassEnabled: !(reduceTransparency || !TWTheme.composerGlassEnabled)))
        #else
            let isLight = TWThemeStore.shared.systemTheme.isLight
            let scrimOpacity = colorSchemeContrast == .increased ? 0.18 : 0.10
            let legibilityFill =
                isLight ? Color.white.opacity(scrimOpacity) : Color.black.opacity(scrimOpacity)
        #endif
        let rimWidth: CGFloat = colorSchemeContrast == .increased ? 1.5 : 1

        if reduceTransparency || !TWTheme.composerGlassEnabled {
            content
                .background {
                    shape
                        .fill(legibilityFill)
                        .overlay {
                            if let tint {
                                shape.fill(tint.opacity(0.12))
                            }
                        }
                }
                .overlay(shape.strokeBorder(TWTheme.border, lineWidth: rimWidth))
        } else if #available(iOS 26.0, macOS 26.0, *) {
            content
                .background {
                    shape
                        .fill(Color.clear)
                        .glassEffect(.clear.tint(tint).interactive(interactive), in: shape)
                        .overlay(shape.fill(legibilityFill))
                }
                .overlay(shape.strokeBorder(TWTheme.border, lineWidth: rimWidth))
        } else {
            content
                .background {
                    shape
                        .fill(.ultraThinMaterial)
                        .overlay(shape.fill(legibilityFill))
                        .overlay {
                            if let tint {
                                shape.fill(tint.opacity(0.10))
                            }
                        }
                }
                .overlay(shape.strokeBorder(TWTheme.border, lineWidth: rimWidth))
        }
    }
}

extension View {
    /// Reusable material/accent surface for custom picker panels.
    func twPickerGlassSurface(
        tint: Color? = nil,
        cornerRadius: CGFloat = 18,
        interactive: Bool = false
    ) -> some View {
        modifier(
            TWPickerGlassSurfaceModifier(
                tint: tint,
                cornerRadius: cornerRadius,
                interactive: interactive))
    }

    /// iOS house chrome for compact popovers that previously painted an
    /// opaque `surface2` rectangle. Other platforms retain that existing
    /// solid surface.
    @ViewBuilder
    func twPopoverGlassSurface(cornerRadius: CGFloat = 14) -> some View {
        #if os(iOS)
            self
                .twPickerGlassSurface(cornerRadius: cornerRadius)
                .presentationBackground(.clear)
        #else
            self.background(TWTheme.surface2)
        #endif
    }
}

/// Hierarchical provider → model menu for phone-sized composer surfaces.
struct ProviderModelPicker: View {
    let catalogs: [ProviderModelCatalog]
    @Binding var provider: String
    @Binding var modelId: String?
    @Binding var reasoningEffort: String?
    @Binding var fastModeEnabled: Bool
    @Binding var kimiThinkingEnabled: Bool
    var allowsProviderChange: Bool = true
    /// Compact trigger — a tiny provider logo + chevron pill (for the unfocused
    /// composer's top-left corner) instead of the full flat-text label. The
    /// popover it opens is identical.
    var compact: Bool = false

    /// How much the compact trigger spells out. A bare provider glyph tells you
    /// the vendor but not WHICH model is about to run, which is the thing worth
    /// confirming before you send.
    enum CompactDetail {
        /// Glyph + chevron only. Ensemble composers speak for a roster rather
        /// than one model, so a single model name there would be a lie.
        case glyphOnly
        /// Glyph + model name. Portrait phone — the composer row has no width
        /// for more without crowding the send controls.
        case model
        /// Glyph + model name + reasoning value in the provider hue. iPad and
        /// landscape phone, where the row has room to spare.
        case modelAndReasoning
    }
    var compactDetail: CompactDetail = .glyphOnly
    @State private var isPresented = false

    private var currentCatalog: ProviderModelCatalog? {
        catalogs.first { $0.provider.lowercased() == provider.lowercased() }
    }
    private var reasoningLabel: String? {
        guard let effort = reasoningEffort,
            !twReasoningOptions(in: currentCatalog, modelId: modelId).isEmpty
        else { return nil }
        // Provider-idiomatic wording on the chip (Claude "Low" vs Codex "Light";
        // Codex "Extra High" vs Claude "Extra"; Kimi's thinking toggle as
        // "Thinking") — mirrors Electron's chip reasoningSuffix. The in-popover
        // ladder keeps its unified Off→Ultracode terms; only this collapsed
        // summary speaks each provider's vocabulary.
        return twReasoningDisplayLabel(effort, provider: provider)
    }

    var body: some View {
        Button {
            isPresented = true
        } label: {
            if compact { compactPickerLabel } else { pickerLabel }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Provider and model")
        .accessibilityValue(providerModelAccessibilityValue)
        // Touch-down open so a focused composer blur cannot cancel the tap
        // before the popover presents (same race as roster chips).
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !isPresented else { return }
                    isPresented = true
                }
        )
        .popover(isPresented: $isPresented) {
            pickerPopover
                .presentationCompactAdaptation(.popover)
                // Clear the system popover chrome so the GlassPopoverPanel's
                // Liquid Glass blurs the real content behind the whole picker
                // (otherwise it just frosts an opaque popover background).
                .presentationBackground(.clear)
        }
        .onChange(of: provider) { _, newProvider in
            // Switching provider invalidates a model from the OLD catalog —
            // reset to nil (= inherit on existing chats / provider default
            // on new ones, resolved Mac-side). Never force-pick a default:
            // that stamped the catalog default over the chat's real model
            // before the snapshot could land.
            let catalog = catalogs.first {
                $0.provider.lowercased() == newProvider.lowercased()
            }
            if modelId != nil
                && (catalog == nil || !(catalog!.models.contains { $0.id == modelId }))
            {
                modelId = nil
            }
            twNormalizeReasoningSelection(
                catalog: catalog, modelId: modelId, reasoningEffort: &reasoningEffort)
            if newProvider.lowercased() == "kimi" { kimiThinkingEnabled = true }
            normalizeFastModeSelection(catalog: catalog, modelId: modelId)
        }
        .onChange(of: modelId) { _, _ in
            twNormalizeReasoningSelection(
                catalog: currentCatalog, modelId: modelId, reasoningEffort: &reasoningEffort)
            if isKimiProvider { kimiThinkingEnabled = true }
            normalizeFastModeSelection(catalog: currentCatalog, modelId: modelId)
        }
        .onAppear {
            twNormalizeReasoningSelection(
                catalog: currentCatalog, modelId: modelId, reasoningEffort: &reasoningEffort)
            normalizeFastModeSelection(catalog: currentCatalog, modelId: modelId)
        }
    }

    // A nil modelId means "inherit / provider default". We no longer offer a
    // synthetic "Default" row, so resolve nil -> the catalog's concrete
    // isDefault model for DISPLAY only. Dispatch keeps sending nil (the Mac
    // inherits + normalizes), so this never stamps a concrete id onto the chat.
    private var resolvedDefaultModel: ModelOption? {
        currentCatalog?.models.first(where: { $0.isDefault == true })
            ?? currentCatalog?.models.first
    }
    private var displayModelId: String? { modelId ?? resolvedDefaultModel?.id }
    private var displayModelLabel: String? {
        if let modelId { return shortModelLabel(modelId) }
        return resolvedDefaultModel.map { $0.label ?? $0.id }
    }

    private var providerModelAccessibilityValue: String {
        let modelLabel = displayModelLabel ?? "default model"
        let providerName = TWTheme.providerLabel(
            provider, modelId: displayModelId, modelLabel: displayModelLabel)
        var value = "\(providerName), \(modelLabel)"
        if let reasoningLabel {
            value += ", \(reasoningLabel) reasoning"
        }
        return value
    }

    /// Tiny pill for the unfocused composer's top-left corner: the first-party
    /// provider logo + a chevron in a small capsule. Opens the same picker popover.
    private var compactPickerLabel: some View {
        let modelLabel = displayModelLabel
        return HStack(spacing: compactDetail == .glyphOnly ? 3 : 4) {
            ProviderLogoIcon(
                provider: provider, modelId: displayModelId, size: 12)

            if compactDetail != .glyphOnly, let modelLabel, !modelLabel.isEmpty {
                Text(modelLabel)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                    // Truncate the model name before the composer's send
                    // controls give up any width — this pill is the flexible
                    // element in that row, not them.
                    .layoutPriority(-1)
            }

            if compactDetail == .modelAndReasoning, let reasoningLabel {
                // Same progressive provider-hue treatment as the focused
                // label's suffix; identity keyed on the effort so a tier change
                // restarts its fresh state rather than cross-fading.
                ChipReasoningSuffix(
                    label: reasoningLabel,
                    effort: reasoningEffort,
                    accent: TWTheme.providerAccent(
                        provider, modelId: displayModelId, modelLabel: modelLabel)
                )
                .id(reasoningEffort ?? "")
            }

            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 7, weight: .semibold))
                .foregroundStyle(TWTheme.textMuted)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(Capsule().fill(TWTheme.surface3))
        .overlay(Capsule().strokeBorder(TWTheme.border, lineWidth: 0.5))
        .contentShape(Capsule())
    }

    private var pickerLabel: some View {
        // Flat text labels (desktop composer parity) — the whole run of
        // text is the tap target; no pill chrome. Ollama-backed display
        // brands spoof their upstream brand name + hue (e.g. Qwen → Alibaba)
        // so the pill matches the transcript header and the Mac.
        // Density: caption2 chip keeps the composer chrome compact on phone.
        let modelLabel = displayModelLabel
        return HStack(spacing: 4) {
            ProviderLogoIcon(
                provider: provider, modelId: displayModelId, size: 12)
            Text(TWTheme.providerLabel(provider, modelId: displayModelId, modelLabel: modelLabel))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(
                    TWTheme.providerAccent(provider, modelId: displayModelId, modelLabel: modelLabel))
            Text(modelLabel ?? "")
                .font(.caption2)
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
            if let reasoningLabel {
                // Desktop-parity tier treatment: the suffix takes on the
                // provider hue progressively as effort rises (identity keyed
                // on the effort so a tier change restarts the fresh state).
                ChipReasoningSuffix(
                    label: reasoningLabel,
                    effort: reasoningEffort,
                    accent: TWTheme.providerAccent(
                        provider, modelId: displayModelId, modelLabel: modelLabel)
                )
                .id(reasoningEffort ?? "")
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 7, weight: .semibold))
                .foregroundStyle(TWTheme.textMuted)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    // Compact anchored glass popover replacing the native Menu. Selecting a
    // MODEL keeps the popover open (so the user can pick reasoning without
    // re-summoning); tapping outside dismisses natively and the grabber's
    // swipe-down dismisses. The open panel itself is the shared
    // ProviderModelPickerPanel (also composed by the Ensemble add-participant
    // popover with fields stacked on top, Electron CombinedModelPicker-style).
    @ViewBuilder
    private var pickerPopover: some View {
        ProviderModelPickerPanel(
            catalogs: catalogs,
            provider: $provider,
            modelId: $modelId,
            reasoningEffort: $reasoningEffort,
            fastModeEnabled: $fastModeEnabled,
            kimiThinkingEnabled: $kimiThinkingEnabled,
            allowsProviderChange: allowsProviderChange,
            onDismissRequest: { isPresented = false })
    }

    private var isKimiProvider: Bool { provider.lowercased() == "kimi" }

    private func normalizeFastModeSelection(
        catalog: ProviderModelCatalog?, modelId: String?
    ) {
        twNormalizeFastModeSelection(
            catalog: catalog, modelId: modelId, fastModeEnabled: &fastModeEnabled)
    }

    private func shortModelLabel(_ id: String) -> String {
        if let catalog = currentCatalog,
            let match = catalog.models.first(where: { $0.id == id })
        {
            return match.label ?? id
        }
        if id.count > 22 { return String(id.prefix(20)) + "…" }
        return id
    }

    #if DEBUG
    /// Canvas-only surface: the open glass panel without popover presentation
    /// chrome. Used by `ProviderModelPicker+Previews.swift` so phone vs pad
    /// spacing can be tuned in Xcode without Simulator/device.
    var twCanvasOpenPanel: some View { pickerPopover }
    #endif
}

/// Shared "resolve to the catalog default, then drop Fast off non-capable
/// models" normalization — one implementation for the picker trigger and the
/// open panel so they can't drift.
private func twNormalizeFastModeSelection(
    catalog: ProviderModelCatalog?, modelId: String?, fastModeEnabled: inout Bool
) {
    let resolvedModelId = modelId
        ?? catalog?.models.first(where: { $0.isDefault == true })?.id
        ?? catalog?.models.first?.id
    if !twModelUsesFastToggle(resolvedModelId) {
        fastModeEnabled = false
    }
}

/// Grabber block of the picker panel: 4pt capsule + 6pt above + 1pt below.
/// File scope because `ProviderModelPickerPanel` is generic over its
/// `topContent`, and generic types cannot hold static stored properties.
/// Module-scope rather than file-private so the height clamp below — and its
/// tests — can charge for it without re-typing the number.
let twPickerGrabberHeight: CGFloat = 11

/// Vertical room for a popover balloon PINNED to one side of its anchor.
///
/// Pure geometry (window numbers in, points out) so the rule is unit-testable
/// without a live `UIWindow`; `TWPopoverSpace` supplies the real numbers.
///
/// `arrowEdge` names the edge of the POPOVER that carries the arrow, so
/// `.bottom` means the panel sits ABOVE its anchor and `.top` means below it.
/// A pinned balloon cannot use the whole safe height — only the gap on the side
/// it opens toward — and that difference is what broke the composer's roster
/// chip with the keyboard up: "safe height minus keyboard" reads ~390pt on a
/// 6.3" phone, while a chip pinned to the top of a keyboard-raised composer has
/// barely 200pt above it. The panel took its full ~300pt, the system clipped
/// the overflow at BOTH ends (a fixed-size popover child is centred in whatever
/// bounds it is actually given), and the rows inside the clipped band could not
/// be scrolled back into view: the list scrolls inside a viewport whose top is
/// off the balloon entirely.
///
/// The upward case carries no keyboard term BY DESIGN. The keyboard raises the
/// composer and therefore the anchor, and this measures the anchor — charging
/// for the keyboard again would bill it twice and starve the panel. Downward is
/// the opposite: there the keyboard is exactly the floor the balloon grows into.
///
/// `sideAnchoredHeight` answers `.leading`/`.trailing`: a side-anchored balloon
/// is centred vertically on its anchor and grows both ways, so the whole safe
/// height genuinely is available (the iPad roster-editor fix).
func twPopoverAnchoredHeight(
    anchorMinY: CGFloat,
    anchorMaxY: CGFloat,
    arrowEdge: Edge,
    safeTopY: CGFloat,
    safeBottomY: CGFloat,
    sideAnchoredHeight: CGFloat,
    chromeAllowance: CGFloat
) -> CGFloat {
    switch arrowEdge {
    case .bottom:
        // Balloon above the anchor: ceiling is the top of the safe area.
        return max(0, anchorMinY - safeTopY - chromeAllowance)
    case .top:
        // Balloon below the anchor: floor is the keyboard, or the bottom safe
        // inset when it is down (both folded into `safeBottomY`).
        return max(0, safeBottomY - anchorMaxY - chromeAllowance)
    case .leading, .trailing:
        return sideAnchoredHeight
    }
}

/// `ProviderModelPickerPanel`'s body height, clamped to the room its balloon
/// actually has. Split out of the view so the arithmetic is greppable and
/// testable rather than re-derived at each seam.
func twPickerClampedBodyHeight(
    requested: CGFloat,
    available: CGFloat,
    contentScale: CGFloat,
    grabberHeight: CGFloat = twPickerGrabberHeight
) -> CGFloat {
    // Undo the scale first: the budget is in SCREEN points but this height is
    // pre-scale, so a 0.70 panel may legitimately be ~43% taller here than the
    // space it will ultimately occupy. The grabber rides above the body inside
    // the same balloon, so it is charged to the same budget. The 44 keeps a
    // degenerate anchor (a budget at or below the grabber's own height) from
    // handing SwiftUI a negative frame.
    let cap = max(44, (available / max(contentScale, 0.01)) - grabberHeight)
    // The 200 floor keeps a merely-cramped panel usable — the list scrolls, so
    // height given up costs scrolling, never access. It must never win against
    // the cap itself, though: a floor that overshoots the room the balloon has
    // re-creates the clip it exists to prevent.
    return max(min(200, cap), min(requested, cap))
}

#if canImport(UIKit)
    /// App-lifetime keyboard height.
    ///
    /// MUST outlive any one view. A `.onReceive` attached to popover content
    /// only ever sees keyboard CHANGES that happen while that popover is open —
    /// and the keyboard is virtually always already up by the time you tap a
    /// roster chip, so such an observer reports 0 forever and any clamp built
    /// on it silently never engages. That is a failure mode with no symptom
    /// except the bug it was supposed to fix still happening.
    @MainActor
    final class TWKeyboardTracker {
        static let shared = TWKeyboardTracker()

        /// Touch early — from a view that is alive BEFORE the keyboard first
        /// rises. `shared` is lazy, so if the first access is the popover
        /// itself the observers register too late to have seen the keyboard go
        /// up and the height reads 0: the very bug this class exists to avoid,
        /// just moved. Idempotent; call it as often as convenient.
        func start() {}

        /// Main-actor isolated; the observers below hop onto it explicitly.
        private(set) var height: CGFloat = 0

        private init() {
            let center = NotificationCenter.default
            center.addObserver(
                forName: UIResponder.keyboardWillChangeFrameNotification,
                object: nil, queue: .main
            ) { [weak self] note in
                let frame =
                    (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect) ?? .zero
                // A keyboard parked off the bottom edge is a dismissal, not a
                // full-height keyboard.
                // Delivered on .main by the queue argument, but the closure is
                // nonisolated as far as the compiler is concerned.
                MainActor.assumeIsolated {
                    let screenHeight = UIScreen.main.bounds.height
                    self?.height = frame.origin.y >= screenHeight ? 0 : frame.height
                }
            }
            center.addObserver(
                forName: UIResponder.keyboardWillHideNotification,
                object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.height = 0 }
            }
        }
    }

    /// How much vertical room a popover panel actually has.
    ///
    /// Exists because a `.popover` will not scroll, shrink or scroll-to-fit its
    /// content: hand it a panel taller than the space available and the system
    /// clips it, silently and without a scroll affordance. Any panel with a
    /// fixed body height therefore has to bound itself, and the bound has to
    /// account for the keyboard — which is the case that actually broke (the
    /// roster editor's top row disappeared only with the keyboard up).
    @MainActor
    enum TWPopoverSpace {
        /// Popover arrow, balloon inset and a little breathing room, so the
        /// panel stops short of the safe-area edge rather than butting it.
        private static let chromeAllowance: CGFloat = 56

        private static var keyWindow: UIWindow? {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first { $0.isKeyWindow }
        }

        /// The safe-area budget: right for a balloon that can grow BOTH ways
        /// from its anchor (side-anchored), and a generous over-estimate for one
        /// pinned above or below it — use `availableHeight(anchor:…)` there.
        static func availableHeight(keyboardHeight: CGFloat) -> CGFloat {
            guard let window = keyWindow else { return 420 }
            let safe =
                window.bounds.height - window.safeAreaInsets.top - window.safeAreaInsets.bottom
            // Never return something so small the panel becomes unusable; below
            // this the list scrolls and that is the correct trade.
            return max(240, safe - keyboardHeight - chromeAllowance)
        }

        /// Room for a balloon opening from `anchor` (GLOBAL/window coordinates)
        /// toward `arrowEdge`. See `twPopoverAnchoredHeight` for the rule, and
        /// for why the anchor rather than the safe area is the quantity that
        /// matters once a popover is pinned to one side.
        static func availableHeight(
            anchor: CGRect, arrowEdge: Edge, keyboardHeight: CGFloat
        ) -> CGFloat {
            guard let window = keyWindow else {
                return availableHeight(keyboardHeight: keyboardHeight)
            }
            return twPopoverAnchoredHeight(
                anchorMinY: anchor.minY,
                anchorMaxY: anchor.maxY,
                arrowEdge: arrowEdge,
                safeTopY: window.safeAreaInsets.top,
                safeBottomY: window.bounds.height
                    - max(keyboardHeight, window.safeAreaInsets.bottom),
                sideAnchoredHeight: availableHeight(keyboardHeight: keyboardHeight),
                chromeAllowance: chromeAllowance)
        }
    }
#endif

/// The OPEN glass panel of the combined provider/model/reasoning picker —
/// provider-grouped model rows on the left, the reasoning ladder + Fast pill
/// sidecar on the right, a swipe-down grabber on top.
///
/// Hosted two ways (Electron `CombinedModelPicker` parity):
/// - by `ProviderModelPicker`'s anchored popover (the composer picker), and
/// - by the Ensemble add-participant popover, which stacks the participant
///   fields cluster above the model rows (`topContent`) and confirms with an
///   `Add` button under the sidecar (`confirmLabel`/`onConfirm`).
///
/// Selecting a model NEVER dismisses (reasoning usually comes next — the
/// standing picker landmine); dismissal is tap-away or the grabber, routed
/// through `onDismissRequest` so each host closes its own presentation.
struct ProviderModelPickerPanel<TopContent: View>: View {
    let catalogs: [ProviderModelCatalog]
    @Binding var provider: String
    @Binding var modelId: String?
    @Binding var reasoningEffort: String?
    @Binding var fastModeEnabled: Bool
    @Binding var kimiThinkingEnabled: Bool
    var allowsProviderChange: Bool = true
    /// List-column width override (nil = the composer picker's compact 200/208).
    var listWidth: CGFloat? = nil
    /// Fixed body height when the sidecar shows / overall cap. Defaults match
    /// the composer picker; the add-participant popover passes taller values
    /// to fit its fields cluster.
    var bodyHeight: CGFloat = 276
    var bodyMaxHeight: CGFloat = 308
    /// Uniform scale for the whole panel — chrome, layout and the literal font
    /// sizes together. 1 leaves the panel untouched; the roster popovers pass
    /// 0.85 so the participant editor fits alongside its sidecar.
    var contentScale: CGFloat = 1
    /// Vertical room (in SCREEN points) the host measured for this panel's
    /// balloon. Only the host knows where its anchor sits and which way the
    /// popover opens, and for a balloon pinned to one side that gap — not the
    /// safe area — is the real budget. nil = unmeasured; fall back to the
    /// safe-area estimate, which is honest only for side-anchored balloons.
    var spaceBudget: CGFloat? = nil
    /// Keep the reasoning/Fast sidecar mounted even when the current model has
    /// neither (a dimmed, disabled rail) — the participant popovers use this so
    /// the effort ladder is a constant fixture of the surface, not a column
    /// that pops in and out per model.
    var alwaysShowsSidecar: Bool = false
    /// Render the Fast pill greyed-out + inert (instead of hidden) when the
    /// current model has no Fast tier — with `alwaysShowsSidecar` this keeps
    /// the sidecar's control set stable across model taps.
    var showsDisabledFastPill: Bool = false
    /// Extra sidecar control under the Fast pill (the participant popovers'
    /// compact permission picker). Type-erased — it's one small slot.
    var sidecarAccessory: AnyView? = nil
    /// Confirm slot pinned under the sidecar (the add popover's Add button).
    var confirmLabel: String? = nil
    var onConfirm: (() -> Void)? = nil
    var onDismissRequest: () -> Void = {}
    let topContent: TopContent
    @State private var dragOffset: CGFloat = 0

    init(
        catalogs: [ProviderModelCatalog],
        provider: Binding<String>,
        modelId: Binding<String?>,
        reasoningEffort: Binding<String?>,
        fastModeEnabled: Binding<Bool>,
        kimiThinkingEnabled: Binding<Bool>,
        allowsProviderChange: Bool = true,
        listWidth: CGFloat? = nil,
        bodyHeight: CGFloat = 276,
        bodyMaxHeight: CGFloat = 308,
        contentScale: CGFloat = 1,
        spaceBudget: CGFloat? = nil,
        alwaysShowsSidecar: Bool = false,
        showsDisabledFastPill: Bool = false,
        sidecarAccessory: AnyView? = nil,
        confirmLabel: String? = nil,
        onConfirm: (() -> Void)? = nil,
        onDismissRequest: @escaping () -> Void = {},
        @ViewBuilder topContent: () -> TopContent = { EmptyView() }
    ) {
        self.catalogs = catalogs
        self._provider = provider
        self._modelId = modelId
        self._reasoningEffort = reasoningEffort
        self._fastModeEnabled = fastModeEnabled
        self._kimiThinkingEnabled = kimiThinkingEnabled
        self.allowsProviderChange = allowsProviderChange
        self.listWidth = listWidth
        self.bodyHeight = bodyHeight
        self.bodyMaxHeight = bodyMaxHeight
        self.contentScale = contentScale
        self.spaceBudget = spaceBudget
        self.alwaysShowsSidecar = alwaysShowsSidecar
        self.showsDisabledFastPill = showsDisabledFastPill
        self.sidecarAccessory = sidecarAccessory
        self.confirmLabel = confirmLabel
        self.onConfirm = onConfirm
        self.onDismissRequest = onDismissRequest
        self.topContent = topContent()
    }

    private var currentCatalog: ProviderModelCatalog? {
        catalogs.first { $0.provider.lowercased() == provider.lowercased() }
    }
    private var isKimiProvider: Bool { provider.lowercased() == "kimi" }
    private var resolvedDefaultModel: ModelOption? {
        currentCatalog?.models.first(where: { $0.isDefault == true })
            ?? currentCatalog?.models.first
    }
    private var resolvedSelectedModel: ModelOption? {
        guard let currentCatalog else { return nil }
        if let modelId {
            return currentCatalog.models.first { $0.id == modelId }
        }
        return resolvedDefaultModel
    }
    private var selectedModelAccent: Color {
        TWTheme.providerAccent(
            provider,
            modelId: modelId ?? resolvedDefaultModel?.id,
            modelLabel: resolvedSelectedModel?.label)
    }
    private var resolvedListWidth: CGFloat {
        listWidth ?? (showsSidecar ? 200 : 208)
    }

    /// Body height after clamping to what a popover can actually be given.
    ///
    /// A popover does NOT scroll or shrink to fit — hand it content taller than
    /// the space available and the system simply CLIPS it, which is how the
    /// roster editor lost its top row (the Enabled/Auto pills).
    ///
    /// The subtle part, and the thing a first attempt at this got wrong: a
    /// popover must fit ENTIRELY ON ONE SIDE of its anchor. Measuring against
    /// "screen minus keyboard" is measuring the wrong quantity — it leaves a
    /// cap so generous it never engages, while the real constraint (the gap
    /// between the anchor and the screen edge the balloon opens toward) is much
    /// tighter. In iPad landscape with the keyboard up that gap is small enough
    /// to clip a panel the naive cap considered comfortable.
    ///
    /// NOT halved. An earlier version halved this on the reasoning that a
    /// popover must fit on one side of its anchor — true for one opening ABOVE,
    /// which is what forced the roster editor through a gap far shorter than
    /// itself. The real fix was to open that popover to the SIDE instead (see
    /// the `arrowEdge: .leading` on the roster chip): a side-anchored balloon is
    /// centred vertically on its anchor and can grow both ways, so the whole
    /// safe height is genuinely available and halving would only ration space
    /// that exists. The inner list already scrolls, so height given up costs
    /// scrolling, never access.
    ///
    /// Side-anchoring, though, is a REGULAR-WIDTH answer. On a phone the same
    /// popover falls back to `.bottom` (upward from a chip pinned above the
    /// composer), and there the safe-area estimate is not a backstop at all: it
    /// over-states the gap by roughly 2x with the keyboard up, so the clamp
    /// never engaged and the panel was clipped top and bottom exactly as before.
    /// A host that knows its anchor therefore MEASURES the gap and passes
    /// `spaceBudget`; the safe-area estimate remains only for hosts that do not.
    private var resolvedBodyHeight: CGFloat {
        let requested = min(bodyHeight, bodyMaxHeight)
        #if canImport(UIKit)
            let available =
                spaceBudget
                ?? TWPopoverSpace.availableHeight(
                    keyboardHeight: TWKeyboardTracker.shared.height)
            return twPickerClampedBodyHeight(
                requested: requested, available: available, contentScale: contentScale)
        #else
            guard let spaceBudget else { return requested }
            return twPickerClampedBodyHeight(
                requested: requested, available: spaceBudget, contentScale: contentScale)
        #endif
    }

    private var naturalWidth: CGFloat {
        resolvedListWidth + (showsSidecar ? 68 : 0)
    }

    var body: some View {
        // Compact density: tighter list + sidecar so the glass panel sits
        // smaller on phone without losing the ladder / Fast controls.
        VStack(spacing: 0) {
            grabber
            HStack(alignment: .top, spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        topContent
                        if allowsProviderChange {
                            ForEach(catalogs) { catalog in
                                providerSection(catalog)
                            }
                        } else if let catalog = currentCatalog {
                            modelRows(for: catalog)
                        }
                    }
                    .padding(.top, 1)
                    .padding(.bottom, 6)
                }
                .frame(width: resolvedListWidth)
                .frame(maxHeight: .infinity)
                if showsSidecar {
                    reasoningSidecar
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(height: showsSidecar ? resolvedBodyHeight : nil)
            .frame(maxHeight: resolvedBodyHeight)
        }
        .frame(width: naturalWidth)
        .twPickerGlassSurface(cornerRadius: 14)
        // Scale AFTER the glass chrome so the surface, corner radius and every
        // fixed font inside come down together — the panel's type is authored
        // at literal sizes (`.system(size: 10)`), so a Dynamic Type nudge would
        // move almost none of it.
        //
        // Anchor MUST stay .center. scaleEffect does not change the size a view
        // reports, so the compensating frame below centres a still-full-size
        // child inside a scaled-down container; only a centre anchor puts the
        // drawn content where that container actually is. A .top anchor draws it
        // starting half the height difference above the container's top edge.
        .scaleEffect(contentScale, anchor: .center)
        // Without this the panel would still RESERVE its full-size footprint and
        // the popover would clip exactly as before, just with smaller content
        // rattling around inside it.
        .frame(
            width: naturalWidth * contentScale,
            height: showsSidecar
                ? (twPickerGrabberHeight + resolvedBodyHeight) * contentScale : nil)
        .offset(y: dragOffset)
        .opacity(dragOffset > 0 ? max(0.55, 1 - dragOffset / 320) : 1)
        .onAppear {
            // Standalone hosts (the add popover) have no trigger-side
            // normalization pass — run it here; idempotent for the composer.
            twNormalizeReasoningSelection(
                catalog: currentCatalog, modelId: modelId, reasoningEffort: &reasoningEffort)
            twNormalizeFastModeSelection(
                catalog: currentCatalog, modelId: modelId, fastModeEnabled: &fastModeEnabled)
        }
    }

    // Swipe-down grabber: dragging the handle down past ~70pt dismisses (parity
    // with a sheet's pull-to-dismiss), while releasing short springs back. The
    // gesture lives on the grabber only so the model/reasoning list still
    // scrolls normally.
    private var grabber: some View {
        Capsule()
            .fill(TWTheme.textMuted.opacity(0.5))
            .frame(width: 28, height: 4)
            .frame(maxWidth: .infinity)
            .padding(.top, 6)
            .padding(.bottom, 1)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 6)
                    .onChanged { value in
                        dragOffset = max(0, min(value.translation.height, 160))
                    }
                    .onEnded { value in
                        if value.translation.height > 70 {
                            onDismissRequest()
                        }
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                            dragOffset = 0
                        }
                    }
            )
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private func providerSection(_ catalog: ProviderModelCatalog) -> some View {
        let isCurrent = catalog.provider.lowercased() == provider.lowercased()
        let accent = TWTheme.providerAccent(catalog.provider)
        HStack(spacing: 6) {
            ProviderLogoIcon(provider: catalog.provider, size: 12)
            Text(TWTheme.providerLabel(catalog.provider))
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(isCurrent ? accent : TWTheme.textSecondary)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 1)
        modelRows(for: catalog)
    }

    @ViewBuilder
    private func modelRows(for catalog: ProviderModelCatalog) -> some View {
        let isCurrentProvider = catalog.provider.lowercased() == provider.lowercased()
        let defaultModel =
            catalog.models.first(where: { $0.isDefault == true }) ?? catalog.models.first
        let defaultAccent = TWTheme.providerAccent(
            catalog.provider, modelId: defaultModel?.id, modelLabel: defaultModel?.label)
        if catalog.models.isEmpty {
            pickerRow(
                title: "Default",
                selected: isCurrentProvider && modelId == nil,
                accent: defaultAccent
            ) {
                selectProviderDefault(in: catalog)
            }
        } else {
            ForEach(catalog.models) { option in
                let optionAccent = TWTheme.providerAccent(
                    catalog.provider, modelId: option.id, modelLabel: option.label)
                pickerRow(
                    title: option.label ?? option.id,
                    selected: isCurrentProvider
                        && (modelId == option.id || (modelId == nil && option.isDefault == true)),
                    accent: optionAccent,
                    disabled: option.disabled == true,
                    fast: modelSupportsFast(provider: catalog.provider, modelId: option.id)
                ) {
                    selectModel(option, in: catalog)
                }
            }
        }
    }

    // MARK: - Reasoning ladder sidecar
    // Reasoning lives in a vertical gradient "ladder" slider on the panel's
    // right edge (see ReasoningLadder). It reflects the CURRENTLY selected
    // model and updates live as the user taps models.

    private var ladderEffortBinding: Binding<String?> {
        return $reasoningEffort
    }

    private var enabledLadderIndices: Set<Int> {
        var indices = Set<Int>()
        for option in twReasoningOptions(in: currentCatalog, modelId: modelId)
        where option.disabled != true {
            if let i = twLadderIndex(for: option.reasoningEffort, provider: provider) {
                indices.insert(i)
            }
        }
        return indices
    }
    private var showsSidecar: Bool {
        // The confirm slot rides the sidecar, so a pending confirm keeps the
        // column even for a model with neither reasoning nor Fast.
        alwaysShowsSidecar || !enabledLadderIndices.isEmpty || fastControlState != nil
            || onConfirm != nil
    }
    private var currentLadderLabel: String {
        guard !enabledLadderIndices.isEmpty else { return "—" }
        // Clamp to an ENABLED stop so a carried-over disabled effort doesn't
        // mislabel the sidecar header (matches the thumb's clamped position).
        let idx = ReasoningLadder.clampedIndex(
            for: ladderEffortBinding.wrappedValue,
            enabled: enabledLadderIndices,
            provider: provider)
        if isKimiProvider && reasoningEffort?.lowercased() == "on" { return "On" }
        return twLadderStopLabel(idx, provider: provider)
    }

    private var reasoningSidecar: some View {
        VStack(spacing: 6) {
            if !enabledLadderIndices.isEmpty {
                Text(currentLadderLabel)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(selectedModelAccent)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .frame(maxWidth: .infinity)
                ReasoningLadder(
                    enabledIndices: enabledLadderIndices,
                    reasoningEffort: ladderEffortBinding,
                    accent: selectedModelAccent,
                    provider: provider
                )
            } else if alwaysShowsSidecar {
                // No reasoning axis on this model: keep the rail as a dimmed,
                // inert fixture so the surface doesn't reflow per model.
                Text("—")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(TWTheme.textMuted)
                    .frame(maxWidth: .infinity)
                ReasoningLadder(
                    enabledIndices: [],
                    reasoningEffort: .constant(nil),
                    accent: TWTheme.textMuted,
                    provider: provider
                )
                .opacity(0.3)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            } else {
                Spacer(minLength: 0)
            }
            if let fast = fastControlState {
                fastPill(for: fast)
            } else if showsDisabledFastPill {
                // Model has no Fast tier: keep the pill as a greyed, inert
                // fixture so the sidecar's control set never reflows.
                HStack(spacing: 2) {
                    Image(systemName: "bolt.fill").font(.system(size: 7, weight: .bold))
                    Text("Fast").font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(TWTheme.textMuted)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity)
                .overlay(
                    Capsule().strokeBorder(
                        TWTheme.border.opacity(0.6), lineWidth: 0.5))
                .opacity(0.45)
                .accessibilityLabel("Fast mode")
                .accessibilityValue("Unavailable for this model")
            }
            if let sidecarAccessory {
                sidecarAccessory
            }
            if let confirmLabel, let onConfirm {
                Button(action: onConfirm) {
                    Text(confirmLabel)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity)
                        .background(
                            Capsule().fill(selectedModelAccent))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 10)
        .padding(.horizontal, 4)
        .frame(width: 68)
        .overlay(alignment: .leading) {
            Rectangle().fill(TWTheme.border).frame(width: 0.5)
        }
    }

    // MARK: Fast toggle (sidecar, under the ladder)

    /// How Fast is expressed for the current (provider, model): a Bool toggle
    /// (Cursor Grok / capable Claude+Codex), a model swap (Cursor Composer
    /// 2.5 ↔ 2.5 Fast), or permanently-on + locked (Grok). Nil hides the control.
    private enum FastControl: Equatable {
        case toggle(on: Bool)
        case modelSwap(on: Bool, fastId: String, plainId: String)
        case locked
    }
    private var fastControlState: FastControl? {
        let p = provider.lowercased()
        if p == "grok" { return .locked }  // Grok CLI models run permanently Fast
        let mid = (modelId ?? resolvedDefaultModel?.id ?? "").lowercased()
        if p == "cursor" && (mid == "composer-2.5" || mid == "composer-2.5-fast") {
            return .modelSwap(
                on: mid == "composer-2.5-fast", fastId: "composer-2.5-fast", plainId: "composer-2.5")
        }
        return twModelUsesFastToggle(mid) ? .toggle(on: fastModeEnabled) : nil
    }

    @ViewBuilder
    private func fastPill(for state: FastControl) -> some View {
        let accent = selectedModelAccent
        let on: Bool = {
            switch state {
            case .toggle(let v): return v
            case .modelSwap(let v, _, _): return v
            case .locked: return true
            }
        }()
        let locked = state == .locked
        Button {
            switch state {
            case .toggle: fastModeEnabled.toggle()
            case .modelSwap(let v, let fastId, let plainId): modelId = v ? plainId : fastId
            case .locked: break
            }
        } label: {
            HStack(spacing: 2) {
                Image(systemName: "bolt.fill").font(.system(size: 7, weight: .bold))
                Text("Fast").font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(on ? Color.white : TWTheme.textSecondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity)
            .background(Capsule().fill(on ? accent : Color.clear))
            .overlay(Capsule().strokeBorder(on ? Color.clear : TWTheme.border, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .accessibilityLabel(locked ? "Fast mode on (always)" : "Fast mode")
        .accessibilityValue(on ? "On" : "Off")
    }

    /// Models that expose the paid Fast tier — mirrors the Electron picker's
    /// per-model lightning bolt (Grok is always Fast; Cursor Composer 2.5 has a
    /// Fast variant; otherwise the shared twFastToggleModelIds set).
    private func modelSupportsFast(provider: String, modelId: String) -> Bool {
        let p = provider.lowercased()
        let mid = modelId.lowercased()
        if p == "grok" { return true }
        if p == "cursor" && (mid == "composer-2.5" || mid == "composer-2.5-fast") { return true }
        return twModelUsesFastToggle(mid)
    }

    private func pickerRow(
        title: String, selected: Bool, accent: Color, disabled: Bool = false, fast: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            guard !disabled else { return }
            action()
        } label: {
            HStack(spacing: 6) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(disabled ? TWTheme.textSecondary : TWTheme.textPrimary)
                    .lineLimit(1)
                Spacer()
                if fast {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(accent.opacity(0.85))
                }
                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(accent)
                }
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.55 : 1)
    }

    private func selectModel(_ option: ModelOption, in catalog: ProviderModelCatalog) {
        if allowsProviderChange {
            provider = catalog.provider
        }
        modelId = option.id
        twNormalizeReasoningSelection(
            catalog: catalog, modelId: option.id, reasoningEffort: &reasoningEffort)
        // Kimi's thinking Bool re-arms with every (re)selection — the trigger
        // host mirrors this in its own onChange; standalone hosts rely on it.
        if catalog.provider.lowercased() == "kimi" { kimiThinkingEnabled = true }
        twNormalizeFastModeSelection(
            catalog: catalog, modelId: option.id, fastModeEnabled: &fastModeEnabled)
    }

    private func selectProviderDefault(in catalog: ProviderModelCatalog) {
        if allowsProviderChange {
            provider = catalog.provider
        }
        modelId = nil
        reasoningEffort = nil
        fastModeEnabled = false
        if catalog.provider.lowercased() == "kimi" { kimiThinkingEnabled = true }
    }
}

// MARK: - Reasoning ladder (sidecar slider)

/// One fixed stop on the 7-position reasoning ladder. `effort` is the wire value
/// (off/low/medium/high/xhigh/max/ultracode); `label` is the composer's display
/// term (Off/Light/Medium/High/Extra/Max/Ultracode). The top stop's label is
/// the Claude term — Codex renders the same wire token as "Ultra" (the official
/// OpenAI GPT-5.6 tier id), resolved per-provider via `twLadderStopLabel`.
private struct TWReasoningStop: Identifiable {
    let index: Int
    let effort: String
    let label: String
    var id: Int { index }
}

/// Models that expose a Fast tier as a Bool toggle in the composer (desktop
/// capability sets + the requested list). Cursor Composer 2.5 uses a model swap
/// instead (FastControl.modelSwap); Grok is permanently Fast (locked).
private let twFastToggleModelIds: Set<String> = [
    // Codex
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4",
    // Claude (supported Opus base + 1M variants; Fable 5 has no Fast tier)
    "claude-opus-5",
    "claude-opus-4-8", "claude-opus-4-8-1m",
    "claude-opus-4-7", "claude-opus-4-7-1m",
    "claude-opus-4-6", "claude-opus-4-6-1m",
    // Cursor Grok
    "grok-4.6", "cursor-grok-4.5", "grok-4.5",
    // Kimi K2.7 Coding Highspeed
    "kimi-k2.7-code",
]

func twModelUsesFastToggle(_ modelId: String?) -> Bool {
    guard let modelId else { return false }
    return twFastToggleModelIds.contains(
        modelId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
}

/// Picker-wide provider ordering: alphabetical by display label, EXCEPT the
/// non-CLI lanes pin to the tail — host-admitted conditional AntiGravity just
/// above local Ollama. Mirrors the desktop `resolveProviderRows` order rule;
/// shared by every catalog sort site so the surfaces can't drift.
@MainActor
func twProviderPickerOrder(_ lhs: ProviderModelCatalog, _ rhs: ProviderModelCatalog) -> Bool {
    func rank(_ provider: String) -> Int {
        switch provider.lowercased() {
        case "antigravity": return 1
        case "ollama": return 2
        default: return 0
        }
    }
    let lhsRank = rank(lhs.provider)
    let rhsRank = rank(rhs.provider)
    if lhsRank != rhsRank { return lhsRank < rhsRank }
    return TWTheme.providerLabel(lhs.provider) < TWTheme.providerLabel(rhs.provider)
}

/// Builds provider pickers from product offer intent first, then overlays the
/// paired Mac's model catalogs. Empty/transient catalogs must not hide one of
/// the static live providers; conditional AntiGravity remains catalog-backed.
/// Referenced providers (the chat's current selection) always survive so an
/// existing thread can still display what it is bound to.
@MainActor
func twOfferedProviderCatalogs(
    _ providerModels: [String: [ModelOption]],
    including referencedProviderIds: [String] = []
) -> [ProviderModelCatalog] {
    let modelsByProvider = providerModels.reduce(
        into: [String: [ModelOption]]()
    ) { result, entry in
        let provider = entry.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !provider.isEmpty else { return }
        result[provider] = entry.value
    }
    let referenced = referencedProviderIds.map {
        $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
    let providerIds = TWTheme.liveSelectableProviderIds
        .union(modelsByProvider.keys)
        .union(referenced)

    return providerIds
        .filter { provider in
            !provider.isEmpty
                && TWTheme.isProviderOfferedByModelCatalog(
                    provider, models: modelsByProvider[provider] ?? [])
        }
        .map {
            ProviderModelCatalog(provider: $0, models: modelsByProvider[$0] ?? [])
        }
        .sorted(by: twProviderPickerOrder)
}

private let twReasoningStops: [TWReasoningStop] = [
    TWReasoningStop(index: 0, effort: "off", label: "Off"),
    TWReasoningStop(index: 1, effort: "low", label: "Light"),
    TWReasoningStop(index: 2, effort: "medium", label: "Medium"),
    TWReasoningStop(index: 3, effort: "high", label: "High"),
    TWReasoningStop(index: 4, effort: "xhigh", label: "Extra"),
    TWReasoningStop(index: 5, effort: "max", label: "Max"),
    TWReasoningStop(index: 6, effort: "ultracode", label: "Ultracode"),
]

/// Coalesce provider synonyms onto the canonical ladder effort strings.
/// Muse-specific floor/ceiling mapping lives in `twLadderIndex(for:provider:)`
/// so Codex/Pi `minimal` and Mistral `ultra` are not remapped globally.
private func twNormalizeLadderEffort(_ effort: String) -> String {
    switch effort.lowercased() {
    case "extra": return "xhigh"
    case "light": return "low"
    default: return effort.lowercased()
    }
}

/// Map a wire effort onto the shared Off→Ultracode ladder. Muse Meta parks
/// `minimal` at Off (0) and `ultra` at Ultracode (6) without rewriting those
/// tokens for other providers.
func twLadderIndex(for effort: String?, provider: String? = nil) -> Int? {
    guard let effort else { return nil }
    let token = effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if provider?.lowercased() == "muse" {
        if token == "minimal" { return 0 }
        if token == "ultra" { return 6 }
    }
    let normalized = twNormalizeLadderEffort(token)
    if normalized == "on" { return 1 }
    return twReasoningStops.first(where: { $0.effort == normalized })?.index
}
/// Canonical wire token for a ladder stop. Muse Meta uses `minimal`/`ultra`
/// (never `off`/`ultracode`) at the shared floor/ceiling indices.
func twLadderWireEffort(index: Int, provider: String?) -> String {
    if provider?.lowercased() == "muse" {
        switch index {
        case 0: return "minimal"
        case 6: return "ultra"
        default: break
        }
    }
    return twReasoningStops[max(0, min(twReasoningStops.count - 1, index))].effort
}

/// Display label for a ladder stop, resolving Muse floor/ceiling and the top
/// stop's provider-specific name ("Ultra" on Codex/Muse, "Ultracode" elsewhere).
private func twLadderStopLabel(_ index: Int, provider: String?) -> String {
    if provider?.lowercased() == "muse" {
        if index == 0 { return "Minimal" }
        if index == 6 { return "Ultra" }
        if index == 4 { return "Extra High" }
    }
    let stop = twReasoningStops[index]
    guard stop.effort == "ultracode" else { return stop.label }
    return twReasoningDisplayLabel(stop.effort, provider: provider)
}

/// Collapsed picker chip's reasoning suffix — desktop parity with the
/// composer trigger's tiered treatment (08-theme-picker-overrides.css +
/// CombinedModelPicker.tsx): Low/Thinking through High are hue-only ramps of
/// the provider accent (38% → 62% → 84%, High adds weight); Extra (xhigh)
/// wears a gentle 4.6s shimmer sweep plus a 4-dot faint sparkle field;
/// Max/Ultracode get the full-contrast 3.2s sweep plus the dense field.
/// Off/unknown keep the plain muted suffix. Reduce Motion pins the static
/// base hue and freezes the sparkles, matching the desktop's reduce-motion
/// override.
///
/// Module-scope (not file-private) so the ensemble seat strip wears the exact
/// same ladder as the composer trigger — a second copy of this table is how a
/// tier silently stops shimmering on one surface only.
struct ChipReasoningSuffix: View {
    let label: String
    let effort: String?
    let accent: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sweepPhase: CGFloat = 0
    @State private var twinkle = false

    private enum Tier { case low, medium, high, xhigh, top }

    private var tier: Tier? {
        switch (effort ?? "").trimmingCharacters(in: .whitespaces).lowercased() {
        case "low", "light", "on": return .low
        case "medium": return .medium
        case "high": return .high
        case "xhigh", "extra": return .xhigh
        case "max", "ultracode", "ultra": return .top
        default: return nil
        }
    }

    // Well-spread twinkle spots over the suffix bounds (x, y fractions +
    // per-dot delay) — the faint 4-dot field samples every other entry so it
    // still spans the whole run, mirroring FAINT_SPARKLE_INDICES [0,2,4,6].
    private static let sparkleSpots: [(x: CGFloat, y: CGFloat, delay: Double)] = [
        (0.08, 0.22, 0.0), (0.24, 0.68, 1.9), (0.38, 0.18, 0.9), (0.52, 0.74, 2.8),
        (0.64, 0.30, 1.3), (0.76, 0.82, 0.4), (0.88, 0.40, 2.2), (0.97, 0.64, 3.1),
    ]

    var body: some View {
        switch tier {
        case nil:
            suffixText(weight: .regular)
                .foregroundStyle(TWTheme.textSecondary)
        case .low:
            suffixText(weight: .regular)
                .foregroundStyle(TWTheme.mix(accent, 0.38, TWTheme.textPrimary.opacity(0.58)))
        case .medium:
            suffixText(weight: .regular)
                .foregroundStyle(TWTheme.mix(accent, 0.62, TWTheme.textPrimary.opacity(0.62)))
        case .high:
            suffixText(weight: .medium)
                .foregroundStyle(TWTheme.mix(accent, 0.84, TWTheme.textPrimary))
        case .xhigh:
            shimmering(
                base: TWTheme.mix(accent, 0.80, TWTheme.textPrimary),
                highlight: TWTheme.mix(accent, 0.78, .white),
                weight: .medium, period: 4.6, sparkleCount: 4, brilliance: 0.45)
        case .top:
            shimmering(
                base: TWTheme.mix(accent, 0.92, TWTheme.textPrimary),
                highlight: TWTheme.mix(accent, 0.55, .white),
                weight: .semibold, period: 3.2, sparkleCount: 8, brilliance: 0.85)
        }
    }

    private func suffixText(weight: Font.Weight) -> Text {
        Text("· \(label)").font(.caption2.weight(weight))
    }

    private func shimmering(
        base: Color, highlight: Color, weight: Font.Weight, period: Double,
        sparkleCount: Int, brilliance: Double
    ) -> some View {
        suffixText(weight: weight)
            .lineLimit(1)
            .foregroundStyle(base)
            .overlay {
                if !reduceMotion {
                    // 240%-wide gradient swept across the glyphs, masked to the
                    // text — the CSS text-shimmer-sweep twin.
                    GeometryReader { geo in
                        let w = geo.size.width
                        LinearGradient(
                            stops: [
                                .init(color: base, location: 0),
                                .init(color: base, location: 0.34),
                                .init(color: highlight, location: 0.5),
                                .init(color: base, location: 0.66),
                                .init(color: base, location: 1),
                            ],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: w * 2.4, height: geo.size.height)
                        .offset(x: -w * 2.4 + sweepPhase * w * 3.4)
                    }
                    .mask(suffixText(weight: weight).lineLimit(1))
                    .allowsHitTesting(false)
                }
            }
            .overlay {
                GeometryReader { geo in
                    ForEach(0..<sparkleCount, id: \.self) { i in
                        let spot = Self.sparkleSpots[
                            sparkleCount == 4 ? min(i * 2, Self.sparkleSpots.count - 1) : i]
                        Circle()
                            .fill(Color.white)
                            .frame(width: 1.8, height: 1.8)
                            .position(x: spot.x * geo.size.width, y: spot.y * geo.size.height)
                            .opacity(
                                reduceMotion
                                    ? brilliance * 0.5
                                    : (twinkle ? brilliance : brilliance * 0.2)
                            )
                            .animation(
                                reduceMotion
                                    ? nil
                                    : .easeInOut(duration: 1.8)
                                        .repeatForever(autoreverses: true)
                                        .delay(spot.delay),
                                value: twinkle)
                    }
                }
                .allowsHitTesting(false)
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: period).repeatForever(autoreverses: false)) {
                    sweepPhase = 1
                }
                twinkle = true
            }
    }
}

/// Pure visual profile for the ladder's provider-hued effects. Stop 0 (`Off`)
/// remains neutral; ordinal stop 2 (index 1, Low / Kimi Thinking) starts a
/// smooth ramp that reaches full strength and density at the top stop.
struct TWReasoningLadderEffectProfile: Equatable, Sendable {
    let intensity: Double
    let sparkleCount: Int
    let shimmerBandCount: Int

    var isActive: Bool { intensity > 0 }

    static func forIndex(_ index: Int) -> Self {
        let clamped = max(0, min(6, index))
        let sparkleCounts = [0, 3, 5, 8, 11, 13, 16]
        let shimmerBandCounts = [0, 1, 1, 2, 2, 3, 3]
        return Self(
            intensity: Double(clamped) / 6,
            sparkleCount: sparkleCounts[clamped],
            shimmerBandCount: shimmerBandCounts[clamped])
    }
}

/// Vertical gradient "ladder" reasoning slider: 7 fixed stops from Off (bottom,
/// faint gray) to the top 'ultracode' stop (shimmering provider hue; labelled
/// "Ultracode" on Claude, "Ultra" on Codex), mirroring the Electron reasoning
/// picker's gray→provider ramp. The metallic-rect thumb snaps only to the
/// stops the current model actually supports (`enabledIndices`).
private struct ReasoningLadder: View {
    let enabledIndices: Set<Int>
    @Binding var reasoningEffort: String?
    let accent: Color
    let provider: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shimmer: CGFloat = 0
    @State private var twinkle = false
    @State private var pulse = false

    // Sparkle spots inside the active fill: (dx from centre, fraction rising
    // from its bottom, twinkle delay). Prefixes are deliberately well-spread so
    // the sparse Low/Thinking field still spans its short filled region; each
    // higher tier adds density without changing the slow twinkle cadence.
    private static let sparkleSpots:
        [(dx: CGFloat, rise: CGFloat, delay: Double)] = [
            (-6, 0.18, 0.0),
            (7, 0.54, 0.6),
            (-9, 0.84, 1.9),
            (3, 0.34, 1.1),
            (10, 0.72, 2.8),
            (-4, 0.08, 0.4),
            (6, 0.45, 2.2),
            (-8, 0.94, 1.5),
            (9, 0.25, 3.4),
            (0, 0.64, 0.9),
            (-5, 0.13, 4.0),
            (7, 0.78, 2.5),
            (2, 0.39, 3.0),
            (-7, 0.89, 0.2),
            (8, 0.59, 4.3),
            (-3, 0.29, 1.7),
        ]

    private var currentIndex: Int {
        Self.clampedIndex(for: reasoningEffort, enabled: enabledIndices, provider: provider)
    }

    /// The stop the thumb sits on: the current effort's stop when it's enabled,
    /// else the NEAREST enabled stop (a carried-over disabled effort — e.g.
    /// 'xhigh' on Sonnet 4.6 — must never park the thumb on a disabled stop).
    static func clampedIndex(for effort: String?, enabled: Set<Int>, provider: String? = nil) -> Int {
        if let raw = twLadderIndex(for: effort, provider: provider) {
            if enabled.contains(raw) { return raw }
            // Deterministic tie-break to the HIGHER stop (Set iteration order is
            // per-launch random) — matches snap(toY:) + Electron's nearestEnabled.
            if let nearest = enabled.min(by: {
                let d0 = abs($0 - raw), d1 = abs($1 - raw)
                return d0 == d1 ? $0 > $1 : d0 < d1
            }) { return nearest }
        }
        return enabled.min() ?? 0
    }

    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height
            let cx = geo.size.width / 2
            let trackW: CGFloat = 24
            // Coloured fill reaches up to the thumb (its centre offset from the
            // bottom); above that stays the neutral empty rail.
            let fillH = 9 + max(1, h - 18) * CGFloat(currentIndex) / 6
            let effects = TWReasoningLadderEffectProfile.forIndex(currentIndex)
            ZStack {
                // Empty base track (unfilled rail above the thumb).
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .frame(width: trackW, height: h)
                    .position(x: cx, y: h / 2)

                // Provider-hued gradient fill, clipped to BELOW the thumb so the
                // colour emerges as effort climbs.
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(ladderGradient)
                    .frame(width: trackW, height: h)
                    .overlay {
                        // A slow in-fill brightness pulse. It shares the fill's
                        // bottom mask, so no glow leaks into the neutral rail.
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(
                                accent.opacity(
                                    effects.intensity
                                        * (pulse && !reduceMotion ? 0.14 : 0.035)))
                    }
                    .mask(alignment: .bottom) {
                        Rectangle().frame(width: trackW, height: fillH)
                    }
                    .position(x: cx, y: h / 2)
                    .animation(.spring(response: 0.28, dampingFraction: 0.8), value: currentIndex)
                    .animation(
                        reduceMotion
                            ? nil : .easeInOut(duration: 1.8).repeatForever(autoreverses: true),
                        value: pulse
                    )

                // Keep every animated layer mounted from first appearance. If
                // the user opens at Off then slides upward, repeatForever is
                // already running instead of mounting at its completed phase.
                ForEach(0..<3, id: \.self) { bandIndex in
                    let isVisible = bandIndex < effects.shimmerBandCount
                    shimmerBand(
                        fillHeight: fillH, trackW: trackW, bandIndex: bandIndex
                    )
                    .position(x: cx, y: h - fillH / 2)
                    .opacity(
                        isVisible ? effects.intensity * (reduceMotion ? 0.35 : 1) : 0
                    )
                    .animation(.easeOut(duration: 0.3), value: isVisible)
                    .animation(.easeOut(duration: 0.3), value: effects.intensity)
                }

                sparkleField(
                    width: geo.size.width, fillHeight: fillH, effects: effects
                )
                .position(x: cx, y: h - fillH / 2)

                metallicThumb
                    .position(x: cx, y: yFor(currentIndex, height: h))
                    .animation(.spring(response: 0.28, dampingFraction: 0.8), value: currentIndex)
            }
            .frame(width: geo.size.width, height: h)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in snap(toY: value.location.y, height: h) }
            )
        }
        .onAppear {
            if reduceMotion {
                shimmer = 0.5
                twinkle = true
            } else {
                shimmer = 1
                twinkle = true
                pulse = true
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Reasoning effort")
        .accessibilityValue(twLadderStopLabel(currentIndex, provider: provider))
        .accessibilityAdjustableAction { direction in
            let sorted = enabledIndices.sorted()
            guard !sorted.isEmpty else { return }
            let pos = sorted.firstIndex(of: currentIndex)
                ?? sorted.firstIndex(where: { $0 >= currentIndex })
                ?? (sorted.count - 1)
            let next = direction == .increment
                ? min(sorted.count - 1, pos + 1) : max(0, pos - 1)
            reasoningEffort = twLadderWireEffort(index: sorted[next], provider: provider)
        }
    }

    private func yFor(_ index: Int, height: CGFloat) -> CGFloat {
        let inset: CGFloat = 9
        let usable = max(1, height - inset * 2)
        return inset + usable * (1 - CGFloat(index) / 6)
    }

    private func snap(toY y: CGFloat, height: CGFloat) {
        let inset: CGFloat = 9
        let usable = max(1, height - inset * 2)
        let frac = max(0, min(1, 1 - (y - inset) / usable))
        let raw = Int((frac * 6).rounded())
        guard
            let nearest = enabledIndices.min(by: {
                let d0 = abs($0 - raw), d1 = abs($1 - raw)
                return d0 == d1 ? $0 > $1 : d0 < d1
            })
        else { return }
        let effort = twLadderWireEffort(index: nearest, provider: provider)
        if reasoningEffort != effort { reasoningEffort = effort }
    }

    private var metallicThumb: some View {
        RoundedRectangle(cornerRadius: 2.5, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [
                        Color(white: 0.97), Color(white: 0.66),
                        Color(white: 0.88), Color(white: 0.54),
                    ],
                    startPoint: .top, endPoint: .bottom
                )
            )
            .frame(width: 34, height: 12)
            .overlay(
                RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                    .strokeBorder(Color.black.opacity(0.25), lineWidth: 0.5)
            )
            .overlay(
                Rectangle().fill(Color.white.opacity(0.65))
                    .frame(height: 0.5).padding(.horizontal, 5)
            )
            .shadow(color: .black.opacity(0.32), radius: 1.2, y: 0.5)
    }

    private func sparkleField(
        width: CGFloat, fillHeight: CGFloat, effects: TWReasoningLadderEffectProfile
    ) -> some View {
        ZStack {
            ForEach(Array(Self.sparkleSpots.enumerated()), id: \.offset) {
                sparkleIndex, spot in
                let sparkleInset: CGFloat = 3
                let sparkleSpan = max(0, fillHeight - sparkleInset * 2)
                let isVisible = sparkleIndex < effects.sparkleCount
                Circle()
                    .fill(Color.white)
                    .frame(width: 2.5, height: 2.5)
                    .shadow(color: accent.opacity(0.72), radius: 2)
                    .shadow(color: accent.opacity(0.4), radius: 3)
                    .position(
                        x: width / 2 + spot.dx,
                        y: fillHeight - sparkleInset - sparkleSpan * spot.rise
                    )
                    // Full-strength sparkles peak at exactly 50%; lower tiers
                    // taper that peak by their shared intensity.
                    .opacity(
                        isVisible
                            ? (reduceMotion ? 0.22 : (twinkle ? 0.5 : 0.05))
                                * effects.intensity
                            : 0)
                    .animation(
                        reduceMotion
                            ? nil
                            : .easeInOut(duration: 1.8)
                                .repeatForever(autoreverses: true)
                                .delay(spot.delay),
                        value: twinkle
                    )
                    .animation(.easeOut(duration: 0.3), value: isVisible)
                    .animation(.easeOut(duration: 0.3), value: effects.intensity)
                    .allowsHitTesting(false)
            }
        }
        .frame(width: width, height: fillHeight)
        // Clip the sparkle core and its provider-coloured shadows at the thumb.
        // The neutral rail above is always completely untouched.
        .clipped()
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func shimmerBand(
        fillHeight: CGFloat, trackW: CGFloat, bandIndex: Int
    ) -> some View {
        if fillHeight > 0 {
            let bandH = max(14, min(30, fillHeight * 0.34))
            let progress = reduceMotion ? CGFloat(bandIndex + 1) / 4 : shimmer
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            accent.opacity(0),
                            accent,
                            accent.opacity(0),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                )
                .frame(width: trackW, height: bandH)
                .offset(y: -bandH + progress * (fillHeight + bandH))
                .frame(width: trackW, height: fillHeight, alignment: .top)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                .animation(
                    reduceMotion
                        ? nil
                        : .linear(duration: 3.2)
                            .repeatForever(autoreverses: false)
                            .delay(Double(bandIndex) * (3.2 / 3)),
                    value: shimmer
                )
                .allowsHitTesting(false)
        }
    }

    // Provider-hued ramp: neutral grey at Off, a faint accent at Low/Thinking,
    // then progressively richer provider colour through the top stop. Instance
    // member so it can read `accent` (Color.mix is macOS 15+, so we compose
    // with .opacity only).
    private var ladderGradient: LinearGradient {
        LinearGradient(
            stops: [
                Gradient.Stop(color: Color(white: 0.62).opacity(0.40), location: 0.0),
                Gradient.Stop(color: accent.opacity(0.20), location: 0.1666),
                Gradient.Stop(color: accent.opacity(0.36), location: 0.3333),
                Gradient.Stop(color: accent.opacity(0.54), location: 0.50),
                Gradient.Stop(color: accent.opacity(0.72), location: 0.6666),
                Gradient.Stop(color: accent.opacity(0.90), location: 0.8333),
                Gradient.Stop(color: accent, location: 1.0),
            ],
            startPoint: .bottom, endPoint: .top
        )
    }
}

private func twReasoningModelOption(
    in catalog: ProviderModelCatalog?, modelId: String?
) -> ModelOption? {
    guard let catalog else { return nil }
    if let modelId,
        let selected = catalog.models.first(where: { $0.id == modelId })
    {
        return selected
    }
    return catalog.models.first(where: { $0.isDefault == true }) ?? catalog.models.first
}

private func twReasoningOptions(
    in catalog: ProviderModelCatalog?, modelId: String?
) -> [ReasoningEffortOption] {
    twReasoningModelOption(in: catalog, modelId: modelId)?.supportedReasoningEfforts ?? []
}

private func twDefaultReasoningEffort(for option: ModelOption?) -> String? {
    guard let option else { return nil }
    let efforts =
        option.supportedReasoningEfforts?
        .filter { $0.disabled != true }
        .map(\.reasoningEffort) ?? []
    if let defaultEffort = option.defaultReasoningEffort,
        efforts.contains(defaultEffort)
    {
        return defaultEffort
    }
    if efforts.contains("medium") { return "medium" }
    if efforts.contains("off") { return "off" }
    return efforts.first
}

private func twNormalizeReasoningSelection(
    catalog: ProviderModelCatalog?, modelId: String?, reasoningEffort: inout String?
) {
    let option = twReasoningModelOption(in: catalog, modelId: modelId)
    let efforts =
        option?.supportedReasoningEfforts?
        .filter { $0.disabled != true }
        .map(\.reasoningEffort) ?? []
    guard !efforts.isEmpty else {
        reasoningEffort = nil
        return
    }
    if let current = reasoningEffort, efforts.contains(current) { return }
    reasoningEffort = twDefaultReasoningEffort(for: option)
}

/// Provider-idiomatic wording for a reasoning effort token. Module-scope (not
/// file-private) because the ensemble seat strip renders the same vocabulary as
/// the composer chip — one rule, two surfaces.
func twReasoningDisplayLabel(_ effort: String, provider: String?) -> String {
    let providerId = provider?.lowercased()
    let isCodex = providerId == "codex"
    let isMuse = providerId == "muse"
    switch effort.lowercased() {
    case "off": return "Off"
    // Muse Meta floor stop — never "Off"/none on the Meta CLI.
    case "minimal": return "Minimal"
    // Kimi's thinking toggle is a separate input from the effort ladder, but it
    // lands on the same ordinal stop and reads as "Thinking" on the chip. This
    // is the ONE place that rule lives — the composer picker and the seat strip
    // both route through it rather than re-testing the provider at the call site.
    case "on": return providerId == "kimi" ? "Thinking" : "On"
    // Codex names its lowest tier "Light" (both `low` and `light` wire tokens
    // land here); Claude, Grok and Cursor Grok call it "Low". Mirrors Electron's
    // codexReasoningDisplayLabel vs claude/grokReasoningDisplayLabel.
    case "low", "light": return isCodex ? "Light" : "Low"
    case "medium": return "Medium"
    case "high": return "High"
    // Codex + Muse use "Extra High"; Claude renders the same wire token
    // ('xhigh') as "Extra".
    case "xhigh", "extra": return (isCodex || isMuse) ? "Extra High" : "Extra"
    case "max": return "Max"
    // Wire token is 'ultracode' for Codex/Claude; Muse Meta uses wire `ultra`.
    // Both read "Ultra" on Muse/Codex; Claude keeps "Ultracode".
    case "ultracode":
        return isCodex || isMuse ? "Ultra" : "Ultracode"
    case "ultra":
        return "Ultra"
    default:
        return effort.prefix(1).uppercased() + String(effort.dropFirst())
    }
}

private struct ProviderModelPickerSheet: View {
    let catalogs: [ProviderModelCatalog]
    @Binding var provider: String
    @Binding var modelId: String?
    @Binding var reasoningEffort: String?
    var title: String = "Provider & Model"
    var confirmationTitle: String = "Done"
    var dismissesOnSelection: Bool = true
    var allowsProviderChange: Bool = true
    var onConfirm: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted
    /// The combined picker requires Fast/Kimi-thinking bindings; side-chat
    /// creation doesn't persist either yet, so they live as local state (same
    /// non-offer this sheet always had, now just visible in the ladder panel).
    @State private var localFastModeEnabled = false
    @State private var localKimiThinkingEnabled = true

    private var currentCatalog: ProviderModelCatalog? {
        catalogs.first { $0.provider.lowercased() == provider.lowercased() }
    }

    private var canvasFill: Color {
        glassSheetHosted ? Color.clear : TWTheme.appBg
    }

    var body: some View {
        NavigationStack {
            List {
                // Converged on the combined picker: one row opening the same
                // glass panel the composer + roster editor use (provider
                // sections, model rows with Fast lightning, reasoning ladder)
                // — replaces this sheet's bespoke DisclosureGroup tree and
                // plain checkmark reasoning rows.
                Section("Provider · model") {
                    ProviderModelPicker(
                        catalogs: catalogs,
                        provider: $provider,
                        modelId: $modelId,
                        reasoningEffort: $reasoningEffort,
                        fastModeEnabled: $localFastModeEnabled,
                        kimiThinkingEnabled: $localKimiThinkingEnabled,
                        allowsProviderChange: allowsProviderChange)
                }
                .twGlassSheetRowBackground()
            }
            .twGlassSheetListCanvas()
            .scrollContentBackground(.hidden)
            .background(canvasFill)
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmationTitle) {
                        onConfirm?()
                        dismiss()
                    }
                }
            }
            .onAppear { normalizeReasoningSelection() }
            .onChange(of: provider) { _, _ in normalizeReasoningSelection() }
            .onChange(of: modelId) { _, _ in normalizeReasoningSelection() }
        }
        .background(canvasFill)
        // Prefer the caller's `twSheetLiquidGlass` for detents + glass. Keep a
        // local detent fallback for any presentation that omits that chrome.
        #if os(iOS)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        #endif
    }

    private func normalizeReasoningSelection() {
        normalizeReasoningSelection(catalog: currentCatalog, selectedModelId: modelId)
    }

    private func normalizeReasoningSelection(
        catalog: ProviderModelCatalog?, selectedModelId: String?
    ) {
        var next = reasoningEffort
        twNormalizeReasoningSelection(
            catalog: catalog,
            modelId: selectedModelId,
            reasoningEffort: &next)
        reasoningEffort = next
    }
}

/// Wrapping chip row — adaptive grid so provider/participant chips flow to
/// the next line instead of clipping on narrow screens.
public struct FlowChips<Item: Hashable, ChipView: View>: View {
    let items: [Item]
    let chip: (Item) -> ChipView

    public init(items: [Item], @ViewBuilder chip: @escaping (Item) -> ChipView) {
        self.items = items
        self.chip = chip
    }

    public var body: some View {
        // True flow: chips keep their INTRINSIC width with fixed spacing
        // (the adaptive LazyVGrid stretched columns evenly across the row,
        // putting weird gaps between pills).
        TWFlowLayout(spacing: 6) {
            ForEach(items, id: \.self) { item in
                chip(item)
            }
        }
    }
}

/// Minimal wrapping flow layout — intrinsic item sizes, fixed spacing,
/// rows centered within the proposed width.
public struct TWFlowLayout: Layout {
    var spacing: CGFloat = 6

    public init(spacing: CGFloat = 6) { self.spacing = spacing }

    public func sizeThatFits(
        proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                usedWidth = max(usedWidth, x - spacing)
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        usedWidth = max(usedWidth, x - spacing)
        return CGSize(width: min(usedWidth, maxWidth), height: y + rowHeight)
    }

    public func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        let maxWidth = bounds.width
        // First pass: break into rows.
        var rows: [[(LayoutSubviews.Element, CGSize)]] = [[]]
        var x: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                rows.append([])
                x = 0
            }
            rows[rows.count - 1].append((subview, size))
            x += size.width + spacing
        }
        // Second pass: place each row CENTERED.
        var y = bounds.minY
        for row in rows {
            let rowWidth =
                row.reduce(0) { $0 + $1.1.width } + spacing * CGFloat(max(0, row.count - 1))
            let rowHeight = row.map(\.1.height).max() ?? 0
            var rowX = bounds.minX + max(0, (maxWidth - rowWidth) / 2)
            for (subview, size) in row {
                subview.place(
                    at: CGPoint(x: rowX, y: y + (rowHeight - size.height) / 2),
                    proposal: ProposedViewSize(size))
                rowX += size.width + spacing
            }
            y += rowHeight + spacing
        }
    }
}

public struct ActivityHeatmapEvent: Hashable {
    public let date: Date
    public let provider: String?

    public init(date: Date, provider: String? = nil) {
        self.date = date
        self.provider = provider
    }
}

public func twActivityHeatmapEvents(from cards: [RemoteTaskCard]) -> [ActivityHeatmapEvent] {
    cards.flatMap { card in
        [twParseISODate(card.createdAt), twParseISODate(card.updatedAt)]
            .compactMap { $0 }
            .map { ActivityHeatmapEvent(date: $0, provider: card.provider) }
    }
}

/// Compact activity heatmap — the phone rendition of the desktop welcome
/// screen's provider-themed hour×day grid.
public struct ActivityHeatmap: View {
    private struct Bucket {
        var count = 0
        var providerCounts: [String: Int] = [:]

        var dominantProvider: String? {
            providerCounts.max {
                if $0.value == $1.value { return $0.key > $1.key }
                return $0.value < $1.value
            }?.key
        }
    }

    let events: [ActivityHeatmapEvent]
    let accent: Color
    let days: Int

    public init(events: [ActivityHeatmapEvent], accent: Color, days: Int = 90) {
        self.events = events
        self.accent = accent
        self.days = days
    }

    public init(dates: [Date], accent: Color, days: Int = 90) {
        self.init(events: dates.map { ActivityHeatmapEvent(date: $0) }, accent: accent, days: days)
    }

    private var buckets: [[Bucket]] {
        var grid = Array(repeating: Array(repeating: Bucket(), count: days), count: 12)
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        for event in events {
            let day = calendar.startOfDay(for: event.date)
            guard
                let offset = calendar.dateComponents([.day], from: day, to: today).day,
                offset >= 0, offset < days
            else { continue }
            let hour = calendar.component(.hour, from: event.date)
            let row = min(11, hour / 2)
            let column = days - 1 - offset
            grid[row][column].count += 1
            if let provider = event.provider?.lowercased(), !provider.isEmpty {
                grid[row][column].providerCounts[provider, default: 0] += 1
            }
        }
        return grid
    }

    public var body: some View {
        let grid = buckets
        let rows = 12
        let spacing: CGFloat = days >= 60 ? 1 : 2
        GeometryReader { geo in
            let cell = min(
                days >= 60 ? 4 : 9,
                max(2, (geo.size.width - CGFloat(days - 1) * spacing) / CGFloat(days)))
            let gridWidth = cell * CGFloat(days) + CGFloat(days - 1) * spacing
            VStack(alignment: .leading, spacing: spacing) {
                ForEach(0..<rows, id: \.self) { row in
                    HStack(spacing: spacing) {
                        ForEach(0..<days, id: \.self) { col in
                            RoundedRectangle(cornerRadius: 1.5)
                                .fill(cellColor(grid[row][col]))
                                .frame(width: cell, height: cell)
                        }
                    }
                }
            }
            .frame(width: gridWidth)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .frame(height: days >= 60 ? 48 : 12 * 9 + 11 * 2)
    }

    private func cellColor(_ bucket: Bucket) -> Color {
        let base = bucket.dominantProvider.map { TWTheme.providerAccent($0) } ?? accent
        switch bucket.count {
        case 0: return TWTheme.surface2
        case 1: return base.opacity(0.35)
        case 2...3: return base.opacity(0.6)
        default: return base.opacity(0.95)
        }
    }
}

/// Lenient ISO8601 parse for projection timestamps (with/without millis).
public func twParseISODate(_ value: String?) -> Date? {
    guard let value, !value.isEmpty else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    let plain = ISO8601DateFormatter()
    return plain.date(from: value)
}

/// Transcript typography — Avenir Next for message bodies (system-bundled
/// on iOS + macOS, scales with Dynamic Type via relativeTo).
public enum TWFont {
    public static func transcript(
        _ size: CGFloat = 16, weight: Font.Weight = .regular,
        relativeTo style: Font.TextStyle = .callout
    ) -> Font {
        // Honors Settings → Transcript → Response Font (default Avenir Next). Read
        // straight from UserDefaults (nonisolated-safe) so this stays callable from
        // any context; the root keys on TWThemeStore.revision, so a change in
        // Settings re-renders the tree and every transcript Text re-reads the face.
        let pref =
            TWTranscriptFont(
                rawValue: UserDefaults.standard.string(forKey: "tw.transcriptFont")
                    ?? "avenirNext") ?? .avenirNext
        return font(for: pref, size: size, weight: weight, relativeTo: style)
    }

    /// The SwiftUI font for an explicit transcript-font choice (used by the
    /// Settings preview). Avenir Next scales with Dynamic Type via `relativeTo`;
    /// the system designs render at the given base size + weight.
    public static func font(
        for pref: TWTranscriptFont, size: CGFloat = 16, weight: Font.Weight = .regular,
        relativeTo style: Font.TextStyle = .callout
    ) -> Font {
        switch pref {
        case .avenirNext:
            let name: String
            switch weight {
            case .bold: name = "AvenirNext-Bold"
            case .semibold: name = "AvenirNext-DemiBold"
            case .medium: name = "AvenirNext-Medium"
            default: name = "AvenirNext-Regular"
            }
            return .custom(name, size: size, relativeTo: style)
        case .sfPro: return .system(size: size, weight: weight, design: .default)
        case .serif: return .system(size: size, weight: weight, design: .serif)
        case .monospaced:
            return .system(size: size, weight: weight, design: .monospaced)
        case .rounded:
            return .system(size: size, weight: weight, design: .rounded)
        }
    }
}

/// ChatGPT-grade token flow: decouples REVEAL from ARRIVAL. Network chunks
/// land in bursts (relay cadence), so revealing them directly reads as
/// text slamming in. This view keeps a revealed-length cursor that catches
/// up to the target at a smooth adaptive rate (~30fps, faster when the
/// backlog grows so it never lags a quick model), and renders the newest
/// revealed characters through an alpha ramp — tokens fade in at the tail
/// and solidify as they age out of it.
public struct TokenRevealText: View {
    let target: String
    let font: Font
    let color: Color
    /// Terminal-drain input (advanceReveal isComplete): true once the stream
    /// has ended and the remaining backlog should drain within
    /// `completeDrainMs` instead of continuing at streaming cadence — parity
    /// with Electron's `isComplete: !isLive`, so the settled row never swaps
    /// in over a half-typed tail.
    let isComplete: Bool
    let onRevealFrame: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealed = 0
    /// Trails `revealed`: characters between the two are the fade tail.
    /// The pump advances it during idle ticks, so the shimmer SOLIDIFIES
    /// ~150ms after token flow pauses instead of freezing half-faded on a
    /// slow network — and re-opens when the stream resumes.
    @State private var solidified = 0
    @State private var pump: Task<Void, Never>? = nil
    /// Live mirror of `target` — the pump task captures the view STRUCT by
    /// value, so a plain `let` would go stale as the stream grows; @State
    /// reads route through SwiftUI's storage and stay current.
    @State private var goal = ""
    /// Live mirror of `isComplete`, same by-value-capture reason as `goal`.
    @State private var terminal = false

    public init(
        target: String, font: Font, color: Color, isComplete: Bool = false,
        onRevealFrame: (() -> Void)? = nil
    ) {
        self.target = target
        self.font = font
        self.color = color
        self.isComplete = isComplete
        self.onRevealFrame = onRevealFrame
    }

    private static let frameDelayNanos: UInt64 = 42_000_000
    /// The reveal tick in seconds — drives the SHARED time-based cursor math
    /// (advanceReveal / RevealParams) so iOS reveals the same chars per wall-
    /// second as the Electron rAF path.
    private static let frameDt: Double = Double(frameDelayNanos) / 1_000_000_000
    /// Sub-bands the fade tail is split into when sampling the shared smoothstep
    /// opacity curve — more than the old 3 hardcoded bands so the gradient reads
    /// continuous, without a per-grapheme Text explosion.
    private static let fadeBandCount = 6

    public var body: some View {
        renderedText
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
            // VoiceOver + accessibility read the FULL target, never the
            // partially-revealed prefix the animation is currently showing —
            // the reveal is a visual effect over already-complete text.
            .accessibilityLabel(Text(target))
            .onAppear {
                goal = target
                terminal = isComplete
                if reduceMotion || target.count > RevealParams.shared.coldSnapChars {
                    revealed = target.count
                    solidified = revealed
                    onRevealFrame?()
                } else {
                    startPumpIfNeeded()
                }
            }
            .onChange(of: isComplete) { _, complete in
                terminal = complete
                // The terminal flip usually arrives with no new characters, so
                // no onChange(of: target) fires — re-arm the pump here or the
                // remaining backlog would never drain.
                if complete { startPumpIfNeeded() }
            }
            .onChange(of: target) { _, newValue in
                let commonPrefix = Self.commonPrefixCount(goal, newValue)
                goal = newValue
                if reduceMotion {
                    revealed = newValue.count
                    solidified = revealed
                    onRevealFrame?()
                    return
                }
                // Run reset / shrink / cumulative same-length rewrite → resume
                // from the shared prefix; ordinary growth keeps its cursor.
                if commonPrefix < revealed && commonPrefix < newValue.count {
                    revealed = commonPrefix
                    solidified = min(solidified, revealed)
                }
                if revealed > newValue.count { revealed = newValue.count }
                if solidified > revealed { solidified = revealed }
                startPumpIfNeeded()
            }
            .onChange(of: reduceMotion) { _, enabled in
                if enabled {
                    revealed = target.count
                    solidified = revealed
                    onRevealFrame?()
                } else {
                    startPumpIfNeeded()
                }
            }
            .onDisappear {
                pump?.cancel()
                pump = nil
                // You can't perceive a reveal you can't see: force convergence
                // so an offscreen (cancelled) pump can never freeze the cursor
                // half-revealed and leave a stuck bubble when it scrolls back.
                revealed = target.count
                solidified = revealed
            }
    }

    private var renderedText: Text {
        if reduceMotion {
            return Text(target).foregroundColor(color)
        }
        return composedText
    }

    private var composedText: Text {
        let shown = String(goal.prefix(revealed))
        guard !shown.isEmpty else { return Text("") }
        let chars = Array(shown)
        // The fade band is the not-yet-solidified tail [solidified, revealed];
        // everything before it is solid. Split the band into sub-bands and
        // sample the SHARED smoothstep curve by distance from the frontier, so
        // the easing matches Electron (newest ≈ transparent → oldest solid).
        let fadeLen = min(chars.count, max(0, revealed - solidified))
        guard fadeLen > 0 else { return Text(shown).foregroundColor(color) }
        let solidCount = chars.count - fadeLen
        var result = Text(String(chars.prefix(solidCount))).foregroundColor(color)
        let fadeChars = Array(chars.suffix(fadeLen))
        let bandCount = min(fadeLen, Self.fadeBandCount)
        let per = Double(fadeLen) / Double(bandCount)
        let tail = RevealParams.shared.fadeTailChars
        for b in 0..<bandCount {
            let start = Int((Double(b) * per).rounded(.down))
            let end = b == bandCount - 1 ? fadeLen : Int((Double(b + 1) * per).rounded(.down))
            guard end > start else { continue }
            // Distance from the frontier for this band's midpoint: older chars
            // (band 0) are farther back → more solid.
            let midFromFrontier = Double(fadeLen - (start + end) / 2)
            let opacity = revealFadeOpacity(midFromFrontier, fadeTailChars: tail)
            result =
                result
                + Text(String(fadeChars[start..<end])).foregroundColor(color.opacity(opacity))
        }
        return result
    }

    private func startPumpIfNeeded() {
        guard pump == nil, revealed < goal.count || solidified < revealed else { return }
        pump = Task { @MainActor in
            let dt = Self.frameDt
            let maxTail = RevealParams.shared.fadeTailChars
            let settleStep = max(1, Int(RevealParams.shared.settleCharsPerSec * dt))
            while !Task.isCancelled {
                let backlog = goal.count - revealed
                if backlog > 0 {
                    // Reveal phase: the SHARED time-based cursor (advanceReveal)
                    // so cadence + catch-up match Electron. prev==next here;
                    // divergence rewind is handled in onChange(of: target).
                    revealed = advanceReveal(
                        prev: goal, next: goal, revealed: revealed, isComplete: terminal, dt: dt)
                    if revealed > goal.count { revealed = goal.count }
                    // Keep the fade band bounded to the shared tail length.
                    if solidified < revealed - maxTail { solidified = revealed - maxTail }
                } else if solidified < revealed {
                    // Settle phase: no new tokens — melt the tail to solid at the
                    // shared settle rate instead of freezing half-faded.
                    solidified = min(revealed, solidified + settleStep)
                } else {
                    break
                }
                onRevealFrame?()
                try? await Task.sleep(nanoseconds: Self.frameDelayNanos)
            }
            pump = nil
            // Goal may have grown while we were finishing — re-arm.
            if revealed < goal.count || solidified < revealed { startPumpIfNeeded() }
        }
    }

    private static func commonPrefixCount(_ lhs: String, _ rhs: String) -> Int {
        var count = 0
        var left = lhs.startIndex
        var right = rhs.startIndex
        while left < lhs.endIndex, right < rhs.endIndex, lhs[left] == rhs[right] {
            count += 1
            lhs.formIndex(after: &left)
            rhs.formIndex(after: &right)
        }
        return count
    }
}

#if canImport(UIKit)
    import UIKit

    /// Downscale + JPEG-compress a picked image to fit the bridge image
    /// budget (~330KB binary per image). Returns the wire dict for
    /// composerPrompt / ensembleSteer.
    ///
    /// Never silently drops the image: a dense photo that won't fit 330KB at
    /// 1280px is retried at smaller dimensions, and the smallest attempt is
    /// shipped unconditionally (a 768px JPEG is tens of KB, always within the
    /// Mac cap). The earlier version returned nil here, so detailed images
    /// vanished from the prompt with no feedback.
    public func twEncodeImageAttachment(_ image: UIImage, name: String) -> [String: Any]? {
        func wire(_ data: Data) -> [String: Any] {
            ["name": name, "mimeType": "image/jpeg", "dataBase64": data.base64EncodedString()]
        }
        var smallest: Data?
        for maxDimension in [1280.0, 1024.0, 768.0] as [CGFloat] {
            let scale = min(1, maxDimension / max(image.size.width, image.size.height))
            let target = CGSize(
                width: image.size.width * scale, height: image.size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: target)
            let resized = renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: target))
            }
            // Walk quality down until it fits the per-image share of the budget.
            for quality in [0.7, 0.55, 0.4, 0.28] {
                guard let data = resized.jpegData(compressionQuality: quality) else { continue }
                smallest = data  // monotonically smaller as dimension/quality drop
                if data.count <= 330_000 {
                    return wire(data)
                }
            }
        }
        // Floor: ship the smallest attempt rather than dropping the attachment.
        if let smallest { return wire(smallest) }
        return nil
    }

    /// Inline base64 image previews for one transcript row. The phone can't
    /// read the Mac-local attachment file paths, so the Mac ships small JPEG
    /// thumbnails — this renders them the way the desktop transcript shows the
    /// attached image, instead of a bare "N images attached" chip.
    struct TranscriptImageThumbnails: View {
        let thumbnails: [RemoteThreadSnapshot.Row.ImageThumbnail]

        var body: some View {
            HStack(alignment: .top, spacing: 6) {
                ForEach(thumbnails) { thumb in
                    if let image = Self.decode(thumb.dataBase64) {
                        Image(uiImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 132, height: 132)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color(UIColor.separator), lineWidth: 0.5)
                            )
                            .accessibilityLabel("Attached image")
                    }
                }
            }
            .padding(.top, 2)
        }

        private static func decode(_ base64: String) -> UIImage? {
            guard let data = Data(base64Encoded: base64) else { return nil }
            return UIImage(data: data)
        }
    }
#endif

/// Rotating welcome heatmap — cycles the desktop welcome variants every 90s.
public struct RotatingActivityHeatmap: View {
    public struct Flavor: Identifiable {
        public let id: String
        public let title: String
        public let caption: String
        public let accent: Color
        public let events: [ActivityHeatmapEvent]
        public let weekly: Bool

        public init(
            id: String, title: String, caption: String, accent: Color,
            events: [ActivityHeatmapEvent], weekly: Bool = false
        ) {
            self.id = id
            self.title = title
            self.caption = caption
            self.accent = accent
            self.events = events
            self.weekly = weekly
        }

        public init(
            id: String, title: String, caption: String, accent: Color,
            dates: [Date], weekly: Bool = false
        ) {
            self.id = id
            self.title = title
            self.caption = caption
            self.accent = accent
            self.events = dates.map { ActivityHeatmapEvent(date: $0) }
            self.weekly = weekly
        }
    }

    let flavors: [Flavor]
    /// Token totals for the chips row; nil hides chips (older Macs).
    var rollup: UsageRollupMessage.Rollup? = nil
    @State private var index = 0
    @State private var cycleResetToken = 0
    /// nil = All providers.
    @State private var providerFilter: String? = nil

    public init(flavors: [Flavor], rollup: UsageRollupMessage.Rollup? = nil) {
        self.flavors = flavors
        self.rollup = rollup
    }

    private func filteredEvents(_ flavor: Flavor) -> [ActivityHeatmapEvent] {
        guard let providerFilter else { return flavor.events }
        return flavor.events.filter { $0.provider?.lowercased() == providerFilter }
    }

    private var filterProviders: [String] {
        let fromEvents = Set(
            flavors.flatMap(\.events).compactMap { $0.provider?.lowercased() })
        let fromRollup = Set((rollup?.providers ?? []).map { $0.provider.lowercased() })
        return fromEvents.union(fromRollup)
            .sorted { TWTheme.providerLabel($0) < TWTheme.providerLabel($1) }
    }

    private var chipBuckets: UsageRollupMessage.Buckets? {
        guard let rollup else { return nil }
        guard let providerFilter else { return rollup.totals }
        guard
            let entry = rollup.providers.first(where: {
                $0.provider.lowercased() == providerFilter
            })
        else { return UsageRollupMessage.Buckets(h24: 0, d7: 0, d90: 0) }
        return UsageRollupMessage.Buckets(h24: entry.h24, d7: entry.d7, d90: entry.d90)
    }

    private func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000_000 {
            return String(format: "%.2fB", Double(value) / 1_000_000_000)
        }
        if value >= 1_000_000 {
            return String(format: "%.0fM", Double(value) / 1_000_000)
        }
        if value >= 1_000 { return String(format: "%.0fk", Double(value) / 1_000) }
        return "\(value)"
    }

    @ViewBuilder
    private var filterAndChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                filterPill(label: "All", value: nil)
                ForEach(filterProviders, id: \.self) { provider in
                    filterPill(label: TWTheme.providerLabel(provider), value: provider)
                }
                if let buckets = chipBuckets {
                    Spacer(minLength: 10)
                    tokenChip("24h", buckets.h24)
                    tokenChip("7D", buckets.d7)
                    tokenChip("90D", buckets.d90)
                }
            }
        }
    }

    private func filterPill(label: String, value: String?) -> some View {
        Button {
            providerFilter = value
        } label: {
            Text(label)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    providerFilter == value ? TWTheme.surface3 : Color.clear,
                    in: Capsule()
                )
                .foregroundStyle(
                    providerFilter == value ? TWTheme.textPrimary : TWTheme.textTertiary)
        }
        .buttonStyle(.plain)
    }

    private func tokenChip(_ label: String, _ value: Int) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .foregroundStyle(TWTheme.textMuted)
            Text(compactTokens(value))
                .foregroundStyle(TWTheme.textPrimary)
                .fontWeight(.semibold)
        }
        .font(.caption2.monospacedDigit())
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(TWTheme.surface3.opacity(0.7), in: Capsule())
    }

    public var body: some View {
        let activeIndex = flavors.isEmpty ? 0 : min(index, flavors.count - 1)
        let flavor = flavors[activeIndex]
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(flavor.title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Spacer()
                // Flavor pips
                HStack(spacing: 4) {
                    ForEach(0..<flavors.count, id: \.self) { pip in
                        Circle()
                            .fill(pip == activeIndex ? flavor.accent : TWTheme.surface3)
                            .frame(width: 4, height: 4)
                    }
                }
                Text(flavor.caption)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
            }
            if !filterProviders.isEmpty || rollup != nil {
                filterAndChipsRow
            }
            if flavor.weekly {
                WeeklyRhythmHeatmap(
                    dates: filteredEvents(flavor).map(\.date), accent: flavor.accent)
            } else {
                ActivityHeatmap(events: filteredEvents(flavor), accent: flavor.accent)
            }
        }
        .id(flavor.id)
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.8), value: index)
        .contentShape(Rectangle())
        .simultaneousGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    guard flavors.count > 1 else { return }
                    let dx = value.translation.width
                    let dy = value.translation.height
                    guard abs(dx) >= 44, abs(dx) > abs(dy) * 1.25 else { return }
                    withAnimation(.easeInOut(duration: 0.35)) {
                        index = nextIndex(from: activeIndex, offset: dx < 0 ? 1 : -1)
                    }
                    cycleResetToken += 1
                }
        )
        .task(id: cycleResetToken) {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 90_000_000_000)
                guard !Task.isCancelled, flavors.count > 1 else { continue }
                withAnimation(.easeInOut(duration: 0.8)) {
                    index = nextIndex(from: min(index, flavors.count - 1), offset: 1)
                }
            }
        }
    }

    private func nextIndex(from current: Int, offset: Int) -> Int {
        guard !flavors.isEmpty else { return 0 }
        return (current + offset + flavors.count) % flavors.count
    }
}

/// Vertically stacked welcome-style heatmaps for surfaces that have enough
/// scrolling room to show each 90-day projection at once.
struct ActivityHeatmapStack: View {
    struct Entry: Identifiable {
        let flavor: RotatingActivityHeatmap.Flavor
        let rollup: UsageRollupMessage.Rollup?
        var id: String { flavor.id }

        init(flavor: RotatingActivityHeatmap.Flavor, rollup: UsageRollupMessage.Rollup? = nil) {
            self.flavor = flavor
            self.rollup = rollup
        }
    }

    let entries: [Entry]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(entries) { entry in
                ActivityHeatmapStackCard(entry: entry)
            }
        }
    }
}

private struct ActivityHeatmapStackCard: View {
    let entry: ActivityHeatmapStack.Entry
    @State private var providerFilter: String? = nil

    private var flavor: RotatingActivityHeatmap.Flavor { entry.flavor }

    private var filteredEvents: [ActivityHeatmapEvent] {
        guard let providerFilter else { return flavor.events }
        return flavor.events.filter { $0.provider?.lowercased() == providerFilter }
    }

    private var filterProviders: [String] {
        let fromEvents = Set(flavor.events.compactMap { $0.provider?.lowercased() })
        let fromRollup = Set((entry.rollup?.providers ?? []).map { $0.provider.lowercased() })
        return fromEvents.union(fromRollup)
            .sorted { TWTheme.providerLabel($0) < TWTheme.providerLabel($1) }
    }

    private var chipBuckets: UsageRollupMessage.Buckets? {
        guard let rollup = entry.rollup else { return nil }
        guard let providerFilter else { return rollup.totals }
        guard
            let provider = rollup.providers.first(where: {
                $0.provider.lowercased() == providerFilter
            })
        else { return UsageRollupMessage.Buckets(h24: 0, d7: 0, d90: 0) }
        return UsageRollupMessage.Buckets(h24: provider.h24, d7: provider.d7, d90: provider.d90)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(flavor.title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Spacer()
                Text(flavor.caption)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
            }
            if !filterProviders.isEmpty || entry.rollup != nil {
                filterAndChipsRow
            }
            if flavor.weekly {
                WeeklyRhythmHeatmap(dates: filteredEvents.map(\.date), accent: flavor.accent)
            } else {
                ActivityHeatmap(events: filteredEvents, accent: flavor.accent)
            }
        }
    }

    @ViewBuilder
    private var filterAndChipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                filterPill(label: "All", value: nil)
                ForEach(filterProviders, id: \.self) { provider in
                    filterPill(label: TWTheme.providerLabel(provider), value: provider)
                }
                if let buckets = chipBuckets {
                    Spacer(minLength: 10)
                    tokenChip("24h", buckets.h24)
                    tokenChip("7D", buckets.d7)
                    tokenChip("90D", buckets.d90)
                }
            }
        }
    }

    private func filterPill(label: String, value: String?) -> some View {
        Button {
            providerFilter = value
        } label: {
            Text(label)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    providerFilter == value ? TWTheme.surface3 : Color.clear,
                    in: Capsule()
                )
                .foregroundStyle(
                    providerFilter == value ? TWTheme.textPrimary : TWTheme.textTertiary)
        }
        .buttonStyle(.plain)
    }

    private func tokenChip(_ label: String, _ value: Int) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .foregroundStyle(TWTheme.textMuted)
            Text(compactTokens(value))
                .foregroundStyle(TWTheme.textPrimary)
                .fontWeight(.semibold)
        }
        .font(.caption2.monospacedDigit())
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(TWTheme.surface3.opacity(0.7), in: Capsule())
    }

    private func compactTokens(_ value: Int) -> String {
        if value >= 1_000_000_000 {
            return String(format: "%.2fB", Double(value) / 1_000_000_000)
        }
        if value >= 1_000_000 {
            return String(format: "%.0fM", Double(value) / 1_000_000)
        }
        if value >= 1_000 { return String(format: "%.0fk", Double(value) / 1_000) }
        return "\(value)"
    }
}

/// 90-day daily token bar chart for the Inspector Usage tab — mirrors the
/// desktop TokenUsageChart: one bar per day, height ∝ that day's tokens,
/// colored by the day's dominant provider. Shows an empty-state line until the
/// Mac's usage-rollup broadcast carries a series.
struct TokenUsageBarChart: View {
    let title: String
    let series: DailyTokenSeries?

    private var maxTokens: Int { series?.buckets.map(\.tokens).max() ?? 0 }
    private var hasData: Bool { (series?.totalTokens ?? 0) > 0 && maxTokens > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Spacer()
                if let series, series.totalTokens > 0 {
                    Text("\(twCompactTokenCount(series.totalTokens)) tokens")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            if hasData, let series {
                GeometryReader { geo in
                    let count = max(series.buckets.count, 1)
                    let gap: CGFloat = 1
                    let barWidth = max(
                        1, (geo.size.width - CGFloat(count - 1) * gap) / CGFloat(count))
                    HStack(alignment: .bottom, spacing: gap) {
                        ForEach(Array(series.buckets.enumerated()), id: \.offset) { _, bucket in
                            let height =
                                bucket.tokens > 0
                                ? max(
                                    2,
                                    CGFloat(bucket.tokens) / CGFloat(maxTokens) * geo.size.height)
                                : 0
                            RoundedRectangle(cornerRadius: 1, style: .continuous)
                                .fill(
                                    bucket.tokens > 0
                                        ? TWTheme.providerAccent(bucket.provider ?? "")
                                        : TWTheme.surface3.opacity(0.35)
                                )
                                .frame(width: barWidth, height: height)
                                .frame(maxHeight: .infinity, alignment: .bottom)
                        }
                    }
                }
                .frame(height: 46)
                HStack {
                    Text(series.startLabel)
                    Spacer()
                    Text(series.endLabel)
                }
                .font(.caption2)
                .foregroundStyle(TWTheme.textMuted)
            } else {
                Text("No token usage in the last 90 days.")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 6)
            }
        }
    }
}

private func twCompactTokenCount(_ value: Int) -> String {
    if value >= 1_000_000_000 { return String(format: "%.2fB", Double(value) / 1_000_000_000) }
    if value >= 1_000_000 { return String(format: "%.0fM", Double(value) / 1_000_000) }
    if value >= 1_000 { return String(format: "%.0fk", Double(value) / 1_000) }
    return "\(value)"
}

/// Hour-of-day × weekday rhythm grid (the third desktop flavor).
public struct WeeklyRhythmHeatmap: View {
    let dates: [Date]
    let accent: Color

    public init(dates: [Date], accent: Color) {
        self.dates = dates
        self.accent = accent
    }

    private var counts: [[Int]] {
        var grid = Array(repeating: Array(repeating: 0, count: 7), count: 6)
        let calendar = Calendar.current
        for date in dates {
            let weekday = (calendar.component(.weekday, from: date) + 5) % 7  // Mon = 0
            let hour = calendar.component(.hour, from: date)
            grid[min(5, hour / 4)][weekday] += 1
        }
        return grid
    }

    public var body: some View {
        let grid = counts
        VStack(alignment: .leading, spacing: 2) {
            ForEach(0..<6, id: \.self) { row in
                HStack(spacing: 2) {
                    ForEach(0..<7, id: \.self) { col in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(cellColor(grid[row][col]))
                            .frame(height: 7)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }

    private func cellColor(_ count: Int) -> Color {
        switch count {
        case 0: return TWTheme.surface2
        case 1: return accent.opacity(0.35)
        case 2...3: return accent.opacity(0.6)
        default: return accent.opacity(0.95)
        }
    }
}

/// Ensemble @-mention engine — mirrors the Mac's EnsembleMentionAlias
/// normalization (lowercase, hyphens/underscores → spaces; a no-space
/// concat variant is also registered Mac-side).
///
/// Picker inserts use the desktop structured link form
/// `[@Label](ensemble-dm://participant-id)` so MAIN can authorize the exact
/// seat when role/provider/model aliases collide. Plain `@Token` remains
/// valid for free-typed mentions.
public struct MentionCandidate: Identifiable {
    public let id: String
    public let insertText: String
    public let display: String
    public let provider: String?
    public let model: String?

    public init(
        id: String, insertText: String, display: String, provider: String?, model: String? = nil
    ) {
        self.id = id
        self.insertText = insertText
        self.display = display
        self.provider = provider
        self.model = model
    }
}

/// Desktop composer picker contract (`formatEnsembleDmMention`). Escapes
/// `]` in the label so markdown link parsing stays unambiguous.
public func twFormatEnsembleDmMention(label: String, participantId: String) -> String {
    let trimmedId = participantId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedId.isEmpty else { return "" }
    let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
    let display = trimmedLabel.isEmpty ? trimmedId : trimmedLabel
    let escapedLabel = display
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "]", with: "\\]")
    return "[@\(escapedLabel)](ensemble-dm://\(trimmedId))"
}


@MainActor private func twMentionAccent(for participant: RemoteEnsembleState.Participant) -> Color {
    TWTheme.providerAccent(twMentionHueClass(for: participant))
}

public func twMentionHueClass(for participant: RemoteEnsembleState.Participant) -> String {
    OllamaDisplayBrands.providerHueClass(
        provider: participant.provider, modelId: participant.model, modelLabel: participant.model)
}

private func twMentionProviderLabel(_ participant: RemoteEnsembleState.Participant) -> String {
    TWTheme.providerLabel(
        participant.provider, modelId: participant.model, modelLabel: participant.model)
}

@MainActor private func twMentionAliasAccents(
    _ participants: [RemoteEnsembleState.Participant]
) -> [String: Color] {
    var aliasAccent: [String: Color] = [:]
    for participant in participants {
        let accent = twMentionAccent(for: participant)
        if let role = participant.role, !role.isEmpty {
            aliasAccent[role.lowercased()] = accent
            aliasAccent[role.replacingOccurrences(of: " ", with: "").lowercased()] = accent
        }
        if let provider = participant.provider {
            aliasAccent[provider.lowercased()] = accent
            aliasAccent[twMentionProviderLabel(participant).lowercased()] = accent
        }
    }
    aliasAccent["user"] = TWTheme.chroma1
    return aliasAccent
}

public func twMentionCandidates(
    participants: [RemoteEnsembleState.Participant]
) -> [MentionCandidate] {
    participants
        .sorted(by: RemoteEnsembleState.rosterOrder)
        .compactMap { participant in
            let role = participant.role?.trimmingCharacters(in: .whitespaces) ?? ""
            let label = role.isEmpty ? twMentionProviderLabel(participant) : role
            // Structured picker link preserves exact participant identity when
            // aliases collide (desktop ComposerMentionTrigger parity).
            let insert = twFormatEnsembleDmMention(
                label: label, participantId: participant.participantId)
            guard !insert.isEmpty else { return nil }
            return MentionCandidate(
                id: participant.participantId,
                insertText: insert,
                display: label,
                provider: participant.provider,
                model: participant.model)
        }
}

/// A stable identity for a roster's @mention TINT — the only participant-
/// derived thing a SETTLED transcript row renders. Used by ThreadRowView's
/// `==` so the EquatableView gate re-renders a row when the roster changes
/// the tint (participant added / renamed / provider-swapped) but NOT when a
/// participant merely flips `status`/`order` mid-stream (those churn every
/// token and would defeat the gate). Sorted so a pure reorder is a no-op.
func twParticipantsSignature(_ participants: [RemoteEnsembleState.Participant]) -> String {
    guard !participants.isEmpty else { return "" }
    // Escape the field/record delimiters first (role is user-editable free
    // text and could legitimately contain "|" or ";"); without this, two
    // distinct rosters could hash to the same signature and miss a re-tint.
    func esc(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "|", with: "\\|")
            .replacingOccurrences(of: ";", with: "\\;")
    }
    return participants
        .map {
            "\(esc($0.participantId))|\(esc($0.provider ?? ""))|\(esc($0.role ?? ""))|\(esc($0.model ?? ""))"
        }
        .sorted()
        .joined(separator: ";")
}

/// Color known @mentions in a transcript preview with their participant's
/// provider accent. Conservative: only EXACT alias tokens are tinted.
@MainActor public func twColorizeMentions(
    _ text: String, participants: [RemoteEnsembleState.Participant]
) -> AttributedString {
    var attributed = AttributedString(text)
    guard !participants.isEmpty else { return attributed }
    let aliasAccent = twMentionAliasAccents(participants)

    // Find @token runs in the plain string, map back into AttributedString.
    let pattern = #"@([A-Za-z][A-Za-z0-9._-]{1,40})"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return attributed }
    let ns = text as NSString
    for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        let token = ns.substring(with: match.range(at: 1))
        let normalized = token.lowercased().replacingOccurrences(of: "-", with: " ")
        let accent =
            aliasAccent[token.lowercased()]
            ?? aliasAccent[normalized]
            ?? aliasAccent[normalized.replacingOccurrences(of: " ", with: "")]
        guard let accent else { continue }
        guard
            let start = AttributedString.Index(
                String.Index(utf16Offset: match.range.location, in: text), within: attributed),
            let end = AttributedString.Index(
                String.Index(utf16Offset: match.range.location + match.range.length, in: text),
                within: attributed)
        else { continue }
        attributed[start..<end].foregroundColor = accent
        attributed[start..<end].font = .body.weight(.semibold)
    }
    return attributed
}

// ── MarkdownLite — desktop-transcript-parity markdown blocks ──────────────
// Line-based block renderer over the newline-preserving previews the Mac
// now ships: headings, bullet/numbered lists, fenced code, simple tables,
// blockquotes, paragraphs — with inline bold/italic/code/links parsed via
// AttributedString and @mentions tinted by participant provider accent.
// Deliberately dependency-free and bounded (preview text is ≤ a few KB).

/// TaskWraith-owned identity fallback for Ensemble and unknown providers.
/// Prefer ``ProviderLogoIcon`` for ordinary
/// provider identity. Ensemble preserves its full-colour Confluence Loom PNG as
/// original artwork; unknown providers receive a neutral accent dot.
public struct ProviderGlyphIcon: View {
    let provider: String?
    let modelId: String?
    let isEnsemble: Bool
    let size: CGFloat

    public init(
        provider: String?, modelId: String? = nil, isEnsemble: Bool = false, size: CGFloat = 16
    ) {
        self.provider = provider
        self.modelId = modelId
        self.isEnsemble = isEnsemble
        self.size = size
    }

    private static func glyphImage(for provider: String?) -> Image? {
        guard
            provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                == "ensemble"
        else { return nil }
        #if canImport(UIKit)
            if let ui = UIImage(named: "provider-glyph-ensemble") {
                return Image(uiImage: ui)
            }
            if let url = bundledResourceURL(for: "ensemble"),
                let data = try? Data(contentsOf: url),
                let ui = UIImage(data: data)
            {
                return Image(uiImage: ui)
            }
        #endif
        return nil
    }

    static func bundledResourceURL(for provider: String?) -> URL? {
        guard
            provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                == "ensemble"
        else { return nil }
        return Bundle.module.url(forResource: "provider-glyph-ensemble", withExtension: "png")
    }

    static func usesOriginalArtwork(provider: String?, isEnsemble: Bool) -> Bool {
        isEnsemble
            || provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                == "ensemble"
    }

    private func fullColourGlyph(_ glyph: Image) -> some View {
        glyph
            .renderingMode(.original)
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
    }

    public var body: some View {
        if Self.usesOriginalArtwork(provider: provider, isEnsemble: isEnsemble) {
            if let glyph = Self.glyphImage(for: "ensemble") {
                fullColourGlyph(glyph)
            } else {
                Image(systemName: "star.fill")
                    .font(.system(size: size * 0.72, weight: .semibold))
                    .foregroundStyle(TWTheme.providerAccent("ensemble"))
                    .frame(width: size, height: size)
            }
        } else {
            Circle()
                .fill(TWTheme.providerAccent(provider, modelId: modelId))
                .frame(width: size * 0.44, height: size * 0.44)
                .frame(width: size, height: size)
        }
    }
}

/// Resolves the first-party provider mark bundled for identity labels. The
/// light/dark choice names the surface the monochrome mark is displayed on;
/// full-colour marks use the same asset in both appearances.
enum ProviderLogoAssetResolver {
    static func assetName(for provider: String?, darkBackground: Bool) -> String? {
        guard
            let provider = provider?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased(),
            !provider.isEmpty
        else { return nil }

        switch provider {
        case "gemini", "codex", "claude", "kimi", "antigravity", "mistral", "deepseek":
            return "provider-logo-\(provider)"
        case "cursor", "grok", "ollama", "pi", "cerebras":
            return "provider-logo-\(provider)-on-\(darkBackground ? "dark" : "light")"
        default:
            return nil
        }
    }

    static func resourceURL(for assetName: String) -> URL? {
        Bundle.module.url(forResource: assetName, withExtension: "png")
    }

    static func opticalScale(for provider: String?) -> CGFloat {
        switch provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "pi": return 1.32
        case "mistral": return 1.08
        default: return 1
        }
    }
}

/// Original-colour first-party provider mark (design-assets provider-logos,
/// vendored under package Resources). Prefer this over ``ProviderGlyphIcon``
/// for provider identity anywhere beside a label or in list chrome. Ensemble
/// falls back to TaskWraith artwork; unknown providers receive a neutral dot.
public struct ProviderLogoIcon: View {
    @Environment(\.colorScheme) private var colorScheme

    let provider: String?
    let modelId: String?
    let isEnsemble: Bool
    let size: CGFloat

    public init(
        provider: String?, modelId: String? = nil, isEnsemble: Bool = false, size: CGFloat = 16
    ) {
        self.provider = provider
        self.modelId = modelId
        self.isEnsemble = isEnsemble
        self.size = size
    }

    private static func logoImage(named assetName: String) -> Image? {
        #if canImport(UIKit)
            if let url = ProviderLogoAssetResolver.resourceURL(for: assetName),
                let data = try? Data(contentsOf: url),
                let ui = UIImage(data: data)
            {
                return Image(uiImage: ui)
            }
            if let ui = UIImage(named: assetName) {
                return Image(uiImage: ui)
            }
        #endif
        return nil
    }

    public var body: some View {
        let assetName = isEnsemble
            ? nil
            : ProviderLogoAssetResolver.assetName(
                for: provider,
                darkBackground: colorScheme == .dark)

        Group {
            if let assetName, let logo = Self.logoImage(named: assetName) {
                logo
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(ProviderLogoAssetResolver.opticalScale(for: provider))
                    .accessibilityHidden(true)
            } else {
                ProviderGlyphIcon(
                    provider: provider,
                    modelId: modelId,
                    isEnsemble: isEnsemble,
                    size: size)
            }
        }
        .frame(width: size, height: size)
    }
}

/// Desktop-style fenced code chrome: language label + one-tap copy.
/// Syntax colouring stays out of scope (AttributedString limitation on iOS);
/// language identity + copy is the day-to-day fidelity win.
private struct MarkdownCodeBlockCard: View {
    let language: String?
    let lines: [String]

    @State private var copied = false

    private var source: String {
        lines.joined(separator: "\n")
    }

    private var languageLabel: String? {
        guard let language, !language.isEmpty else { return nil }
        return language
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let languageLabel {
                    Text(languageLabel)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(TWTheme.textSecondary)
                        .lineLimit(1)
                        .textCase(.lowercase)
                } else {
                    Text("code")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(TWTheme.textMuted)
                }
                Spacer(minLength: 8)
                Button {
                    #if canImport(UIKit)
                        UIPasteboard.general.string = source
                    #endif
                    copied = true
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 1_200_000_000)
                        copied = false
                    }
                } label: {
                    Label(
                        copied ? "Copied" : "Copy",
                        systemImage: copied ? "checkmark" : "doc.on.doc"
                    )
                    .font(.caption2.weight(.semibold))
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(copied ? TWTheme.statusSuccess : TWTheme.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied code block" : "Copy code block")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(TWTheme.surface3.opacity(0.72))

            ScrollView(.horizontal, showsIndicators: false) {
                Text(source)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(TWTheme.textPrimary)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            languageLabel.map { "Code block, \($0)" } ?? "Code block")
    }
}

public struct MarkdownLite: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let text: String
    let participants: [RemoteEnsembleState.Participant]
    let baseColor: Color

    public init(
        _ text: String,
        participants: [RemoteEnsembleState.Participant] = [],
        baseColor: Color = TWTheme.textPrimary
    ) {
        self.text = text
        self.participants = participants
        self.baseColor = baseColor
    }

    private enum Block {
        case heading(level: Int, text: String)
        case bullet(items: [String])
        case numbered(items: [String])
        /// Fenced code — `language` is the optional info string after ```.
        case code(language: String?, lines: [String])
        case table(MarkdownTable)
        case quote(text: String)
        case paragraph(text: String)
        case divider
    }

    /// Parsed block cache keyed by `(text, participantsSignature)` so settled
    /// rows and streaming prefixes skip the line-scan on every body eval.
    @MainActor
    private enum BlockCache {
        private struct Key: Hashable {
            let text: String
            let participantsSignature: String
        }

        private static var store: [Key: [Block]] = [:]
        private static var order: [Key] = []
        private static let maxEntries = 96

        static func blocks(text: String, participants: [RemoteEnsembleState.Participant]) -> [Block] {
            let key = Key(text: text, participantsSignature: twParticipantsSignature(participants))
            if let hit = store[key] {
                // LRU touch-on-hit: refresh recency so hot streaming prefixes
                // aren't evicted while cold one-off rows fall out first.
                if let index = order.firstIndex(of: key) {
                    order.remove(at: index)
                    order.append(key)
                }
                return hit
            }
            let parsed = parseBlocks(from: text)
            store[key] = parsed
            order.append(key)
            if order.count > maxEntries, let evict = order.first {
                order.removeFirst()
                store.removeValue(forKey: evict)
            }
            return parsed
        }

        static func parseBlocks(from text: String) -> [Block] {
            parseBlocksImpl(from: text)
        }

        #if DEBUG
            static func _resetForTesting() {
                store = [:]
                order = []
            }

            static func _containsForTesting(text: String, participants: [RemoteEnsembleState.Participant]) -> Bool {
                let key = Key(text: text, participantsSignature: twParticipantsSignature(participants))
                return store[key] != nil
            }
        #endif
    }

    #if DEBUG
        public static func _resetBlockCacheForTesting() {
            BlockCache._resetForTesting()
        }

        public static func _touchBlockCacheForTesting(
            text: String, participants: [RemoteEnsembleState.Participant] = []
        ) {
            _ = BlockCache.blocks(text: text, participants: participants)
        }

        public static func _blockCacheContainsForTesting(
            text: String, participants: [RemoteEnsembleState.Participant] = []
        ) -> Bool {
            BlockCache._containsForTesting(text: text, participants: participants)
        }
    #endif

    private var blocks: [Block] {
        BlockCache.blocks(text: text, participants: participants)
    }

    private static func parseBlocksImpl(from text: String) -> [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbers: [String] = []
        var tableRows: [String] = []
        var codeLines: [String] = []
        var codeLanguage: String?
        var inFence = false

        func flushParagraph() {
            if !paragraph.isEmpty {
                out.append(.paragraph(text: paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }
        func flushLists() {
            if !bullets.isEmpty {
                out.append(.bullet(items: bullets))
                bullets = []
            }
            if !numbers.isEmpty {
                out.append(.numbered(items: numbers))
                numbers = []
            }
            if !tableRows.isEmpty {
                appendTableRows(tableRows)
                tableRows = []
            }
        }
        func firstRecoverableTableStart(in rows: [String]) -> Int? {
            guard rows.count >= 3 else { return nil }
            for index in 1..<(rows.count - 1)
            where MarkdownTable.parse(lines: Array(rows[index...])) != nil {
                return index
            }
            return nil
        }
        func appendTableRows(_ rows: [String]) {
            if let table = MarkdownTable.parse(lines: rows) {
                out.append(.table(table))
                return
            }
            if let tableStart = firstRecoverableTableStart(in: rows) {
                let proseRows = Array(rows[..<tableStart])
                if !proseRows.isEmpty {
                    out.append(.paragraph(text: proseRows.joined(separator: "\n")))
                }
                let candidateRows = Array(rows[tableStart...])
                if let table = MarkdownTable.parse(lines: candidateRows) {
                    out.append(.table(table))
                } else {
                    out.append(.paragraph(text: candidateRows.joined(separator: "\n")))
                }
                return
            }
            out.append(.paragraph(text: rows.joined(separator: "\n")))
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flushParagraph()
                flushLists()
                if inFence {
                    out.append(.code(language: codeLanguage, lines: codeLines))
                    codeLines = []
                    codeLanguage = nil
                } else {
                    let info = String(trimmed.dropFirst(3))
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    codeLanguage = info.isEmpty ? nil : info
                }
                inFence.toggle()
                continue
            }
            if inFence {
                codeLines.append(line)
                continue
            }
            if trimmed.isEmpty {
                flushParagraph()
                flushLists()
                continue
            }
            if let heading = Self.headingLevel(trimmed) {
                flushParagraph()
                flushLists()
                out.append(.heading(level: heading.level, text: heading.text))
                continue
            }
            if Self.isThematicBreak(trimmed) {
                flushParagraph()
                flushLists()
                out.append(.divider)
                continue
            }
            if MarkdownTable.isPotentialRow(trimmed) {
                flushParagraph()
                tableRows.append(trimmed)
                continue
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                flushParagraph()
                bullets.append(String(trimmed.dropFirst(2)))
                continue
            }
            if let numbered = Self.numberedItem(trimmed) {
                flushParagraph()
                numbers.append(numbered)
                continue
            }
            if trimmed.hasPrefix("> ") {
                flushParagraph()
                flushLists()
                out.append(.quote(text: String(trimmed.dropFirst(2))))
                continue
            }
            flushLists()
            paragraph.append(trimmed)
        }
        if inFence, !codeLines.isEmpty {
            out.append(.code(language: codeLanguage, lines: codeLines))
        }
        flushParagraph()
        flushLists()
        return out
    }

    private static func headingLevel(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        for character in line {
            if character == "#" { level += 1 } else { break }
        }
        guard level >= 1, level <= 6 else { return nil }
        let body = line.dropFirst(level).trimmingCharacters(in: .whitespaces)
        guard !body.isEmpty else { return nil }
        return (level, body)
    }

    private static func numberedItem(_ line: String) -> String? {
        guard let dot = line.firstIndex(of: "."), line.startIndex < dot,
            line.index(after: dot) < line.endIndex,
            line[line.index(after: dot)] == " ",
            line[line.startIndex..<dot].allSatisfy({ $0.isNumber })
        else { return nil }
        return String(line[line.index(dot, offsetBy: 2)...])
    }

    /// `---` / `***` / `___` (3+ of one marker) — the separator the Mac
    /// inserts between Codex agent-message items; renders as a hairline
    /// instead of literal dashes.
    private static func isThematicBreak(_ line: String) -> Bool {
        guard line.count >= 3, let first = line.first,
            first == "-" || first == "*" || first == "_"
        else { return false }
        return line.allSatisfy { $0 == first }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
    }

    static func _markdownLiteBlockKindsForTesting(_ text: String) -> [String] {
        BlockCache.parseBlocks(from: text).map { block in
            switch block {
            case .heading: return "heading"
            case .bullet: return "bullet"
            case .numbered: return "numbered"
            case .code(let language, _):
                if let language, !language.isEmpty { return "code:\(language)" }
                return "code"
            case .table: return "table"
            case .quote: return "quote"
            case .paragraph: return "paragraph"
            case .divider: return "divider"
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: Block) -> some View {
        switch block {
        case .heading(let level, let text):
            inlineText(text)
                .font(
                    level <= 1
                        ? TWFont.transcript(20, weight: .bold, relativeTo: .title3)
                        : level == 2
                            ? TWFont.transcript(18, weight: .bold, relativeTo: .headline)
                            : TWFont.transcript(16, weight: .semibold, relativeTo: .headline)
                )
                .padding(.top, 2)
        case .bullet(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 7) {
                        Text("•").foregroundStyle(TWTheme.textTertiary)
                        // A Text beside a sibling in an HStack truncates to one
                        // line unless told it may grow vertically — without this
                        // long list items clipped with an ellipsis instead of
                        // wrapping (paragraphs, a bare Text, were never affected).
                        inlineText(item)
                            .font(TWFont.transcript())
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        case .numbered(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 7) {
                        Text("\(index + 1).")
                            .font(TWFont.transcript(14))
                            .foregroundStyle(TWTheme.textTertiary)
                        inlineText(item)
                            .font(TWFont.transcript())
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        case .code(let language, let lines):
            MarkdownCodeBlockCard(language: language, lines: lines)
        case .table(let table):
            tableView(table)
        case .quote(let text):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1).fill(TWTheme.chroma1).frame(width: 3)
                inlineText(text)
                    .font(TWFont.transcript())
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        case .paragraph(let text):
            inlineText(text).font(TWFont.transcript())
        case .divider:
            Rectangle()
                .fill(TWTheme.border)
                .frame(height: 1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
    }

    private func tableView(_ table: MarkdownTable) -> some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        let columnWidths = tableColumnWidths(table)
        return ScrollView(.horizontal, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(
                    table.headers, table: table, header: true, rowIndex: 0,
                    columnWidths: columnWidths)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                    tableRow(
                        row, table: table, header: false, rowIndex: rowIndex + 1,
                        columnWidths: columnWidths)
                }
            }
            .fixedSize(horizontal: true, vertical: true)
        }
        .background(TWTheme.surface2.opacity(0.86), in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(TWTheme.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Markdown table")
        .accessibilityHint("Scroll horizontally to read additional columns")
    }

    private func tableRow(
        _ cells: [String],
        table: MarkdownTable,
        header: Bool,
        rowIndex: Int,
        columnWidths: [CGFloat]
    ) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(0..<table.columnCount, id: \.self) { column in
                tableCell(
                    column < cells.count ? cells[column] : "",
                    header: header,
                    columnHeader: table.headers[column],
                    alignment: table.alignments[column],
                    rowIndex: rowIndex,
                    columnIndex: column,
                    columnWidth: columnWidths[column]
                )
            }
        }
        .background(tableRowBackground(header: header, rowIndex: rowIndex))
        .overlay(alignment: .bottom) {
            Rectangle().fill(TWTheme.border.opacity(0.72)).frame(height: 1)
        }
        .overlay(alignment: .leading) {
            tableColumnDividers(columnWidths: columnWidths)
        }
    }

    @ViewBuilder
    private func tableCell(
        _ raw: String,
        header: Bool,
        columnHeader: String,
        alignment: MarkdownTableAlignment,
        rowIndex: Int,
        columnIndex: Int,
        columnWidth: CGFloat
    ) -> some View {
        // The round close-out's Seat column is one `ensemble-seat://` link per
        // row. Swap the link for the live seat strip; if the href does not
        // decode, render the link's plain TEXT — which the Mac writes as the
        // full seat description precisely so a surface that can't render the
        // element still reads every field. Never leave a link this device has
        // no handler for.
        let seat = header ? nil : twSeatTableCell(raw)
        if let seat {
            Group {
                if let link = seat.link {
                    TWSeatStrip(link: link)
                } else {
                    inlineText(seat.text.isEmpty ? " " : seat.text)
                        .font(TWFont.transcript(13))
                        .foregroundStyle(TWTheme.textSecondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: columnWidth, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.horizontal, 8)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                tableAccessibilityLabel(
                    seat.text,
                    columnHeader: columnHeader,
                    rowIndex: rowIndex,
                    columnIndex: columnIndex
                )
            )
        } else {
            plainTableCell(
                raw,
                header: header,
                columnHeader: columnHeader,
                alignment: alignment,
                rowIndex: rowIndex,
                columnIndex: columnIndex,
                columnWidth: columnWidth
            )
        }
    }

    private func plainTableCell(
        _ raw: String,
        header: Bool,
        columnHeader: String,
        alignment: MarkdownTableAlignment,
        rowIndex: Int,
        columnIndex: Int,
        columnWidth: CGFloat
    ) -> some View {
        inlineText(raw.isEmpty ? " " : raw)
            .font(header ? TWFont.transcript(13, weight: .semibold) : TWFont.transcript(13))
            .foregroundStyle(header ? TWTheme.textPrimary : TWTheme.textSecondary)
            .multilineTextAlignment(textAlignment(for: alignment))
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: columnWidth, alignment: frameAlignment(for: alignment))
            .padding(.vertical, 8)
            .padding(.horizontal, 8)
            .accessibilityLabel(
                tableAccessibilityLabel(
                    raw,
                    columnHeader: columnHeader,
                    rowIndex: rowIndex,
                    columnIndex: columnIndex
                )
            )
    }

    private func tableColumnWidth(for columnCount: Int) -> CGFloat {
        let baseWidth: CGFloat
        switch columnCount {
        case 0...2: baseWidth = 136
        case 3: baseWidth = 104
        case 4: baseWidth = 76
        default: baseWidth = 68
        }
        guard dynamicTypeSize.isAccessibilitySize else { return baseWidth }
        return max(baseWidth, 112)
    }

    private func tableCellTotalWidth(_ columnWidth: CGFloat) -> CGFloat {
        columnWidth + 16
    }

    /// Per-column widths. Uniform, EXCEPT for a column carrying the round
    /// close-out's seat element: a seat is a whole configuration (provider,
    /// model, reasoning, permission tier, grants, role) and reads as nonsense
    /// squeezed into the width a word like "Turns" needs. The table already
    /// scrolls horizontally, so the extra width costs the other columns
    /// nothing.
    private func tableColumnWidths(_ table: MarkdownTable) -> [CGFloat] {
        let base = tableColumnWidth(for: table.columnCount)
        let seatWidth: CGFloat = dynamicTypeSize.isAccessibilitySize ? 300 : 236
        return (0..<table.columnCount).map { column in
            let carriesSeat = table.rows.contains { row in
                column < row.count && twSeatTableCell(row[column]) != nil
            }
            return carriesSeat ? max(base, seatWidth) : base
        }
    }

    @ViewBuilder
    private func tableColumnDividers(columnWidths: [CGFloat]) -> some View {
        if columnWidths.count > 1 {
            let cellWidths = columnWidths.map(tableCellTotalWidth)
            // Offsets accumulate: with a widened seat column the dividers can
            // no longer be a multiple of one uniform cell width.
            let offsets = cellWidths.dropLast().reduce(into: [CGFloat]()) { out, width in
                out.append((out.last ?? 0) + width)
            }
            ZStack(alignment: .leading) {
                ForEach(Array(offsets.enumerated()), id: \.offset) { _, x in
                    Rectangle()
                        .fill(TWTheme.border.opacity(0.72))
                        .frame(width: 1)
                        .offset(x: x - 0.5)
                }
            }
            .frame(width: cellWidths.reduce(0, +), alignment: .leading)
            .allowsHitTesting(false)
        }
    }

    private func tableRowBackground(header: Bool, rowIndex: Int) -> Color {
        // Theme-neutral silver header — same policy as the `.divider` line-break
        // above (which stays neutral TWTheme.border): markdown tables must NOT
        // inherit the provider/participant accent (chroma1), so a table reads
        // identically no matter which model/participant emitted it. surface3
        // keeps the header in the same neutral family as the zebra rows below.
        if header { return TWTheme.surface3.opacity(0.5) }
        return rowIndex.isMultiple(of: 2) ? Color.clear : TWTheme.surface3.opacity(0.26)
    }

    private func textAlignment(for alignment: MarkdownTableAlignment) -> TextAlignment {
        switch alignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func frameAlignment(for alignment: MarkdownTableAlignment) -> Alignment {
        switch alignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func tableAccessibilityLabel(
        _ raw: String,
        columnHeader: String,
        rowIndex: Int,
        columnIndex: Int
    ) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = value.isEmpty ? "empty" : value
        if rowIndex == 0 {
            return "Header column \(columnIndex + 1), \(fallback)"
        }
        let header = columnHeader.trimmingCharacters(in: .whitespacesAndNewlines)
        if header.isEmpty {
            return "Row \(rowIndex), column \(columnIndex + 1), \(fallback)"
        }
        return "Row \(rowIndex), \(header), \(fallback)"
    }

    /// Inline markdown (bold/italic/code/links) + provider-tinted mentions.
    private func inlineText(_ raw: String) -> Text {
        var attributed: AttributedString
        if let parsed = try? AttributedString(
            markdown: raw,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        {
            attributed = parsed
        } else {
            attributed = AttributedString(raw)
        }
        // Style inline code runs — desktop parity (.message-markdown code):
        // text-primary mono on the sunken well, NOT an accent tint. Attributed
        // runs can't carry the desktop chip's border/radius; background + mono
        // are the readable core of the treatment.
        for run in attributed.runs
        where run.inlinePresentationIntent?.contains(.code) == true {
            attributed[run.range].font = .system(size: 14, design: .monospaced)
            attributed[run.range].foregroundColor = TWTheme.textPrimary
            attributed[run.range].backgroundColor = TWTheme.appBgSunken
        }
        // Custom in-app schemes have no `CFBundleURLTypes` handler and no
        // `openURL` override, so a preserved `.link` renders as a system link
        // that does NOTHING when tapped. Strip it and keep the text: the seat
        // element renders these in the table-cell path, and everywhere else the
        // link text IS the content. `ensemble-dm://` is stripped for the same
        // reason — a mention is already tinted by the pass below.
        for run in attributed.runs where run.link != nil {
            guard let scheme = run.link?.scheme?.lowercased(),
                scheme == "ensemble-seat" || scheme == "ensemble-dm"
            else { continue }
            attributed[run.range].link = nil
        }
        // Tint known participant mentions.
        if !participants.isEmpty {
            let plain = String(attributed.characters)
            let mentionMatches = twMentionRanges(in: plain, participants: participants)
            for match in mentionMatches {
                if let start = AttributedString.Index(
                    String.Index(utf16Offset: match.location, in: plain), within: attributed),
                    let end = AttributedString.Index(
                        String.Index(utf16Offset: match.location + match.length, in: plain),
                        within: attributed)
                {
                    attributed[start..<end].foregroundColor = match.accent
                    attributed[start..<end].font = TWFont.transcript(16, weight: .semibold)
                }
            }
        }
        var base = attributed
        base.foregroundColor = nil  // keep run-level colors; default applied below
        return Text(attributed).foregroundColor(baseColor)
    }
}

/// Exact-alias mention ranges (utf16) + provider accents for a plain string.
public struct TWMentionRange {
    public let location: Int
    public let length: Int
    public let accent: Color
}

@MainActor public func twMentionRanges(
    in text: String, participants: [RemoteEnsembleState.Participant]
) -> [TWMentionRange] {
    let aliasAccent = twMentionAliasAccents(participants)
    guard let regex = try? NSRegularExpression(pattern: "@([A-Za-z][A-Za-z0-9._-]{1,40})") else {
        return []
    }
    let ns = text as NSString
    var out: [TWMentionRange] = []
    for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        let token = ns.substring(with: match.range(at: 1))
        let normalized = token.lowercased().replacingOccurrences(of: "-", with: " ")
        let accent =
            aliasAccent[token.lowercased()]
            ?? aliasAccent[normalized]
            ?? aliasAccent[normalized.replacingOccurrences(of: " ", with: "")]
        if let accent {
            out.append(
                TWMentionRange(
                    location: match.range.location, length: match.range.length, accent: accent))
        }
    }
    return out
}

public func twModelVariantLabel(provider: String?, model: String?) -> String? {
    let trimmed = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let providerKey = (provider ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let groups = ModelContextLengths.buildGroups(includeOllama: true)
    if let exact = groups
        .first(where: { $0.provider.lowercased() == providerKey })?
        .models
        .first(where: { $0.modelId.caseInsensitiveCompare(trimmed) == .orderedSame })
    {
        return exact.label
    }
    if let exact = groups
        .flatMap(\.models)
        .first(where: { $0.modelId.caseInsensitiveCompare(trimmed) == .orderedSame })
    {
        return exact.label
    }
    if providerKey == "ollama",
        let brand = OllamaDisplayBrands.resolve(modelId: trimmed, modelLabel: nil)
    {
        return brand.modelLabel
    }
    // `ModelContextLengths` lists only the flagship Pi row per upstream, so the
    // rest of the catalog fell through to the raw `<upstream>/<model>` wire id.
    if providerKey == "pi", let label = PiBrandTable.modelLabel(forWireModelId: trimmed) {
        return label
    }
    return trimmed
}

public func twWorkingParticipantLabel(
    provider: String?, role: String? = nil, model: String?
) -> String {
    let modelLabel = twModelVariantLabel(provider: provider, model: model)
    let providerLabel = TWTheme.providerLabel(provider, modelId: model, modelLabel: modelLabel)
    let roleLabel = (role ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    var parts = [providerLabel]
    if !roleLabel.isEmpty && roleLabel.caseInsensitiveCompare(providerLabel) != .orderedSame {
        parts.append(roleLabel)
    }
    if let modelLabel, !modelLabel.isEmpty {
        parts.append(modelLabel)
    }
    return parts.joined(separator: " · ")
}

/// Desktop ActivityStack parity: one card per tool call — tool-family icon,
/// name, touched file, per-edit +/− diff chips, status dot, result line.
public struct ToolActivityCards: View {
    let entries: [RemoteThreadSnapshot.Row.ToolEntry]
    let totalCount: Int
    let status: String?

    @Environment(\.openURL) private var openURL

    public init(
        entries: [RemoteThreadSnapshot.Row.ToolEntry], totalCount: Int, status: String?
    ) {
        self.entries = entries
        self.totalCount = totalCount
        self.status = status
    }

    /// Consecutive same-name calls collapse into one row ("Search tool ×9")
    /// — status aggregates (error > running > success), write-tool diff
    /// chips sum across the group, detail comes from the last entry.
    private struct CollapsedEntry: Identifiable {
        let entry: RemoteThreadSnapshot.Row.ToolEntry
        let count: Int
        /// Position-stable identity: groups only grow at the tail while a
        /// run streams, so ordinal+name keeps the row's view identity fixed
        /// as counts and ± stats tick — required for .numericText to roll
        /// the digits instead of replacing the whole row.
        let ordinal: Int
        var id: String { "\(ordinal)·\(entry.name)" }
    }

    private var collapsed: [CollapsedEntry] {
        var out: [CollapsedEntry] = []
        for entry in entries {
            if let last = out.last, last.entry.name == entry.name,
                last.entry.category == entry.category
            {
                let mergedStatus =
                    last.entry.status == "error" || entry.status == "error"
                    ? "error"
                    : last.entry.status == "running" || entry.status == "running"
                        ? "running" : entry.status
                let merged = RemoteThreadSnapshot.Row.ToolEntry(
                    name: entry.name,
                    category: entry.category,
                    status: mergedStatus,
                    file: last.entry.file == entry.file ? entry.file : nil,
                    additions: (last.entry.additions ?? 0) + (entry.additions ?? 0) > 0
                        ? (last.entry.additions ?? 0) + (entry.additions ?? 0) : nil,
                    deletions: (last.entry.deletions ?? 0) + (entry.deletions ?? 0) > 0
                        ? (last.entry.deletions ?? 0) + (entry.deletions ?? 0) : nil,
                    detail: entry.detail ?? last.entry.detail,
                    toolName: entry.toolName ?? last.entry.toolName,
                    urls: mergeUrlTargets(last.entry.urls, entry.urls),
                    detailTruncated: entry.detailTruncated == true
                        || last.entry.detailTruncated == true
                )
                out[out.count - 1] = CollapsedEntry(
                    entry: merged, count: last.count + 1, ordinal: last.ordinal)
            } else {
                out.append(CollapsedEntry(entry: entry, count: 1, ordinal: out.count))
            }
        }
        return out
    }

    public var body: some View {
        // Inline (satellite) presentation — no container chrome, the calls
        // sit in the transcript flow exactly where they happened.
        ToolActivityViewport {
            content
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(collapsed) { group in
                row(group.entry, count: group.count)
            }
            if totalCount > entries.count {
                Text("+ \(totalCount - entries.count) more tool call\(totalCount - entries.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
                    .padding(.leading, 23)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Edit-class card — a write tool that touched a file and carries ± diff
    /// stats. Renders as "Edited <file> +N −M" with the filename in accent.
    private func isEditCard(_ entry: RemoteThreadSnapshot.Row.ToolEntry) -> Bool {
        entry.category == "write" && entry.file != nil
            && ((entry.additions ?? 0) > 0 || (entry.deletions ?? 0) > 0)
    }

    @ViewBuilder
    private func row(_ entry: RemoteThreadSnapshot.Row.ToolEntry, count: Int = 1) -> some View {
        let isEdit = isEditCard(entry)
        let targets = ToolFileUrlTargetModel.makePresentation(
            file: entry.file,
            detail: entry.detail,
            projectedUrls: entry.urls ?? []
        )
        HStack(alignment: .top, spacing: 7) {
            ToolFamilyGlyph(
                toolName: entry.toolName ?? entry.name,
                category: entry.category,
                size: 16)
                .foregroundStyle(categoryColor(entry.category))
                .frame(width: 16)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(isEdit ? "Edited" : entry.name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    if count > 1 {
                        NumericTickText(
                            "×\(count)",
                            value: Double(count),
                            font: .caption2.weight(.semibold).monospacedDigit(),
                            color: TWTheme.textSecondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(TWTheme.surface3, in: Capsule())
                    }
                    if targets.hasTargets {
                        ToolFileUrlTargetSurface(
                            model: targets,
                            isEditAccent: isEdit,
                            onCopyFilePath: { copyTargetText($0.absolutePath) },
                            onOpenUrl: { target in
                                guard let url = URL(string: target.url) else { return }
                                openURL(url)
                            },
                            onCopyUrl: { copyTargetText($0.url) }
                        )
                    }
                    // Live edits tick like an odometer — NumericTickText rolls
                    // the digits as the Mac re-projects growing ± totals.
                    // Desktop parity: when EITHER side is nonzero, BOTH
                    // chips render ("+1 −0"), zero included. fixedSize keeps
                    // the chips rigid so a long filename truncates instead
                    // of squeezing the counters.
                    let additions = entry.additions ?? 0
                    let deletions = entry.deletions ?? 0
                    if additions > 0 || deletions > 0 {
                        NumericTickText(
                            "+\(additions)",
                            value: Double(additions),
                            font: .caption2.weight(.semibold).monospacedDigit(),
                            color: TWTheme.diffStatAdd)
                            .fixedSize()
                        NumericTickText(
                            "−\(deletions)",
                            value: Double(deletions),
                            font: .caption2.weight(.semibold).monospacedDigit(),
                            color: TWTheme.diffStatDel)
                            .fixedSize()
                    }
                    Spacer(minLength: 0)
                    Circle()
                        .fill(TWTheme.statusColor(entry.status))
                        .frame(width: 5, height: 5)
                }
                if let detail = entry.detail, !detail.isEmpty {
                    ToolResultInspectionSurface(
                        detail: detail,
                        truncated: entry.detailTruncated == true
                    )
                }
            }
        }
    }

    private func categoryColor(_ category: String?) -> Color {
        // Tool Call Theme: 'Match accent' keeps per-category hues keyed off
        // the standard palette; a fixed theme tints every category.
        if TWThemeStore.shared.toolTheme != .matchAccent {
            return TWThemeStore.toolAccent
        }
        switch category {
        case "write": return TWTheme.statusAttention
        case "shell": return TWTheme.chroma3
        case "search": return TWTheme.chroma1
        default: return TWTheme.textSecondary
        }
    }

    private func mergeUrlTargets(_ lhs: [String]?, _ rhs: [String]?) -> [String]? {
        var seen = Set<String>()
        var result: [String] = []
        for url in (lhs ?? []) + (rhs ?? []) where seen.insert(url).inserted {
            result.append(url)
            if result.count == ToolFileUrlTargetModel.defaultUrlLimit { break }
        }
        return result.isEmpty ? nil : result
    }

    private func copyTargetText(_ value: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = value
        #endif
    }
}

private struct ToolActivityViewportHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct ToolActivityViewport<Content: View>: View {
    private let maxHeight: CGFloat
    private let fadeHeight: CGFloat
    /// Extra height allowed before clamping. Tool cards keep a small slack to
    /// avoid flicker near the cap; fan-out result lanes pass 0 for Electron
    /// LiveActivityViewport parity (hard `max-height`).
    private let overflowSlack: CGFloat
    private let expandLabel: String?
    private let collapseLabel: String?
    private let content: Content
    @State private var contentHeight: CGFloat = 0
    @State private var expanded = false

    init(
        maxHeight: CGFloat = 172,
        fadeHeight: CGFloat = 34,
        overflowSlack: CGFloat = 8,
        expandLabel: String? = nil,
        collapseLabel: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.maxHeight = maxHeight
        self.fadeHeight = fadeHeight
        self.overflowSlack = overflowSlack
        self.expandLabel = expandLabel
        self.collapseLabel = collapseLabel
        self.content = content()
    }

    private var shouldScroll: Bool {
        contentHeight > maxHeight + overflowSlack
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            expandableSurface
        }
        .onPreferenceChange(ToolActivityViewportHeightKey.self) { height in
            guard abs(contentHeight - height) > 1 else { return }
            contentHeight = height
        }
    }

    /// Collapsed viewport is the tap target — no separate "Expand more" pill.
    /// Tapping the clipped + faded area expands inline. Expanded content stays
    /// plain/selectable (never a Button label — that eats copy/selection).
    /// Collapse is a bounded bottom strip + a11y action only. The inner
    /// ScrollView stays for correct GeometryReader measurement (unbounded
    /// height proposal) but `.scrollDisabled(true)` kills the nested-scroll
    /// gesture that was the actual bug.
    @ViewBuilder
    private var expandableSurface: some View {
        if shouldScroll, let expandLabel, !expanded {
            // Collapsed: clipped at maxHeight with edge fade; tap to expand.
            // Keep the inner ScrollView (with .scrollDisabled(true)) so
            // GeometryReader gets an unbounded height proposal — measuring
            // under a bounded .frame(height:) risks the geometry-livelock
            // class. scrollDisabled kills the nested-scroll gesture.
            Button {
                withAnimation(.easeInOut(duration: 0.16)) { expanded = true }
            } label: {
                ScrollView(.vertical, showsIndicators: false) {
                    measuredContent
                }
                .frame(height: maxHeight)
                .mask(edgeFadeMask)
                .scrollDisabled(true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expandLabel)
        } else if shouldScroll, expandLabel != nil, expanded {
            // Expanded: selectable content — do NOT wrap in Button (eats
            // textSelection). Collapse only via the bounded strip below.
            VStack(spacing: 0) {
                measuredContent
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) { expanded = false }
                } label: {
                    Color.clear
                        .frame(height: 28)
                        .frame(maxWidth: .infinity)
                        .overlay(alignment: .center) {
                            Capsule()
                                .fill(Color.secondary.opacity(0.35))
                                .frame(width: 36, height: 4)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(collapseLabel ?? "Collapse result")
            }
            .accessibilityAction(named: Text(collapseLabel ?? "Collapse result")) {
                withAnimation(.easeInOut(duration: 0.16)) { expanded = false }
            }
        } else if shouldScroll {
            // No expand label — legacy tool-card inner scroll.
            ScrollView(.vertical, showsIndicators: false) {
                measuredContent
            }
            .frame(height: maxHeight)
            .mask(edgeFadeMask)
            .scrollDisabled(true)
        } else {
            measuredContent
        }
    }

    private var measuredContent: some View {
        content
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: ToolActivityViewportHeightKey.self,
                        value: proxy.size.height)
                }
            )
    }

    private var edgeFadeMask: some View {
        VStack(spacing: 0) {
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: .black.opacity(0.18), location: 0.18),
                    .init(color: .black.opacity(0.76), location: 0.68),
                    .init(color: .black, location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: fadeHeight)
            Rectangle().fill(Color.black)
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black.opacity(0.76), location: 0.32),
                    .init(color: .black.opacity(0.18), location: 0.82),
                    .init(color: .clear, location: 1)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: fadeHeight)
        }
    }
}

// ── Thread inspector — diff + sub-agent tabs ───────────────────────────────
// iPad: right-hand `.inspector` panel; iPhone: the same view presents as a
// sheet (system behavior). Tabs: Changes (run diff files) and Agents
// (sub-threads / side chats / guests delegated from this thread).

public struct ThreadInspector: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    var onOpenThread: ((String) -> Void)? = nil

    public init(
        model: RemoteSessionModel, threadId: String,
        onOpenThread: ((String) -> Void)? = nil
    ) {
        self.model = model
        self.threadId = threadId
        self.onOpenThread = onOpenThread
    }

    private var diff: MobileDiffSummary? { model.diffSummaries[threadId] }
    private var children: [RemoteTaskCard] {
        model.taskCards.filter { $0.parentChatId == threadId }
    }
    /// Same trust order as ThreadDetailView: the un-throttled snapshot
    /// runSummary beats the (snapshot-throttled) task card when both exist.
    private var isRunning: Bool {
        if let runStatus = model.threadSnapshots[threadId]?.runSummary?.status {
            return runStatus == "running"
        }
        return model.taskCards.first { $0.id == threadId }?.status == "running"
    }
    /// Per-thread inspector segment (0=Changes … 4=Usage), read from the model
    /// so it persists across the thread's `.id()` remount and theme teardown
    /// instead of resetting to Changes each time (desktop per-chat-surface parity).
    private var tab: Int { model.inspectorTabByThread[threadId] ?? 0 }
    /// The peer-inbox count rides the segment label, because a segmented control has
    /// nowhere to hang a badge. Capped so a runaway inbox cannot stretch the
    /// control and squeeze the other five segments.
    private var peersSegmentLabel: String {
        ThreadMessageBadge.segmentLabel(
            count: model.threadSnapshots[threadId]?.threadMessageInbox?.count ?? 0)
    }
    private var tabBinding: Binding<Int> {
        Binding(
            get: { model.inspectorTabByThread[threadId] ?? 0 },
            set: { model.inspectorTabByThread[threadId] = $0 }
        )
    }

    public var body: some View {
        VStack(spacing: 0) {
            Picker("Inspector", selection: tabBinding) {
                Text("Changes").tag(0)
                Text("Agents").tag(1)
                Text("Side chats").tag(2)
                Text("Notes").tag(3)
                Text("Usage").tag(4)
                Text(peersSegmentLabel).tag(5)
                Text("Safety").tag(6)
            }
            .pickerStyle(.segmented)
            .padding(12)
            if tab == 6 {
                ScrollView {
                    if let card = model.taskCards.first(where: {
                        $0.id == threadId || $0.threadId == threadId
                    }) {
                        SafetyCapabilitiesPanel(card: card)
                    } else {
                        Text("No task card projected for this thread yet.")
                            .font(.caption)
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else if tab == 2 {
                SideChatsPanel(
                    model: model, threadId: threadId,
                    onOpenThread: onOpenThread)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else if tab == 1 {
                SubAgentsPanel(
                    model: model, children: children,
                    onOpenThread: onOpenThread)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 16)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if tab == 0 {
                            DiffSummaryPanel(diff: diff, isRunning: isRunning)
                            // Git workflows need at least the diffReview read
                            // tier (gitSnapshot). The panel splits local
                            // mutations (fileWrite) from external publishing.
                            // Hidden in demo — stage/commit/push has no offline
                            // equivalent (the diff pill + Diff Studio still
                            // work from canned data).
                            if !model.isDemo,
                                let workspaceId = model.taskCards.first(where: { $0.id == threadId })?
                                    .workspaceId,
                                model.workspaceCanReviewDiffs(workspaceId)
                            {
                                GitWorkflowPanel(model: model, workspaceId: workspaceId)
                            }
                        } else if tab == 4 {
                            UsagePanel(model: model, threadId: threadId)
                        } else if tab == 5 {
                            ThreadMessagePeersPanel(model: model, threadId: threadId)
                        } else {
                            NotesPanel(model: model, threadId: threadId)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 16)
                }
            }
        }
        .background(TWTheme.appBg)
        .twColorScheme()
        .onAppear { adoptInspectorSideChatTarget() }
        .onChange(of: model.inspectorSideChatTarget) { _, _ in
            adoptInspectorSideChatTarget()
        }
    }

    private func adoptInspectorSideChatTarget() {
        guard let target = model.inspectorSideChatTarget,
            model.taskCards.contains(where: {
                $0.id == target && $0.parentChatId == threadId
                    && $0.parentChatRelation == "sideChat"
            })
        else { return }
        model.inspectorTabByThread[threadId] = 2
    }
}

struct DiffSummaryPanel: View {
    let diff: MobileDiffSummary?
    /// Thread has an active run — absence of a diff means "not yet",
    /// not "nothing changed".
    var isRunning: Bool = false

    var body: some View {
        if let diff, let files = diff.files, !files.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text("\(diff.filesChanged ?? files.count) file\((diff.filesChanged ?? files.count) == 1 ? "" : "s") changed")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    if let additions = diff.additions, additions > 0 {
                        Text("+\(additions)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.diffStatAdd)
                    }
                    if let deletions = diff.deletions, deletions > 0 {
                        Text("−\(deletions)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.diffStatDel)
                    }
                    Spacer()
                }
                HStack(spacing: 8) {
                    statChip("Created", diff.createdFiles, TWTheme.diffStatAdd)
                    statChip("Edited", diff.modifiedFiles, TWTheme.chroma1)
                    statChip("Deleted", diff.deletedFiles, TWTheme.diffStatDel)
                    Spacer()
                }
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(files) { file in
                        fileRow(file)
                    }
                }
                if diff.truncated == true {
                    Text("More changes on your computer — open Review changes there for the full diff.")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
        } else if isRunning {
            // Mid-run the diff projection lags the agent's writes — say so
            // instead of declaring "no changes" while files are landing.
            VStack(spacing: 8) {
                StreamingDots(color: TWTheme.chroma1)
                Text("Run in progress — file changes appear here as the agent writes.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 32)
        } else {
            VStack(spacing: 8) {
                Image(systemName: "plusminus.circle")
                    .font(.title2)
                    .foregroundStyle(TWTheme.textTertiary)
                Text("No file changes from the latest run yet.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 32)
        }
    }

    @ViewBuilder
    private func statChip(_ label: String, _ count: Int?, _ accent: Color) -> some View {
        if let count, count > 0 {
            Text("\(label) \(count)")
                .font(.caption2.weight(.medium))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(accent.opacity(0.12), in: Capsule())
                .foregroundStyle(accent)
        }
    }

    private func fileRow(_ file: MobileDiffSummary.File) -> some View {
        HStack(spacing: 7) {
            Circle()
                .fill(statusColor(file.status))
                .frame(width: 6, height: 6)
            Text(file.path)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 4)
            if file.isBinary == true {
                Text("binary").font(.caption2).foregroundStyle(TWTheme.textMuted)
            } else {
                if let additions = file.additions, additions > 0 {
                    Text("+\(additions)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(TWTheme.diffStatAdd)
                }
                if let deletions = file.deletions, deletions > 0 {
                    Text("−\(deletions)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(TWTheme.diffStatDel)
                }
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 8))
    }

    private func statusColor(_ status: String?) -> Color {
        switch status {
        case "created", "added": return TWTheme.diffStatAdd
        case "deleted", "removed": return TWTheme.diffStatDel
        default: return TWTheme.chroma1
        }
    }
}

struct SubAgentsPanel: View {
    @ObservedObject var model: RemoteSessionModel
    let children: [RemoteTaskCard]
    var onOpenThread: ((String) -> Void)? = nil
    @State private var pendingOpen: RemoteTaskCard?
    @State private var inlineThreadId: String?

    var body: some View {
        Group {
            if let inlineThreadId {
                if let child = children.first(where: { $0.id == inlineThreadId }) {
                    MiniThreadView(
                        model: model, card: child,
                        onBack: { self.inlineThreadId = nil },
                        onExpand: { onOpenThread?(child.id) })
                } else {
                    SideChatOpeningView {
                        self.inlineThreadId = nil
                    }
                    .task(id: inlineThreadId) {
                        model.requestThreadSnapshot(inlineThreadId)
                    }
                }
            } else {
                ScrollView {
                    content
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(.bottom, 16)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .confirmationDialog(
            pendingOpenTitle, isPresented: openDialogPresented,
            titleVisibility: .visible
        ) {
            if let pendingOpen {
                Button("Open in Main") {
                    onOpenThread?(pendingOpen.id)
                }
                Button("Open in Side Chat") {
                    openInline(pendingOpen)
                }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var content: some View {
        if children.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "person.2.circle")
                    .font(.title2)
                    .foregroundStyle(TWTheme.textTertiary)
                Text("No guests, sub-agents or side chats delegated from this thread.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 32)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(children, id: \.id) { child in
                    childButton(child)
                }
            }
        }
    }

    private var pendingOpenTitle: String {
        guard let pendingOpen else { return "Open chat" }
        return "Open \(pendingOpen.title ?? pendingOpen.agentName ?? relationLabel(pendingOpen))"
    }

    private var openDialogPresented: Binding<Bool> {
        Binding(
            get: { pendingOpen != nil },
            set: { isPresented in
                if !isPresented { pendingOpen = nil }
            })
    }

    private func childButton(_ child: RemoteTaskCard) -> some View {
        Button {
            pendingOpen = child
        } label: {
            childRow(child)
        }
        .buttonStyle(.plain)
    }

    private func childRow(_ child: RemoteTaskCard) -> some View {
        let identityAccent =
            child.agentName != nil
            ? twAgentAccentColor(child.agentAccent)
            : TWTheme.providerAccent(child.provider)
        return HStack(alignment: .top, spacing: 8) {
            if let agentName = child.agentName {
                AgentIdentityBadge(
                    name: agentName,
                    accentHex: child.agentAccent,
                    slug: child.agentSlug)
                    .padding(.top, 1)
            } else {
                Image(systemName: relationIcon(child))
                    .font(.caption)
                    .foregroundStyle(TWTheme.providerAccent(child.provider))
                    .frame(width: 16)
                    .padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 2) {
                if let agentName = child.agentName {
                    Text(agentName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(identityAccent)
                        .lineLimit(1)
                }
                Text(child.title ?? child.id)
                    .font(child.agentName != nil ? .caption : .subheadline)
                    .foregroundStyle(
                        child.agentName != nil ? TWTheme.textSecondary : TWTheme.textPrimary
                    )
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(TWTheme.providerLabel(child.provider))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(TWTheme.providerAccent(child.provider))
                    Text(relationLabel(child))
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(TWTheme.surface3, in: Capsule())
                        .foregroundStyle(TWTheme.textTertiary)
                    if let status = child.status {
                        HStack(spacing: 3) {
                            Circle()
                                .fill(TWTheme.statusColor(status))
                                .frame(width: 5, height: 5)
                            Text(status)
                                .font(.caption2)
                                .foregroundStyle(TWTheme.statusColor(status))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(TWTheme.textMuted)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            // Desktop invocation-card parity: the agent's accent hue outlines its card.
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(identityAccent.opacity(child.agentName != nil ? 0.55 : 0.0))
        )
    }

    private func openInline(_ child: RemoteTaskCard) {
        if let workspaceId = child.workspaceId {
            model.rememberThreadWorkspace(child.id, workspaceId: workspaceId)
        }
        model.requestThreadSnapshot(child.id)
        inlineThreadId = child.id
    }

    private func relationLabel(_ card: RemoteTaskCard) -> String {
        if card.isGuestSideChat { return "Guest" }
        if card.parentChatRelation == "sideChat" { return "Side chat" }
        if card.parentChatRelation == "subThread" { return "Sub-thread" }
        return card.isEnsemble ? "Ensemble clone" : "Delegated"
    }

    private func relationIcon(_ card: RemoteTaskCard) -> String {
        if card.isGuestSideChat { return "person.crop.circle.badge.plus" }
        if card.parentChatRelation == "sideChat" { return "arrow.left.arrow.right" }
        return "arrow.turn.down.right"
    }
}

/// Above-composer changes row — the Codex-app "N files changed +X −Y" bar.
public struct ChangesAboveRow: View {
    let diff: MobileDiffSummary
    let action: () -> Void

    public init(diff: MobileDiffSummary, action: @escaping () -> Void) {
        self.diff = diff
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: "plusminus.circle")
                    .font(.caption)
                    .foregroundStyle(TWTheme.chroma1)
                Text("\(diff.filesChanged ?? diff.files?.count ?? 0) file\((diff.filesChanged ?? diff.files?.count ?? 0) == 1 ? "" : "s") changed")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                if let additions = diff.additions, additions > 0 {
                    Text("+\(additions)")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(TWTheme.diffStatAdd)
                }
                if let deletions = diff.deletions, deletions > 0 {
                    Text("−\(deletions)")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(TWTheme.diffStatDel)
                }
                Spacer()
                Text("Review")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.chroma1)
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textMuted)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(TWTheme.surface2, in: Capsule())
            .overlay(Capsule().strokeBorder(TWTheme.border))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
    }
}

// ── Composer shell rows (desktop three-decker parity) ──────────────────────

/// Attached diff/git header — top corners rounded, flat bottom edge merging
/// into the composer body. Mirrors the desktop native composer order:
/// workspace/branch, sync state, files changed, +/- diff, action.
public struct ChangesAttachedRow: View {
    let diff: MobileDiffSummary?
    let workspaceName: String?
    let gitSnapshot: GitWorkspaceSnapshot?
    let action: () -> Void

    public init(
        diff: MobileDiffSummary?, workspaceName: String? = nil,
        gitSnapshot: GitWorkspaceSnapshot? = nil, action: @escaping () -> Void
    ) {
        self.diff = diff
        self.workspaceName = workspaceName
        self.gitSnapshot = gitSnapshot
        self.action = action
    }

    public var body: some View {
        ComposerGitAttachedRowContent(
            workspaceName: workspaceName,
            fallbackName: nil,
            filesChanged: filesChanged,
            additions: additions,
            deletions: deletions,
            gitSnapshot: gitSnapshot,
            actionLabel: actionLabel,
            action: action
        )
    }

    private var filesChanged: Int {
        gitSnapshot?.counts?.changed ?? diff?.filesChanged ?? diff?.files?.count ?? 0
    }

    private var additions: Int {
        gitSnapshot?.lineStats?.additions ?? diff?.additions ?? 0
    }

    private var deletions: Int {
        gitSnapshot?.lineStats?.deletions ?? diff?.deletions ?? 0
    }

    private var actionLabel: String {
        if filesChanged > 0 { return "Review changes" }
        if (gitSnapshot?.ahead ?? 0) > 0 { return "Push" }
        return "Create PR"
    }
}

/// Bottom telemetry rail — flat top, rounded bottom corners. One RUN
/// timecode (ticking while running, frozen at the final duration),
/// workspace name center, token/cost telemetry right.
private struct ComposerEnsembleToggleControl: View {
    let enabled: Bool
    let disabled: Bool
    let title: String
    let onSelect: (Bool) -> Void

    @State private var presented = false

    var body: some View {
        Menu {
            Button {
                onSelect(true)
            } label: {
                Label("Ensemble on", systemImage: enabled ? "checkmark" : "")
            }
            Button {
                onSelect(false)
            } label: {
                Label("Ensemble off", systemImage: enabled ? "" : "checkmark")
            }
        } label: {
            ProviderGlyphIcon(provider: "ensemble", isEnsemble: true, size: 14)
                .opacity(enabled ? 1 : 0.55)
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(enabled ? TWTheme.chroma2.opacity(0.14) : Color.clear))
        }
        .disabled(disabled)
        .accessibilityLabel(title)
    }
}

public struct TelemetryFooterRail: View {
    let run: RemoteThreadSnapshot.RunSummary?
    let conversationCostText: String?
    let workspaceName: String?
    let activeGoal: RemoteActiveGoal?
    let onGoalUpdate: ((String, String?, String?) -> Void)?
    /// Per-author working plans (PlanRail) — read-only checklist shown beside the
    /// goal control. Empty hides the control.
    var planLanes: [RemoteTodoLane] = []
    /// Allowlisted workspaces for the secondary-grant picker (empty = the
    /// rail renders the plain read-only label).
    var workspaceOptions: [(id: String, name: String)] = []
    var primaryWorkspaceId: String? = nil
    var secondaryWorkspaceId: Binding<String?>? = nil
    var onPrimaryWorkspaceSelect: ((String) -> Void)? = nil
    var ensembleToggleEnabled: Bool = false
    var ensembleToggleVisible: Bool = false
    var ensembleToggleDisabled: Bool = false
    var ensembleToggleTitle: String = "Ensemble"
    var onEnsembleToggle: ((Bool) -> Void)? = nil
    @State private var compactTelemetryShowsCost = false
    @State private var railWidth: CGFloat = 0

    public init(
        run: RemoteThreadSnapshot.RunSummary?, conversationCostText: String? = nil,
        workspaceName: String?,
        workspaceOptions: [(id: String, name: String)] = [],
        primaryWorkspaceId: String? = nil,
        secondaryWorkspaceId: Binding<String?>? = nil,
        onPrimaryWorkspaceSelect: ((String) -> Void)? = nil,
        ensembleToggleEnabled: Bool = false,
        ensembleToggleVisible: Bool = false,
        ensembleToggleDisabled: Bool = false,
        ensembleToggleTitle: String = "Ensemble",
        onEnsembleToggle: ((Bool) -> Void)? = nil,
        activeGoal: RemoteActiveGoal? = nil,
        onGoalUpdate: ((String, String?, String?) -> Void)? = nil,
        planLanes: [RemoteTodoLane] = []
    ) {
        self.run = run
        self.conversationCostText = conversationCostText
        self.workspaceName = workspaceName
        self.activeGoal = activeGoal
        self.onGoalUpdate = onGoalUpdate
        self.planLanes = planLanes
        self.workspaceOptions = workspaceOptions
        self.primaryWorkspaceId = primaryWorkspaceId
        self.secondaryWorkspaceId = secondaryWorkspaceId
        self.onPrimaryWorkspaceSelect = onPrimaryWorkspaceSelect
        self.ensembleToggleEnabled = ensembleToggleEnabled
        self.ensembleToggleVisible = ensembleToggleVisible
        self.ensembleToggleDisabled = ensembleToggleDisabled
        self.ensembleToggleTitle = ensembleToggleTitle
        self.onEnsembleToggle = onEnsembleToggle
    }

    private var isRunning: Bool { run?.status == "running" }

    private var secondaryName: String? {
        guard let id = secondaryWorkspaceId?.wrappedValue else { return nil }
        return workspaceOptions.first(where: { $0.id == id })?.name
    }

    private var railWorkspaceLabel: String {
        if let secondaryName { return "\(workspaceName ?? "") + \(secondaryName)" }
        return workspaceName ?? ""
    }

    private func frozenDuration() -> TimeInterval? {
        if let ms = run?.durationMs { return TimeInterval(ms) / 1000 }
        return nil
    }

    private func liveDuration(now: Date) -> TimeInterval? {
        guard isRunning, let started = run?.startedAt,
            let startDate = twParseISODate(started)
        else { return frozenDuration() }
        return max(0, now.timeIntervalSince(startDate))
    }

    private func timecode(_ interval: TimeInterval?) -> String {
        guard let interval else { return "00:00:00" }
        let total = Int(interval)
        return String(
            format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
    }

    private var tokenTelemetryText: String? {
        guard let run else { return nil }
        var parts: [String] = []
        if let tokensIn = run.tokensIn, tokensIn > 0 {
            parts.append("\(compact(tokensIn)) in")
        }
        if let tokensOut = run.tokensOut, tokensOut > 0 {
            parts.append("\(compact(tokensOut)) out")
        }
        if parts.isEmpty, let total = run.totalTokens, total > 0 {
            parts.append("\(compact(total)) tokens")
        }
        let text = parts.joined(separator: " / ")
        return text.isEmpty ? nil : text
    }

    private var costTelemetryText: String? {
        let raw = conversationCostText ?? run?.costText
        guard let cost = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
            !cost.isEmpty
        else { return nil }
        return cost
    }

    private func telemetryLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(TWTheme.textSecondary)
            .lineLimit(1)
    }

    private var shouldUseCompactTelemetry: Bool {
        guard tokenTelemetryText != nil, costTelemetryText != nil else { return false }
        // iPad split panes keep a regular size class, so compact telemetry
        // must follow actual rail width rather than device idiom.
        return railWidth > 0 && railWidth < 620
    }

    @ViewBuilder
    private func telemetryView(compact: Bool) -> some View {
        if let tokens = tokenTelemetryText, let cost = costTelemetryText {
            let compactButton = Button {
                compactTelemetryShowsCost.toggle()
            } label: {
                telemetryLabel(compactTelemetryShowsCost ? cost : tokens)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                compactTelemetryShowsCost
                    ? "Estimated cost \(cost). Tap to show tokens."
                    : "Token estimate \(tokens). Tap to show cost.")

            if compact {
                compactButton
            } else {
                ViewThatFits(in: .horizontal) {
                    telemetryLabel("\(tokens) · \(cost)")
                    compactButton
                }
            }
        } else if let tokens = tokenTelemetryText {
            telemetryLabel(tokens)
        } else if let cost = costTelemetryText {
            telemetryLabel(cost)
        }
    }

    private func compact(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "%.0fk", Double(value) / 1_000)
        }
        return "\(value)"
    }

    private func workspaceLabel(
        _ text: String, showsPicker: Bool = false, emphasized: Bool = false
    ) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "folder")
                .font(.system(size: 9))
            Text(text)
                .font(.system(size: 11))
                .lineLimit(1)
            if showsPicker {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 7, weight: .semibold))
            }
        }
        .foregroundStyle(emphasized ? TWTheme.textSecondary : TWTheme.textTertiary)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var workspaceRailView: some View {
        if let workspaceName {
            if let onPrimaryWorkspaceSelect, !workspaceOptions.isEmpty {
                Menu {
                    Section("Workspace") {
                        ForEach(workspaceOptions, id: \.id) { option in
                            Button {
                                onPrimaryWorkspaceSelect(option.id)
                            } label: {
                                if option.id == primaryWorkspaceId {
                                    Label(option.name, systemImage: "checkmark")
                                } else {
                                    Text(option.name)
                                }
                            }
                        }
                    }
                } label: {
                    workspaceLabel(workspaceName, showsPicker: true)
                }
                Spacer()
            } else if let binding = secondaryWorkspaceId, !workspaceOptions.isEmpty {
                // Workspace picker: primary is fixed (the thread's);
                // picking another adds it as a secondary grant for
                // subsequent runs (desktop parity).
                Menu {
                    Section("Primary") {
                        Label(workspaceName, systemImage: "checkmark")
                    }
                    Section("Also grant access to") {
                        Button("None") { binding.wrappedValue = nil }
                        ForEach(
                            workspaceOptions.filter { $0.id != primaryWorkspaceId },
                            id: \.id
                        ) { option in
                            Button {
                                binding.wrappedValue =
                                    binding.wrappedValue == option.id ? nil : option.id
                            } label: {
                                if binding.wrappedValue == option.id {
                                    Label(option.name, systemImage: "checkmark")
                                } else {
                                    Text(option.name)
                                }
                            }
                        }
                    }
                } label: {
                    workspaceLabel(
                        railWorkspaceLabel, showsPicker: true,
                        emphasized: secondaryName != nil)
                }
                Spacer()
            } else {
                workspaceLabel(workspaceName)
                Spacer()
            }
        }
    }

    public var body: some View {
        TimelineView(.periodic(from: .now, by: isRunning ? 1 : 3600)) { context in
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.system(size: 9))
                    Text(timecode(liveDuration(now: context.date)))
                        .font(.system(size: 11, design: .monospaced))
                }
                .foregroundStyle(isRunning ? TWTheme.chroma1 : TWTheme.textTertiary)
                if ensembleToggleVisible, let onEnsembleToggle {
                    ComposerEnsembleToggleControl(
                        enabled: ensembleToggleEnabled,
                        disabled: ensembleToggleDisabled,
                        title: ensembleToggleTitle,
                        onSelect: onEnsembleToggle)
                }
                if let onGoalUpdate {
                    GoalRailControl(goal: activeGoal, onUpdate: onGoalUpdate)
                }
                if !planLanes.isEmpty {
                    PlanRailControl(lanes: planLanes)
                }
                Spacer()
                workspaceRailView
                if tokenTelemetryText != nil || costTelemetryText != nil {
                    telemetryView(compact: shouldUseCompactTelemetry)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: TelemetryFooterRailWidthKey.self,
                        value: proxy.size.width)
                }
            )
        }
        .onPreferenceChange(TelemetryFooterRailWidthKey.self) { width in
            guard abs(railWidth - width) > 1 else { return }
            railWidth = width
        }
    }
}

private struct TelemetryFooterRailWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct GoalRailControl: View {
    let goal: RemoteActiveGoal?
    let onUpdate: (String, String?, String?) -> Void

    @State private var presented = false
    @State private var editing = false
    @State private var draft = ""
    @State private var reason = ""

    private var status: String { goal?.status ?? "empty" }

    @MainActor
    private var accent: Color {
        switch goal?.status {
        case "active": return TWTheme.chroma1
        case "paused": return TWTheme.statusAttention
        case "blocked": return TWTheme.statusFailed
        case "completed": return TWTheme.statusSuccess
        default: return TWTheme.textTertiary
        }
    }

    private var modeLabel: String {
        switch goal?.mode {
        case "codex_native": return "Native Codex"
        case "claude_native": return "Native Claude"
        case "ollama_harness": return "Ollama managed"
        case "taskwraith_steered": return "Guided by TaskWraith"
        default: return "Goal"
        }
    }

    var body: some View {
        Button {
            draft = goal?.objective ?? ""
            reason = ""
            editing = goal == nil
            presented = true
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: goal?.status == "completed" ? "checkmark.circle.fill" : "scope")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(accent)
                    .frame(width: 18, height: 18)
                    .background(accent.opacity(goal == nil ? 0 : 0.12), in: RoundedRectangle(cornerRadius: 5))
                if goal?.status == "active" || goal?.status == "paused" || goal?.status == "blocked" {
                    Circle()
                        .fill(accent)
                        .frame(width: 5, height: 5)
                        .offset(x: 2, y: -2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(goal == nil ? "Set active goal" : "Manage active goal")
        .popover(isPresented: $presented) {
            popoverBody
                .frame(width: 320)
                .padding(12)
                .twPopoverGlassSurface()
                .presentationCompactAdaptation(.popover)
        }
    }

    @ViewBuilder
    private var popoverBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(goal == nil ? "Set goal" : "Active goal")
                    .font(.headline)
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
                Text(modeLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
            }

            if goal == nil || editing {
                TextEditor(text: $draft)
                    .font(.callout)
                    .foregroundStyle(TWTheme.textPrimary)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 86)
                    .padding(6)
                    .background(TWTheme.surface3, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(TWTheme.border))
                HStack(spacing: 8) {
                    Button(goal == nil ? "Set goal" : "Save") {
                        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        onUpdate(goal == nil ? "set" : "edit", trimmed, nil)
                        editing = false
                        presented = true
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Cancel") {
                        editing = false
                        if goal == nil { presented = false }
                    }
                    .buttonStyle(.bordered)
                }
            } else if let goal {
                Text(status.capitalized)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(accent.opacity(0.14), in: Capsule())
                    .foregroundStyle(accent)
                Text(goal.objective)
                    .font(.callout)
                    .foregroundStyle(TWTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                if let blockedReason = goal.blockedReason, !blockedReason.isEmpty {
                    Text(blockedReason)
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                TextField("Reason (optional)", text: $reason)
                    .textFieldStyle(.roundedBorder)
                HStack(spacing: 8) {
                    Button("Edit") {
                        draft = goal.objective
                        editing = true
                    }
                    .buttonStyle(.bordered)
                    if goal.status == "paused" || goal.status == "blocked" {
                        Button("Resume") { onUpdate("resume", nil, reason) }
                            .buttonStyle(.bordered)
                    } else if goal.status != "completed" {
                        Button("Pause") { onUpdate("pause", nil, reason) }
                            .buttonStyle(.bordered)
                    }
                    if goal.status != "completed" {
                        Button("Complete") { onUpdate("complete", nil, reason) }
                            .buttonStyle(.borderedProminent)
                    }
                }
                HStack(spacing: 8) {
                    if goal.status != "blocked" && goal.status != "completed" {
                        Button("Block") {
                            onUpdate("block", nil, reason.isEmpty ? "Blocked from mobile." : reason)
                        }
                        .buttonStyle(.bordered)
                    }
                    Button("Clear", role: .destructive) { onUpdate("clear", nil, nil) }
                        .buttonStyle(.bordered)
                }
            }
        }
    }
}

/// Read-only PlanRail control — the footer-rail sibling of GoalRailControl.
/// Shows the agent's working plan (todo checklist). Ensemble chats render one
/// section per author; solo/guest collapse to a single unlabeled list. Mirrors
/// the desktop ActivityStack pinned PlanRail; the plan is the agent's, so it is
/// not user-editable here.
private struct PlanRailControl: View {
    let lanes: [RemoteTodoLane]

    @State private var presented = false

    private var hasInProgress: Bool { lanes.contains { $0.currentStep?.isInProgress == true } }
    private var totalActive: Int { lanes.reduce(0) { $0 + $1.activeCount } }
    private var totalCompleted: Int { lanes.reduce(0) { $0 + $1.completedCount } }
    private var allComplete: Bool { totalActive > 0 && totalCompleted >= totalActive }

    @MainActor
    private var accent: Color {
        if hasInProgress { return TWTheme.chroma1 }
        if allComplete { return TWTheme.statusSuccess }
        return TWTheme.textTertiary
    }

    @MainActor
    private func statusIcon(_ item: RemoteTodoItem) -> (String, Color) {
        if item.isCompleted { return ("checkmark.circle.fill", TWTheme.statusSuccess) }
        if item.isInProgress { return ("circle.lefthalf.filled", TWTheme.chroma1) }
        if item.isCancelled { return ("xmark.circle", TWTheme.textTertiary) }
        return ("circle", TWTheme.textTertiary)
    }

    private var accessibilitySummary: String {
        let base = totalActive > 0 ? "Plan, \(totalCompleted) of \(totalActive) steps done" : "Plan"
        return hasInProgress ? "\(base), in progress" : base
    }

    var body: some View {
        Button { presented = true } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "checklist")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(accent)
                    .frame(width: 18, height: 18)
                    .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
                if hasInProgress {
                    Circle()
                        .fill(accent)
                        .frame(width: 5, height: 5)
                        .offset(x: 2, y: -2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilitySummary)
        .popover(isPresented: $presented) {
            popoverBody
                .frame(width: 320)
                .padding(12)
                .twPopoverGlassSurface()
                .presentationCompactAdaptation(.popover)
        }
    }

    @ViewBuilder
    private var popoverBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Plan")
                    .font(.headline)
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
                if totalActive > 0 {
                    Text("\(totalCompleted)/\(totalActive)")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(TWTheme.textSecondary)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(lanes) { lane in
                        laneSection(lane)
                    }
                }
            }
            .frame(maxHeight: 360)
        }
    }

    @ViewBuilder
    private func laneSection(_ lane: RemoteTodoLane) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !lane.isSolo && lanes.count > 1 {
                HStack(spacing: 6) {
                    Circle()
                        .fill(TWTheme.providerAccent(lane.lane))
                        .frame(width: 7, height: 7)
                    Text(TWTheme.providerLabel(lane.lane))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textSecondary)
                    Spacer()
                    Text("\(lane.completedCount)/\(lane.activeCount)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(TWTheme.textTertiary)
                }
            }
            ForEach(lane.items) { item in
                row(item)
            }
        }
    }

    @ViewBuilder
    private func row(_ item: RemoteTodoItem) -> some View {
        let (icon, color) = statusIcon(item)
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(color)
                .frame(width: 16)
            Text(item.content)
                .font(.callout)
                .foregroundStyle(
                    item.isCompleted || item.isCancelled
                        ? TWTheme.textSecondary : TWTheme.textPrimary
                )
                .strikethrough(item.isCancelled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }
}

// ── Editable in-thread roster strip (desktop ensemble above-row parity) ────
// Chips in a single horizontally-scrolling row (works on iPhone width too —
// wrapping rows got messy fast). Tap a chip for the per-participant editor
// (popover on iPad, sheet on iPhone via compact adaptation): enable toggle,
// role, goal/brief, provider/model, move/remove. Long-press-drag chips to
// reorder. Every commit ships the FULL roster via ensembleRosterUpdate.

// Keep in step with EnsembleRosterSheet and the Mac roster cap.
private let editableRosterMaxParticipants = 20

public struct EditableRosterStrip: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    let workspaceId: String

    @State private var draft: [RemoteSessionModel.RosterDraftEntry] = []
    @State private var draggingId: String? = nil
    /// Id-order we last committed; suppress reconcile until the Mac echoes a
    /// matching order so an in-flight snapshot can't snap a reorder back.
    @State private var pendingOrderIds: [String]? = nil
    /// Chip whose compact editor popover is open (Electron chip-popover parity).
    @Environment(\.horizontalSizeClass) private var editorSizeClass
    /// Side-anchoring the participant editor only pays off where there is
    /// lateral room. On a compact width the composer spans the screen, a
    /// leading arrow pushes the panel off the trailing edge, and it comes back
    /// CLIPPED ON BOTH SIDES — verified on iPhone, and worse than the default.
    ///
    /// The compact fallback is `.bottom`, NOT `.top`. `arrowEdge` names the edge
    /// of the POPOVER carrying the arrow, so `.top` puts the panel BELOW its
    /// anchor — and this anchor is a roster chip pinned directly above the
    /// composer, with roughly 170pt beneath it against 610pt above. `.top`
    /// therefore chose the one side that cannot fit and the panel was clipped
    /// top and bottom (verified). `.bottom` opens it upward into the transcript.
    private var editorArrowEdge: Edge { editorSizeClass == .regular ? .leading : .bottom }

    /// This row's frame in WINDOW coordinates — the anchor every popover here
    /// opens from (chips and the `+` all sit in it). A panel pinned above or
    /// below its anchor is bounded by the gap on that side, and only this view
    /// knows where the gap is: `TWPopoverSpace`'s safe-area estimate reads ~390pt
    /// with the keyboard up while this row, riding the top of a keyboard-raised
    /// composer, has barely 200pt above it.
    ///
    /// Measuring the ROW also makes the budget keyboard-live for free: the
    /// keyboard raises the composer, the row moves, this updates, and the open
    /// popover re-renders with a fresh budget — no second keyboard observer.
    @State private var anchorFrame: CGRect = .zero

    @State private var editingChipId: String? = nil
    @State private var addPopoverPresented = false
    /// Optimistic thread-wide Auto Approvals overlay (cleared on Mac echo).
    @State private var autoApprovalsDraft: Bool? = nil

    /// Called when a chip editor popover opens/closes. The host uses this to
    /// keep the above-rows visible while a popover is open, preventing composer
    /// blur from tearing down the popover's anchor mid-interaction.
    var onChipEditingChange: ((Bool) -> Void)? = nil

    public init(
        model: RemoteSessionModel, threadId: String, workspaceId: String,
        attached: Bool = false, isShellTop: Bool = false, onOwnCard: Bool = false,
        onChipEditingChange: ((Bool) -> Void)? = nil
    ) {
        self.model = model
        self.threadId = threadId
        self.workspaceId = workspaceId
        self.attached = attached
        self.isShellTop = isShellTop
        self.onOwnCard = onOwnCard
        self.onChipEditingChange = onChipEditingChange
    }

    private var state: RemoteEnsembleState? { model.ensembleStates[threadId] }
    private var taskCard: RemoteTaskCard? {
        model.taskCards.first { $0.id == threadId || $0.threadId == threadId }
    }

    private var catalogs: [ProviderModelCatalog] {
        twOfferedProviderCatalogs(
            model.providerModels)
    }

    private func isProviderAvailable(_ provider: String) -> Bool {
        TWTheme.isProviderOfferedByModelCatalog(
            provider,
            models: model.providerModels[provider.lowercased()] ?? model.providerModels[provider] ?? [])
    }

    private var remoteRoster: [RemoteSessionModel.RosterDraftEntry] {
        let entries = (state?.roster ?? [])
            .sorted(by: RemoteEnsembleState.rosterEntryOrder)
            .map { entry in
                RemoteSessionModel.RosterDraftEntry(
                    id: entry.id,
                    provider: entry.provider,
                    model: entry.model,
                    role: entry.role ?? TWTheme.providerLabel(entry.provider),
                    brief: entry.brief ?? "",
                    enabled: entry.enabled ?? true,
                    permissionPresetId: entry.permissionPresetId,
                    reasoningEffort: entry.reasoningEffort,
                    fastModeEnabled: entry.fastModeEnabled ?? false,
                    thinkingEnabled:
                        entry.provider.lowercased() == "kimi" ? true : (entry.thinkingEnabled ?? false),
                    stageRole: entry.stageRole,
                    isBossman: entry.isBossman ?? false,
                    isSecondInCommand: entry.isSecondInCommand ?? false,
                    runtimeProfileId: entry.runtimeProfileId,
                    trustedSessionEnabled: entry.trustedSessionEnabled == true
                )
            }
        return EnsembleRosterAuthorityPolicy.hydrate(
            entries,
            bossmanParticipantId: state?.resolvedBossmanParticipantId,
            captainParticipantIds: state.map(\.resolvedCaptainParticipantIds),
            secondInCommandParticipantId: nil
        )
    }

    /// Round status per participant id (active speaker ring, status dot).
    private func roundStatus(for id: String) -> String? {
        state?.participants?.first { $0.participantId == id }?.status
    }

    // MARK: Thread-wide Boss/Captain Auto Approvals (Auto pill state)

    private var selectedAutoApprovals: Bool {
        autoApprovalsDraft ?? (state?.bossmanAutoApprovalsEnabled == true)
    }

    private var draftHasLeadership: Bool {
        draft.contains { $0.isBossman }
    }

    private func toggleAutoApprovals(_ enabled: Bool) {
        autoApprovalsDraft = enabled
        model.updateEnsembleSettings(
            workspaceId: workspaceId, threadId: threadId,
            bossmanAutoApprovals: enabled)
    }

    private var autoApprovalsConfig: RosterAutoApprovalsConfig {
        RosterAutoApprovalsConfig(
            isOn: selectedAutoApprovals,
            hasLeadership: draftHasLeadership,
            onToggle: { toggleAutoApprovals($0) })
    }

    /// Attached-row mode: rendered INSIDE the composer shell (flat corners,
    /// surface fill, hairline neighbors) instead of floating satellite-style.
    public var attached: Bool = false
    /// Rounds the top corners when this is the shell's FIRST row (no
    /// changes row above).
    public var isShellTop: Bool = false
    /// CS11: this row is on its OWN detached `.composerShell` card, so suppress
    /// its own opaque fill (the shell surface provides it). Prevents double-fill
    /// under Reduce Transparency, where composerAttachedRowFill is surface1 not clear.
    public var onOwnCard: Bool = false

    @ViewBuilder
    private var chipRun: some View {
        HStack(spacing: 6) {
            if let queued = state?.queuedPromptCount, queued > 0 {
                QueuedPromptsChip(count: queued)
            }
            ForEach(draft) { entry in
                chip(entry)
                    .onDrag {
                        draggingId = entry.id
                        return NSItemProvider(object: entry.id as NSString)
                    }
                    .onDrop(
                        of: [.text],
                        delegate: RosterReorderDelegate(
                            item: entry, draft: $draft, draggingId: $draggingId
                        ) {
                            commit()
                        }
                    )
            }
            addMenu
                .padding(.leading, draft.isEmpty ? 0 : 3)
        }
        .padding(.vertical, attached ? 6 : 2)
    }

    public var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                chipRun
                    .fixedSize(horizontal: true, vertical: false)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .center)

            ScrollView(.horizontal, showsIndicators: false) {
                chipRun
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .background(
            attached && !onOwnCard
                ? composerAttachedRowFill()
                : AnyShapeStyle(Color.clear),
            in: UnevenRoundedRectangle(
                topLeadingRadius: attached && isShellTop ? 16 : 0,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: attached && isShellTop ? 16 : 0,
                style: .continuous
            )
        )
        .padding(.horizontal, attached ? 0 : 12)
        .background(
            GeometryReader { proxy in
                let frame = proxy.frame(in: .global)
                Color.clear
                    .onAppear { recordAnchorFrame(frame) }
                    .onChange(of: frame) { _, fresh in recordAnchorFrame(fresh) }
            }
        )
        .onAppear { if draft.isEmpty { draft = remoteRoster } }
        .onChange(of: remoteRoster) { _, fresh in
            // Reconcile from the Mac unless mid-drag. (The chip editor popover
            // keeps its own working copy, so reconciling under it is safe.)
            guard draggingId == nil else { return }
            // Don't let an in-flight snapshot clobber a just-committed reorder:
            // hold the optimistic order until the Mac echoes a matching id-order
            // (it force-broadcasts it). Adopt immediately if membership changed.
            if let pending = pendingOrderIds {
                let freshIds = fresh.map(\.id)
                if freshIds == pending || Set(freshIds) != Set(pending) {
                    pendingOrderIds = nil
                    draft = fresh
                }
                return
            }
            draft = fresh
        }
        .onChange(of: state?.bossmanAutoApprovalsEnabled) { _, fresh in
            if autoApprovalsDraft == (fresh == true) {
                autoApprovalsDraft = nil
            }
        }
        .onChange(of: editingChipId) { _, _ in
            notifyChipEditingChange()
        }
        .onChange(of: addPopoverPresented) { _, _ in
            notifyChipEditingChange()
        }
    }

    private func notifyChipEditingChange() {
        onChipEditingChange?(editingChipId != nil || addPopoverPresented)
    }

    /// Store the measured row frame, QUANTIZED to whole points and only when it
    /// actually moved. A raw `GeometryReader` value written straight back into
    /// `@State` is the classic SwiftUI livelock: a sub-point difference on each
    /// pass re-triggers layout forever and can wedge the first frame.
    private func recordAnchorFrame(_ frame: CGRect) {
        let quantized = CGRect(
            x: frame.origin.x.rounded(), y: frame.origin.y.rounded(),
            width: frame.size.width.rounded(), height: frame.size.height.rounded())
        guard quantized != anchorFrame else { return }
        anchorFrame = quantized
    }

    /// Vertical room the participant / add popovers have on the side they open
    /// toward. nil before the first layout pass measures the row (the panel then
    /// falls back to its own safe-area estimate).
    private var editorSpaceBudget: CGFloat? {
        #if canImport(UIKit)
            guard anchorFrame.height > 0 else { return nil }
            return TWPopoverSpace.availableHeight(
                anchor: anchorFrame, arrowEdge: editorArrowEdge,
                keyboardHeight: TWKeyboardTracker.shared.height)
        #else
            return nil
        #endif
    }

    private func chip(_ entry: RemoteSessionModel.RosterDraftEntry) -> some View {
        let unavailable = !isProviderAvailable(entry.provider)
        let accent =
            unavailable
            ? TWTheme.textMuted
            : TWTheme.providerAccent(entry.provider, modelId: entry.model)
        let status = roundStatus(for: entry.id)
        let isActive = !unavailable && (status == "running" || state?.activeParticipantId == entry.id)
        let live = entry.enabled && !unavailable
        let labelColor: Color = live ? accent : TWTheme.textMuted
        let title =
            entry.role.isEmpty ? TWTheme.providerLabel(entry.provider) : entry.role
        return Button {
            // Compact anchored editor right on the chip (Electron chip-popover
            // parity) — supersedes the roster-page deep link.
            editingChipId = entry.id
        } label: {
            HStack(spacing: 5) {
                if unavailable {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(TWTheme.textMuted)
                } else {
                    ProviderLogoIcon(provider: entry.provider, modelId: entry.model, size: 12)
                        .opacity(live ? 1 : 0.45)
                }
                Text(title)
                    .font(.caption2.weight(isActive ? .bold : .semibold))
                    .foregroundStyle(labelColor)
                    .lineLimit(1)
                    .strikethrough(unavailable, color: TWTheme.textMuted)
                if entry.isBossman {
                    Image(systemName: "crown.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TWTheme.bossCrown)
                        .shadow(color: TWTheme.statusAttention.opacity(0.34), radius: 4)
                        .accessibilityHidden(true)
                }
                if entry.isSecondInCommand {
                    Image(systemName: "shield.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TWTheme.chroma3)
                        .accessibilityHidden(true)
                }
                if status == "done" {
                    Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(TWTheme.statusSuccess)
                } else if status == "skipped" {
                    Image(systemName: "chevron.right.2")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
            .opacity(draggingId == entry.id ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        // Open on touch-down, before composer blur can unmount this strip.
        // A normal Button action races the TextField resign: blur tears down
        // the focus-gated above-rows and the popover never attaches.
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard editingChipId != entry.id else { return }
                    editingChipId = entry.id
                }
        )
        // Open to the LEADING side of the chip, not above it.
        //
        // The roster strip sits directly on top of the composer, so an
        // above-anchored balloon is squeezed between the chip and the top of
        // the screen — and with the keyboard up in landscape that gap is far
        // shorter than this panel, so the system clips the top rows off. Going
        // sideways spends the LONG axis instead: a side-anchored popover is
        // centred vertically on its anchor and can use the full safe height.
        //
        // Leading rather than trailing on purpose: it covers transcript, while
        // trailing would sit over the composer's own send/stop controls.
        .popover(
            isPresented: chipEditorPresentedBinding(for: entry.id),
            attachmentAnchor: .rect(.bounds),
            arrowEdge: editorArrowEdge
        ) {
            RosterParticipantEditorPopover(
                entry: draft.first { $0.id == entry.id } ?? entry,
                catalogs: catalogs,
                canRemove: EnsembleRosterAuthorityPolicy.canRemove(entry.id, from: draft),
                bossDemotionDisabled: entry.isBossman,
                captainAssignmentDisabled:
                    EnsembleRosterAuthorityPolicy.captainAssignmentDisabled(
                        for: entry.id, in: draft),
                backgroundDisabled: !EnsembleRosterAuthorityPolicy.canBackground(
                    entry.id, in: draft),
                onApply: { applyLiveEdit($0) },
                onRemove: { removeChip(id: entry.id) },
                autoApprovals: autoApprovalsConfig,
                requestTrustedSessionChange: { enabled, updated, completion in
                    guard let taskCard else {
                        completion(false)
                        return
                    }
                    model.setTrustedSession(
                        taskCard, enabled: enabled,
                        ensembleParticipantId: updated.id,
                        provider: updated.provider,
                        runtimeProfileId: updated.runtimeProfileId,
                        completion: completion)
                },
                // The gap this balloon opens into, measured on the row itself —
                // without it the panel sizes against the whole safe area and is
                // clipped top and bottom whenever the keyboard is up.
                spaceBudget: editorSpaceBudget,
                onDismissRequest: { editingChipId = nil }
            )
            .presentationCompactAdaptation(.popover)
            // Clear the system popover chrome so the panel's glass blurs the
            // real content behind it (composer-picker parity).
            .presentationBackground(.clear)
        }
        .accessibilityLabel(chipAccessibilityLabel(entry, status: status))
        .accessibilityHint("Opens participant editor. Use actions to reorder.")
        .accessibilityAction(named: Text("Move earlier")) { moveChip(entry, direction: -1) }
        .accessibilityAction(named: Text("Move later")) { moveChip(entry, direction: 1) }
    }

    private func chipEditorPresentedBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { editingChipId == id },
            set: { presented in
                if !presented, editingChipId == id { editingChipId = nil }
            }
        )
    }

    /// Live-apply from the chip editor without closing the popover. The shared
    /// policy preserves every Captain and rejects removal of the configured Boss.
    private func applyLiveEdit(_ updated: RemoteSessionModel.RosterDraftEntry) {
        guard let next = EnsembleRosterAuthorityPolicy.applying(updated, to: draft) else { return }
        draft = next
        commit()
    }

    private func removeChip(id: String) {
        guard let next = EnsembleRosterAuthorityPolicy.removing(id, from: draft) else { return }
        draft = next
        editingChipId = nil
        commit()
    }

    private func chipAccessibilityLabel(
        _ entry: RemoteSessionModel.RosterDraftEntry, status: String?
    ) -> String {
        let title =
            entry.role.isEmpty ? TWTheme.providerLabel(entry.provider) : entry.role
        var parts = [title]
        if entry.isBossman { parts.append("boss") }
        if entry.isSecondInCommand { parts.append("captain") }
        if !entry.enabled || !isProviderAvailable(entry.provider) {
            parts.append("disabled")
        }
        if let status, !status.isEmpty {
            switch status {
            case "running": parts.append("speaking")
            case "done": parts.append("done")
            case "skipped": parts.append("skipped")
            default: parts.append(status)
            }
        } else if state?.activeParticipantId == entry.id {
            parts.append("speaking")
        }
        return parts.joined(separator: ", ")
    }

    private func moveChip(
        _ entry: RemoteSessionModel.RosterDraftEntry, direction: Int
    ) {
        guard let index = draft.firstIndex(where: { $0.id == entry.id }) else { return }
        let target = index + direction
        guard target >= 0, target < draft.count else { return }
        draft.swapAt(index, target)
        commit()
    }

    private var addMenu: some View {
        // Electron add-participant parity: the "+" anchors ONE popover with
        // the participant fields above the combined model list + reasoning
        // ladder, confirmed by its `Add` button — no provider-menu two-step.
        Button {
            addPopoverPresented = true
        } label: {
            Image(systemName: "plus")
                .font(.caption.weight(.semibold))
                .foregroundStyle(
                    draft.count >= editableRosterMaxParticipants
                        ? TWTheme.textMuted : TWTheme.textSecondary
                )
                .frame(width: 24, height: 24)
                .background(TWTheme.surface3, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(draft.count >= editableRosterMaxParticipants)
        // Same touch-down open as chips — beat composer blur tearing the strip down.
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    guard !addPopoverPresented,
                        draft.count < editableRosterMaxParticipants
                    else { return }
                    addPopoverPresented = true
                }
        )
        .popover(isPresented: $addPopoverPresented) {
            RosterAddParticipantPopover(
                catalogs: catalogs,
                threadAutoApprovalsEnabled: selectedAutoApprovals,
                threadHasLeadership: draftHasLeadership,
                captainAssignmentDisabled:
                    draft.filter { $0.isSecondInCommand }.count
                    >= EnsembleRosterAuthorityPolicy.maximumCaptainCount,
                onAdd: { entry, stagedAutoApprovals in
                    addPopoverPresented = false
                    appendParticipant(entry)
                    // Staged Auto toggle applies AFTER the roster commit so a
                    // drafted Boss/Captain exists Mac-side first (actions are
                    // processed in send order).
                    if let stagedAutoApprovals,
                        draft.contains(where: { $0.isBossman })
                            || !stagedAutoApprovals
                    {
                        toggleAutoApprovals(stagedAutoApprovals)
                    }
                },
                // Same row, same gap (see the chip editor above).
                spaceBudget: editorSpaceBudget,
                onDismissRequest: { addPopoverPresented = false }
            )
            .presentationCompactAdaptation(.popover)
            .presentationBackground(.clear)
        }
        .accessibilityLabel("Add participant")
        .accessibilityHint(
            draft.count >= editableRosterMaxParticipants
                ? "Ensembles support up to \(editableRosterMaxParticipants) participants."
                : "Add another participant."
        )
    }

    private func appendParticipant(_ entry: RemoteSessionModel.RosterDraftEntry) {
        guard draft.count < editableRosterMaxParticipants else { return }
        guard let next = EnsembleRosterAuthorityPolicy.appending(entry, to: draft) else { return }
        draft = next
        commit()
    }

    private func commit() {
        guard !draft.isEmpty else { return }
        let normalized = EnsembleRosterAuthorityPolicy.normalize(draft)
        guard EnsembleRosterAuthorityPolicy.hasConfiguredBoss(normalized) else { return }
        draft = normalized
        pendingOrderIds = draft.map(\.id)
        model.updateEnsembleRoster(
            workspaceId: workspaceId, threadId: threadId, entries: draft)
    }

}

/// Drag-to-reorder drop delegate — reorders the draft live as the dragged
/// chip passes over siblings; commits once on drop.
struct RosterReorderDelegate: DropDelegate {
    let item: RemoteSessionModel.RosterDraftEntry
    @Binding var draft: [RemoteSessionModel.RosterDraftEntry]
    @Binding var draggingId: String?
    let onCommit: () -> Void

    func dropEntered(info: DropInfo) {
        guard let draggingId, draggingId != item.id,
            let from = draft.firstIndex(where: { $0.id == draggingId }),
            let to = draft.firstIndex(where: { $0.id == item.id })
        else { return }
        withAnimation(.easeInOut(duration: 0.15)) {
            draft.move(
                fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        draggingId = nil
        onCommit()
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }
}

// (RosterChipEditor — the full-height per-participant editor sheet — was
// retired in favor of the compact anchored RosterParticipantEditorPopover /
// RosterAddParticipantPopover in RosterParticipantPopover.swift, the Electron
// chip-popover twins.)

// ── Agent identity badge (sub-agent identicon parity, minimal form) ────────
// The desktop renders full hand-drawn catalog characters; the phone's
// minimal-parity badge keeps the three identity carriers — NAME, accent
// HUE, and a unique mark — using the ghost wordmark tinted with the
// agent's accent inside an accent ring, plus an orbital satellite dot
// whose angle derives from the SAME FNV-1a hash the desktop's identicon
// picker uses (agentIdenticon.ts), echoing the catalog's orbital motif.

public func twAgentIdenticonHash(_ seed: String?) -> UInt32 {
    let value = (seed?.trimmingCharacters(in: .whitespaces).lowercased()).flatMap {
        $0.isEmpty ? nil : $0
    } ?? "agent"
    var hash: UInt32 = 0x811c_9dc5
    for unit in value.utf16 {
        hash ^= UInt32(unit)
        hash = hash &* 0x0100_0193
    }
    return hash
}

@MainActor public func twAgentAccentColor(_ hex: String?) -> Color {
    guard var hexString = hex?.trimmingCharacters(in: .whitespaces), !hexString.isEmpty else {
        return TWTheme.chroma1
    }
    if hexString.hasPrefix("#") { hexString.removeFirst() }
    guard hexString.count == 6, let value = UInt32(hexString, radix: 16) else {
        return TWTheme.chroma1
    }
    return Color(
        red: Double((value >> 16) & 0xFF) / 255,
        green: Double((value >> 8) & 0xFF) / 255,
        blue: Double(value & 0xFF) / 255
    )
}

public struct AgentIdentityBadge: View {
    let name: String
    let accentHex: String?
    let slug: String?
    var size: CGFloat = 22

    public init(name: String, accentHex: String?, slug: String?, size: CGFloat = 22) {
        self.name = name
        self.accentHex = accentHex
        self.slug = slug
        self.size = size
    }

    private var accent: Color { twAgentAccentColor(accentHex) }

    private var orbitalAngle: Angle {
        .degrees(Double(twAgentIdenticonHash(slug ?? name) % 360))
    }

    /// Full hand-drawn catalog character (baked from the named SVGs into
    /// the package resources via qlmanage). Nil when the slug has no baked
    /// asset — the minimal ring badge below covers that.
    /// Internal (not private) so the transcript satellite can reuse it.
    static func catalogImage(for slug: String?) -> Image? {
        guard let slug, !slug.isEmpty else { return nil }
        #if canImport(UIKit)
            if let url = Bundle.module.url(
                forResource: "identicon-\(slug)", withExtension: "png"),
                let data = try? Data(contentsOf: url),
                let ui = UIImage(data: data)
            {
                return Image(uiImage: ui)
            }
            if let ui = UIImage(named: "identicon-\(slug)") {
                return Image(uiImage: ui)
            }
        #endif
        return nil
    }

    public var body: some View {
        ZStack {
            if let catalog = Self.catalogImage(for: slug) {
                Circle().fill(accent.opacity(0.10))
                catalog
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.06)
                Circle().strokeBorder(accent.opacity(0.5), lineWidth: 1)
            } else {
                Circle()
                    .fill(accent.opacity(0.14))
                Circle()
                    .strokeBorder(accent.opacity(0.65), lineWidth: 1.2)
                GhostMarkView()
                    .frame(width: size * 0.62, height: size * 0.62)
                    .colorMultiply(accent)
                // Orbital satellite — the per-character motif from the catalog.
                Circle()
                    .fill(accent)
                    .frame(width: size * 0.18, height: size * 0.18)
                    .offset(y: -size / 2)
                    .rotationEffect(orbitalAngle)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Text(name))
    }
}

/// Compact context-window usage ring — the phone port of the desktop
/// `ContextWheel`. A thin track with an arc that fills clockwise from the top
/// as the thread approaches the model's context limit. Non-interactive; sits
/// just left of the composer send button. The ink color is supplied by the
/// caller (the composer passes its shell's text color) so the ring inherits
/// each shell's palette, mirroring the desktop's `currentColor` inheritance.
public struct ContextDonut: View {
    /// 0...100 — percent of the context window consumed (clamped on render).
    let percent: Double
    let color: Color
    var size: CGFloat = 15
    private let lineWidth: CGFloat = 2

    public init(percent: Double, color: Color, size: CGFloat = 15) {
        self.percent = percent
        self.color = color
        self.size = size
    }

    private var fraction: CGFloat { CGFloat(max(0, min(100, percent)) / 100) }

    public var body: some View {
        ZStack {
            Circle()
                .inset(by: lineWidth / 2)
                .stroke(color.opacity(0.16), lineWidth: lineWidth)
            // Arc fills clockwise from 12 o'clock: trim() starts at 3 o'clock,
            // so -90° rotates the start up to the top (matches the desktop wheel).
            Circle()
                .inset(by: lineWidth / 2)
                .trim(from: 0, to: fraction)
                .stroke(
                    color.opacity(0.62),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Text("Context \(Int(percent.rounded()))% used"))
    }
}

/// Masthead logo — the WWDC26 ghost until 9 Jul 2026, then the sticker.
/// (Date gate per the 28-day request from 11 Jun 2026; revert = this view
/// flips automatically, no code change needed.)
public struct MastheadLogoView: View {
    public var size: CGFloat = 34

    public init(size: CGFloat = 34) { self.size = size }

    private static let wwdcCutoff: Date = {
        var components = DateComponents()
        components.year = 2026
        components.month = 7
        components.day = 9
        return Calendar.current.date(from: components) ?? .distantPast
    }()

    private var resourceName: String {
        Date() < Self.wwdcCutoff ? "masthead-wwdc26" : "masthead-sticker"
    }

    public var body: some View {
        Group {
            #if canImport(UIKit)
                if let url = Bundle.module.url(
                    forResource: resourceName, withExtension: "png"),
                    let data = try? Data(contentsOf: url),
                    let ui = UIImage(data: data)
                {
                    Image(uiImage: ui)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
                } else {
                    GhostMarkView(size: size)
                }
            #else
                GhostMarkView(size: size)
            #endif
        }
        .frame(width: size, height: size)
    }
}

private enum MobileSettingsGroup: String, CaseIterable, Identifiable {
    case app
    case aiProviders
    case automation
    case workspaces
    case integrations
    case data

    var id: String { rawValue }

    var label: String {
        switch self {
        case .app: return "App"
        case .aiProviders: return "AI & Providers"
        case .automation: return "Automation"
        case .workspaces: return "Workspaces"
        case .integrations: return "Integrations"
        case .data: return "Data"
        }
    }
}

private enum MobileSettingsSection: String, CaseIterable, Identifiable, Hashable {
    case appearance
    case composer
    case providers
    case approvals
    case workspaces
    case remote
    case modelUsage
    case privacy
    case guide

    var id: String { rawValue }

    var title: String {
        switch self {
        case .appearance: return "Appearance"
        case .composer: return "Composer & Transcript"
        case .providers: return "Providers"
        case .approvals: return "Approvals"
        case .workspaces: return "Workspaces"
        case .remote: return "Devices & Hosts"
        case .modelUsage: return "Model Usage"
        case .privacy: return "About & Privacy"
        case .guide: return "First-launch guide"
        }
    }

    var subtitle: String {
        switch self {
        case .appearance: return "Theme, accent, app icon, and display size."
        case .composer: return "Composer shell, tools, and transcript type."
        case .providers: return "Readiness, availability, and Mac-owned setup."
        case .approvals: return "Live requests, questions, and approval boundaries."
        case .workspaces: return "Visible workspaces and remote access scope."
        case .remote: return "Pairing, host reachability, and device identity."
        case .modelUsage: return "Quota windows, usage snapshots, and coverage."
        case .privacy: return "Version, transport, and data boundaries."
        case .guide: return "Provider, usage, approvals, and Ensemble orientation."
        }
    }

    var group: MobileSettingsGroup {
        switch self {
        case .appearance, .composer: return .app
        case .providers: return .aiProviders
        case .approvals: return .automation
        case .workspaces: return .workspaces
        case .remote: return .integrations
        case .modelUsage, .privacy, .guide: return .data
        }
    }

    var systemImage: String {
        switch self {
        case .appearance: return "paintpalette"
        case .composer: return "text.bubble"
        case .providers: return "switch.2"
        case .approvals: return "checkmark.shield"
        case .workspaces: return "folder"
        case .remote: return "macbook.and.iphone"
        case .modelUsage: return "chart.bar.xaxis"
        case .privacy: return "info.circle"
        case .guide: return "questionmark.circle"
        }
    }

    var searchText: String {
        [
            title, subtitle, group.label, rawValue,
            "settings", "preferences",
            self == .providers
                ? "codex claude kimi cursor grok ollama models readiness sign in login api keys cli mcp tools browser automation integrations setup local runtimes"
                : "",
            self == .approvals ? "permissions approve decline questions grants timeouts" : "",
            self == .workspaces ? "workspace allowlist folder project file write read" : "",
            self == .modelUsage ? "usage quota tokens cost windows dashboard snapshots" : "",
            self == .privacy ? "approvals grants safety data local history visibility version transport about taskwraith" : "",
            self == .remote ? "pairing workspace mac devices hosts reconnect switch forget" : "",
            self == .composer ? "shell transcript font tool call style" : "",
            self == .appearance ? "theme accent color icon glass scale zoom display size font text" : ""
        ].joined(separator: " ").lowercased()
    }
}

/// App settings - full-screen mobile surface mirroring the desktop settings
/// IA while keeping iPhone navigation native. iPad gets a persistent settings
/// sidebar; iPhone gets a searchable category list that pushes detail pages.
public struct AppSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.appScale) private var appScale
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted
    @ObservedObject private var model: RemoteSessionModel
    @ObservedObject private var themes = TWThemeStore.shared
    @State private var appIcon: TWAppIconVariant = TWAppIconController.selected
    @State private var selectedSection: MobileSettingsSection = .appearance
    @State private var compactPath: [MobileSettingsSection] = []
    @State private var searchText = ""
    /// Non-nil presents the read-only approval ledger for that workspace.
    @State private var approvalLedgerWorkspaceId: String? = nil
    /// Per-device master switch for the workspace terminal (same key the
    /// GitWorkspaceSurface entry reads).
    @AppStorage("tw.terminal.enabled") private var terminalEnabledOnDevice = false

    private var terminalEnabledBinding: Binding<Bool> {
        Binding(get: { terminalEnabledOnDevice }, set: { terminalEnabledOnDevice = $0 })
    }
    private let onOpenFirstLaunchGuide: (() -> Void)?

    public init(model: RemoteSessionModel, onOpenFirstLaunchGuide: (() -> Void)? = nil) {
        self.model = model
        self.onOpenFirstLaunchGuide = onOpenFirstLaunchGuide
    }

    /// Clear over liquid-glass sheets; opaque app canvas only when not glass-hosted.
    private var canvasFill: Color {
        glassSheetHosted ? Color.clear : TWTheme.appBg
    }

    private var sidebarFill: Color {
        glassSheetHosted
            ? (twGlassSheetChromeFill(glassSheetHosted: true) ?? TWTheme.sidebarBg.opacity(0.72))
            : TWTheme.sidebarBg
    }

    private var sections: [MobileSettingsSection] {
        MobileSettingsSection.allCases.filter { section in
            if section == .guide, onOpenFirstLaunchGuide == nil { return false }
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return query.isEmpty || section.searchText.contains(query)
        }
    }

    public var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                regularBody
            } else {
                compactBody
            }
        }
        .background(canvasFill.ignoresSafeArea())
        .twColorScheme()
    }

    private var compactBody: some View {
        NavigationStack(path: $compactPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    compactHeader
                    searchField
                    sectionList
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 18)
            }
            .background(canvasFill.ignoresSafeArea())
            .navigationTitle("Settings")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { closeToolbarItem }
            .navigationDestination(for: MobileSettingsSection.self) { section in
                detailScroll(section)
                    .navigationTitle(section.title)
                    #if os(iOS)
                        .navigationBarTitleDisplayMode(.inline)
                    #endif
            }
        }
    }

    private var regularBody: some View {
        NavigationStack {
            HStack(spacing: 0) {
                settingsSidebar
                    .frame(width: appScale.scaled(300))
                    .background(sidebarFill)
                    .iPadSidebarInnerRim(edge: .trailing)
                detailScroll(selectedSection)
            }
            .background(canvasFill.ignoresSafeArea())
            .toolbar { closeToolbarItem }
        }
    }

    private var closeToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button {
                dismiss()
            } label: {
                Label("Back to app", systemImage: "chevron.left")
            }
        }
    }

    private var compactHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                GhostMonolineMarkView(size: 38, glow: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("TaskWraith Settings")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text("Remote companion preferences for this iPhone or iPad.")
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textSecondary)
                }
                Spacer(minLength: 0)
            }
            settingsOverviewStrip
        }
    }

    private var settingsSidebar: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button {
                dismiss()
            } label: {
                Label("Back to app", systemImage: "chevron.left")
                    .font(.headline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(TWTheme.surface1.opacity(0.72), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .foregroundStyle(TWTheme.textPrimary)

            searchField
            settingsOverviewStrip

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    groupedSectionButtons
                }
                .padding(.bottom, 20)
            }
            Spacer(minLength: 0)
            Text("TaskWraith Remote")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TWTheme.textMuted)
        }
        .padding(16)
    }

    private var sectionList: some View {
        VStack(alignment: .leading, spacing: 18) {
            groupedSectionButtons
        }
    }

    private var groupedSectionButtons: some View {
        ForEach(MobileSettingsGroup.allCases) { group in
            let rows = sections.filter { $0.group == group }
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(group.label)
                        .font(.caption2.weight(.bold))
                        .textCase(.uppercase)
                        .foregroundStyle(TWTheme.textTertiary)
                        .padding(.horizontal, 4)
                    VStack(spacing: 8) {
                        ForEach(rows) { section in
                            sectionButton(section)
                        }
                    }
                }
            }
        }
    }

    private var searchField: some View {
        let fieldFill =
            twGlassSheetChromeFill(glassSheetHosted: glassSheetHosted)
            ?? TWTheme.surface1.opacity(0.86)
        return HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(TWTheme.textTertiary)
            TextField("Search settings...", text: $searchText)
                .foregroundStyle(TWTheme.textPrimary)
        }
        .font(.body)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(fieldFill, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(TWTheme.border, lineWidth: 1)
        )
    }

    private var settingsOverviewStrip: some View {
        HStack(spacing: 8) {
            SettingsMetricPill(title: "Theme", value: themes.systemTheme.label, systemImage: "circle.lefthalf.filled")
            SettingsMetricPill(title: "Composer", value: composerShellLabel, systemImage: "text.bubble")
        }
    }

    private func sectionButton(_ section: MobileSettingsSection) -> some View {
        let rowFill =
            section == selectedSection
            ? TWTheme.chroma1.opacity(0.16)
            : (twGlassSheetChromeFill(glassSheetHosted: glassSheetHosted) ?? TWTheme.surface1)
        return Button {
            if horizontalSizeClass == .regular {
                selectedSection = section
            } else {
                compactPath.append(section)
            }
        } label: {
            HStack(spacing: 12) {
                SettingsIconPlate(systemImage: section.systemImage, selected: selectedSection == section)
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text(section.subtitle)
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textSecondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Image(systemName: horizontalSizeClass == .regular ? "chevron.right" : "chevron.forward")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textTertiary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(rowFill, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .strokeBorder(section == selectedSection ? TWTheme.chroma1.opacity(0.38) : TWTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(section.title)
        .accessibilityValue(section.subtitle)
    }

    private func detailScroll(_ section: MobileSettingsSection) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                detailHeader(section)
                switch section {
                case .appearance: appearanceSection
                case .composer: composerSection
                case .providers: providersSection
                case .approvals: approvalsSection
                case .workspaces: workspacesSection
                case .remote: remoteSection
                case .modelUsage: modelUsageSection
                case .privacy: privacySection
                case .guide: guideSection
                }
            }
                .padding(.horizontal, appScale.scaled(horizontalSizeClass == .regular ? 28 : 16))
                .padding(.vertical, appScale.scaled(20))
                .frame(maxWidth: horizontalSizeClass == .regular ? appScale.scaled(840) : .infinity, alignment: .topLeading)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(canvasFill.ignoresSafeArea())
    }

    private func detailHeader(_ section: MobileSettingsSection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                SettingsIconPlate(systemImage: section.systemImage, selected: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text(section.subtitle)
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textSecondary)
                }
            }
        }
        .padding(.top, horizontalSizeClass == .regular ? 18 : 0)
    }

    private var appearanceSection: some View {
        VStack(spacing: 12) {
            #if os(iOS)
                SettingsCard(title: "App icon", systemImage: "app.dashed") {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 112), spacing: 10)], spacing: 10) {
                        ForEach(TWAppIconVariant.available()) { variant in
                            appIconButton(variant)
                        }
                    }
                    Text("Changes the home-screen icon. Light, dark, and tinted variants follow iOS automatically.")
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textSecondary)
                }
            #endif
            SettingsCard(title: "Display size", systemImage: "textformat.size") {
                SettingsValueRow(title: "Current", value: "\(themes.appScalePreference.label) · \(themes.appScalePreference.valueLabel)")
                appScaleControl
                Text("Changes TaskWraith's local iPhone/iPad interface size. Default is the current layout.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SettingsCard(title: "System theme", systemImage: "circle.lefthalf.filled") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
                    ForEach(TWSystemTheme.allCases) { theme in
                        themeButton(theme)
                    }
                }
            }
            SettingsCard(title: "Accent color", systemImage: "paintpalette") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 8)], spacing: 8) {
                    ForEach(TWAccentTheme.allCases) { accent in
                        accentButton(accent)
                    }
                }
            }
        }
    }

    private var composerSection: some View {
        VStack(spacing: 12) {
            SettingsCard(title: "Composer shell", systemImage: "rectangle.and.pencil.and.ellipsis") {
                Picker(
                    "Style",
                    selection: Binding<String>(
                        get: {
                            switch themes.composerShellPreference {
                            case .followMac: return "followMac"
                            case .override(let style): return style.raw
                            }
                        },
                        set: { raw in
                            themes.composerShellPreference =
                                raw == "followMac"
                                ? .followMac : .override(TWComposerStyle(raw: raw))
                        }
                    )
                ) {
                    Text("Follow Mac").tag("followMac")
                    ForEach(TWComposerStyle.known, id: \.raw) { style in
                        Text(style.label).tag(style.raw)
                    }
                }
                .pickerStyle(.menu)
                Text("Follow Mac mirrors your desktop composer style. Override to pin a style on this device.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                composerPreviewCard
            }
            SettingsCard(title: "Transcript", systemImage: "textformat") {
                Picker(
                    "Response font",
                    selection: Binding(
                        get: { themes.transcriptFontPreference },
                        set: { themes.transcriptFontPreference = $0 }
                    )
                ) {
                    ForEach(TWTranscriptFont.allCases, id: \.self) { font in
                        Text(font.label)
                            .font(TWFont.font(for: font, size: 16, relativeTo: .body))
                            .tag(font)
                    }
                }
                .pickerStyle(.menu)
                Text("Typeface for assistant response text in the transcript.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
            }
            SettingsCard(title: "Tool-call color", systemImage: "wrench.and.screwdriver") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 8)], spacing: 8) {
                    ForEach(TWToolTheme.allCases) { tool in
                        toolButton(tool)
                    }
                }
            }
        }
    }

    private var providersSection: some View {
        VStack(spacing: 12) {
            SettingsCard(title: "Readiness snapshot", systemImage: "switch.2") {
                if providerSnapshots.isEmpty {
                    SettingsInfoRow(
                        icon: "circle.dashed",
                        title: "Waiting for the Mac's readiness snapshot",
                        detail: "Provider status appears within a few seconds of connecting. Setup and sign-in stay on the Mac."
                    )
                } else {
                    SettingsValueRow(title: "Providers", value: "\(providerSnapshots.count) visible")
                    if let asOf = snapshotTimeText(model.modelUsage?.generatedAt) {
                        SettingsValueRow(title: "Snapshot", value: asOf)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 10)], spacing: 10) {
                        ForEach(providerSnapshots) { card in
                            providerReadinessRow(card)
                        }
                    }
                }
                Text("Sign in, install CLIs, manage API keys, MCP tool servers, and local runtimes on the Mac.")
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var approvalsSection: some View {
        VStack(spacing: 12) {
            // The durable audit: the desktop owns the ledger; the phone can
            // now READ it — the phone user is exactly the one who was not
            // watching when something auto-denied overnight.
            SettingsCard(title: "Approval ledger", systemImage: "list.bullet.rectangle") {
                if model.workspaces.isEmpty {
                    SettingsInfoRow(
                        icon: "clock",
                        title: "No workspaces visible",
                        detail: "Pair with a Mac and grant a workspace to read its decision history."
                    )
                } else {
                    ForEach(model.workspaces, id: \.id) { workspace in
                        Button {
                            approvalLedgerWorkspaceId = workspace.id
                        } label: {
                            HStack {
                                Text(workspace.displayName)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(TWTheme.textPrimary)
                                Spacer(minLength: 6)
                                Text("Recent decisions")
                                    .font(.caption2)
                                    .foregroundStyle(TWTheme.textSecondary)
                                Image(systemName: "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(TWTheme.textMuted)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            SettingsCard(title: "Live requests", systemImage: "hand.raised") {
                SettingsValueRow(title: "Approvals waiting", value: "\(model.approvals.count)")
                EmptyView()
                    .sheet(
                        isPresented: Binding(
                            get: { approvalLedgerWorkspaceId != nil },
                            set: { if !$0 { approvalLedgerWorkspaceId = nil } })
                    ) {
                        if let workspaceId = approvalLedgerWorkspaceId {
                            ApprovalLedgerSheet(model: model, workspaceId: workspaceId)
                                .twSheetLiquidGlass(detents: [.large])
                        }
                    }
                SettingsValueRow(title: "Questions waiting", value: "\(model.questions.count)")
                if model.approvals.isEmpty && model.questions.isEmpty {
                    SettingsInfoRow(
                        icon: "checkmark.circle",
                        title: "Nothing needs attention",
                        detail: "Approval and question cards will appear in the active chat when a provider pauses for user input."
                    )
                } else {
                    ForEach(Array(model.approvals.prefix(3).enumerated()), id: \.offset) { _, card in
                        Button {
                            if let threadId = card.threadId, !threadId.isEmpty {
                                model.selectedTaskId = threadId
                                dismiss()
                            }
                        } label: {
                            attentionSummaryRow(
                                icon: "checkmark.shield",
                                title: card.title ?? "Approval request",
                                detail: card.body ?? "Approval requested by \(TWTheme.providerLabel(card.provider ?? "provider"))."
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(card.threadId == nil || card.threadId?.isEmpty == true)
                    }
                    ForEach(Array(model.questions.prefix(3).enumerated()), id: \.offset) { _, card in
                        Button {
                            if let threadId = card.threadId, !threadId.isEmpty {
                                model.selectedTaskId = threadId
                                dismiss()
                            }
                        } label: {
                            attentionSummaryRow(
                                icon: "questionmark.bubble",
                                title: card.resolvedQuestion ?? "Question from \(TWTheme.providerLabel(card.provider ?? "provider"))",
                                detail: card.context ?? "Answer from the active thread."
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(card.threadId == nil || card.threadId?.isEmpty == true)
                    }
                }
            }
            SettingsCard(title: "Boundary", systemImage: "lock.badge.clock") {
                SettingsInfoRow(
                    icon: "iphone",
                    title: "Phone can answer live prompts",
                    detail: "Accept, decline, session/workspace grants, and ask-user questions are actionable when projected to iOS."
                )
                SettingsInfoRow(
                    icon: "desktopcomputer",
                    title: "Ledger and policy live on Mac",
                    detail: "Approval history, grant revocation, provider policies, and timeout tuning remain desktop settings."
                )
            }
        }
    }

    private var workspacesSection: some View {
        VStack(spacing: 12) {
            SettingsCard(title: "Workspace terminal", systemImage: "terminal") {
                Toggle(isOn: terminalEnabledBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Enable terminal on this device")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(TWTheme.textPrimary)
                        Text(
                            "A real shell in a workspace's folder — beyond every agent posture. Each session also needs the Mac's own approval, and it is recorded in the approval ledger."
                        )
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .tint(TWTheme.statusAttention)
            }
            SettingsCard(title: "Workspace access", systemImage: "folder") {
                SettingsValueRow(title: "Visible", value: "\(model.workspaces.count)")
                SettingsValueRow(
                    title: "Running",
                    value: "\(model.workspaces.reduce(0) { $0 + ($1.runningChatCount ?? 0) })"
                )
                SettingsInfoRow(
                    icon: "lock.open",
                    title: "Allowlist is Mac-owned",
                    detail: "The Mac owns the allowlist; where granted, this device can toggle its own workspace access."
                )
                if model.workspaces.isEmpty {
                    SettingsInfoRow(
                        icon: "folder.badge.questionmark",
                        title: "No shared workspaces yet",
                        detail: "Open TaskWraith on the Mac and grant this device workspace access in Settings -> Devices."
                    )
                } else {
                    ForEach(Array(model.workspaces.prefix(4))) { workspace in
                        workspaceSummaryRow(workspace)
                    }
                }
            }
        }
    }

    private var remoteSection: some View {
        VStack(spacing: 12) {
            SettingsCard(title: "Connected host", systemImage: "macbook.and.iphone") {
                SettingsValueRow(title: "Mac", value: model.macDisplayName.isEmpty ? "TaskWraith Mac" : model.macDisplayName)
                SettingsValueRow(title: "Connection", value: connectionStatusLabel)
                SettingsValueRow(title: "Paired hosts", value: "\(model.pairedHosts.count)")
                SettingsInfoRow(
                    icon: "key.horizontal",
                    title: "Identity is pinned",
                    detail: "The Mac trusts this device by public identity. Resetting or revoking trust is intentionally Mac-managed."
                )
                SettingsInfoRow(
                    icon: "wifi",
                    title: "Reachability follows the relay",
                    detail: "Reconnect and wake flows reuse the active host stored on this device."
                )
            }
            SettingsCard(title: "Finish notifications", systemImage: "bell.badge") {
                Toggle(
                    isOn: Binding(
                        get: { model.notifyFinishedTurns },
                        set: { model.setNotifyFinishedTurns($0) })
                ) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notify when a task finishes")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(TWTheme.textPrimary)
                        Text(
                            "Applies to the project-operated relay while this app is closed. The phone signs the preference; message content never enters the relay."
                        )
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .tint(TWTheme.statusSuccess)
                SettingsValueRow(
                    title: "Project gateway", value: completionPushGatewayStatusLabel)
                if completionPushGatewayCanRetry {
                    Button("Retry gateway registration") {
                        model.retryProjectPushGatewayRegistration()
                    }
                    .buttonStyle(.bordered)
                }
            }
            SettingsCard(title: "Paired devices", systemImage: "iphone.and.arrow.forward") {
                if model.pairedHosts.isEmpty {
                    SettingsInfoRow(
                        icon: "plus.circle",
                        title: "No trusted host on this device",
                        detail: "Pair from the opening screen to connect this iPhone or iPad to TaskWraith on a Mac."
                    )
                } else {
                    ForEach(Array(model.pairedHosts.prefix(4))) { host in
                        pairedHostRow(host)
                    }
                }
                SettingsInfoRow(
                    icon: "slider.horizontal.3",
                    title: "Switching and revocation stay deliberate",
                    detail: "Use the pairing flow for host switching. Revoke device access from the Mac when removing trust."
                )
            }
        }
    }

    private var completionPushGatewayStatusLabel: String {
        switch model.completionPushGatewayStatus {
        case .directOnly:
            return "Not advertised"
        case .registering(let totalHosts):
            return totalHosts == 1 ? "Registering…" : "Registering \(totalHosts) hosts…"
        case .registered(let hosts):
            return hosts == 1 ? "Ready" : "Ready on \(hosts) hosts"
        case .optedOut(let hosts):
            return hosts == 1 ? "Opted out" : "Opted out on \(hosts) hosts"
        case .partial(let registered, let total, _):
            return "Partial · \(registered)/\(total) hosts"
        case .failed:
            return "Registration failed"
        }
    }

    private var completionPushGatewayCanRetry: Bool {
        switch model.completionPushGatewayStatus {
        case .partial, .failed:
            return true
        default:
            return false
        }
    }

    private var modelUsageSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingsCard(title: "Coverage", systemImage: "chart.bar.xaxis") {
                if (model.modelUsage?.providers.count ?? 0) == 0 {
                    SettingsInfoRow(
                        icon: "circle.dashed",
                        title: "No usage snapshot yet",
                        detail: "Quota windows appear after the Mac broadcasts its first usage snapshot."
                    )
                } else {
                    SettingsValueRow(title: "Quota providers", value: "\(model.modelUsage?.providers.count ?? 0)")
                    if let asOf = snapshotTimeText(model.modelUsage?.generatedAt) {
                        SettingsValueRow(title: "Usage snapshot", value: asOf)
                    }
                }
                SettingsInfoRow(
                    icon: "info.circle",
                    title: "Mac-formatted usage remains authoritative",
                    detail: "Quota windows and dashboard stats are projected from the desktop. Provider coverage follows whatever the Mac can currently observe."
                )
            }
            if let dashboard = model.welcomeDashboard {
                WelcomeUsageDashboardCard(dashboard: dashboard, accent: TWTheme.chroma1)
            }
            VStack(alignment: .leading, spacing: 10) {
                Label("Model usage", systemImage: "chart.bar.xaxis")
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                UsagePanel(model: model, threadId: nil)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Preserve the existing standalone context reference for older Macs.
            // Newer broadcasts advertise Spend (and optional AntiGravity budget),
            // which unlocks UsagePanel's compact Plan / Spend / Context switch.
            if model.modelUsage?.spend == nil
                && model.modelUsage?.antigravityBudget == nil
                && model.modelUsage?.museBudget == nil
            {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Model Context Lengths", systemImage: "ruler")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text("Official maximum context window per model.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                    // Gemini is retired on iOS (TWTheme.retiredProviderIds) and never
                    // selectable here, so it is excluded; local Ollama is included.
                    ContextLengthsView(includeOllama: true, excludeProviders: ["gemini"])
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var privacySection: some View {
        VStack(spacing: 12) {
            SettingsCard(title: "About", systemImage: "info.circle") {
                SettingsValueRow(title: "App", value: "TaskWraith Remote")
                SettingsValueRow(title: "Version", value: appVersionLabel)
                SettingsValueRow(title: "Transport", value: "taskwraith-e2ee-v1")
                ThirdPartyNoticesSettingsView()
            }
            SettingsCard(title: "Safety posture", systemImage: "checkmark.shield") {
                SettingsInfoRow(
                    icon: "hand.raised",
                    title: "Approvals pause on the Mac",
                    detail: "When a provider asks for permission, the desktop owns the durable ledger; iPhone can answer the live prompt."
                )
                SettingsInfoRow(
                    icon: "iphone.slash",
                    title: "App switcher shield",
                    detail: "When iOS snapshots TaskWraith in the background, transcripts are covered by the privacy shield."
                )
                SettingsInfoRow(
                    icon: "externaldrive",
                    title: "Preferences stay local",
                    detail: "Theme, composer shell, transcript font, and app icon choices are stored on this device."
                )
            }
            SettingsCard(title: "Data boundaries", systemImage: "lock.doc") {
                SettingsInfoRow(
                    icon: "network",
                    title: "E2EE remote transport",
                    detail: "The companion uses the TaskWraith relay protocol to receive projections and send approved actions."
                )
                SettingsInfoRow(
                    icon: "person.crop.circle.badge.questionmark",
                    title: "Provider data flow is run-specific",
                    detail: "Transcript content goes to the provider runtime chosen for that run; the phone only mirrors the Mac state."
                )
            }
        }
    }

    private var guideSection: some View {
        VStack(spacing: 12) {
            SettingsCard(title: "First-launch orientation", systemImage: "questionmark.circle") {
                SettingsInfoRow(
                    icon: "switch.2",
                    title: "Provider readiness",
                    detail: "Review which providers are available, signed in, optional, or waiting for Mac setup."
                )
                SettingsInfoRow(
                    icon: "chart.bar.xaxis",
                    title: "Usage snapshots",
                    detail: "See quota and activity snapshots broadcast by the desktop."
                )
                SettingsInfoRow(
                    icon: "ensemble",
                    title: "Ensemble basics",
                    detail: "Learn turn-bound and continuous multi-provider workflows from the remote view."
                )
                if let onOpenFirstLaunchGuide {
                    Button {
                        onOpenFirstLaunchGuide()
                    } label: {
                        Label("Open first-launch guide", systemImage: "arrow.up.right.circle")
                            .font(.body.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(TWTheme.chroma1, in: Capsule())
                            .foregroundStyle(Color.black.opacity(0.86))
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                }
            }
        }
    }

    private var providerSnapshots: [SettingsProviderSnapshot] {
        SettingsProviderSnapshot.build(
            providerCards: model.firstLaunchState?.providerCards ?? [],
            modelUsageProviders: model.modelUsage?.providers ?? [],
            providerModels: model.providerModels)
    }

    private var connectionStatusLabel: String {
        switch model.phase {
        case .idle: return "Idle"
        case .connecting: return "Connecting"
        case .awaitingMacConfirm: return "Confirm on Mac"
        case .connected: return "Connected"
        case .error: return "Offline"
        }
    }

    private func snapshotTimeText(_ value: String?) -> String? {
        guard let date = twParseISODate(value) else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    private func readinessColor(_ statusKind: String) -> Color {
        switch statusKind {
        case "ready", "localReady": return TWTheme.statusSuccess
        case "needsSignIn", "cliMissing", "stale": return TWTheme.statusAttention
        case "outOfUsage": return TWTheme.statusFailed
        default: return TWTheme.textSecondary
        }
    }

    private func providerReadinessRow(_ card: SettingsProviderSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                ProviderLogoIcon(provider: card.id, size: 18)
                Text(card.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 0)
                if card.optional {
                    Text("Optional")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(TWTheme.surface3, in: Capsule())
                }
            }
            HStack(spacing: 6) {
                Circle()
                    .fill(readinessColor(card.statusKind))
                    .frame(width: 8, height: 8)
                Text(card.statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(readinessColor(card.statusKind))
            }
            Text(card.detail)
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if !card.setupHint.isEmpty {
                Text(card.setupHint)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !card.usageWindows.isEmpty {
                SettingsProviderUsageMiniRow(provider: card.label, providerId: card.id, windows: card.usageWindows)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(TWTheme.providerAccent(card.id).opacity(0.25), lineWidth: 1)
        )
    }

    private func attentionSummaryRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(TWTheme.statusAttention)
                .frame(width: 22)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(2)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(3)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(TWTheme.border, lineWidth: 1)
        )
    }

    private func workspaceSummaryRow(_ workspace: WorkspaceSummary) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "folder")
                .foregroundStyle(TWTheme.chroma1)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(workspace.displayName)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text(workspace.path)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if let running = workspace.runningChatCount, running > 0 {
                Text("\(running) running")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.statusSuccess)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(TWTheme.statusSuccess.opacity(0.12), in: Capsule())
            }
        }
        .padding(10)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(TWTheme.border, lineWidth: 1)
        )
    }

    private func pairedHostRow(_ host: PairedHostRecord) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: host.hostPlatform == "mac" ? "macbook" : "desktopcomputer")
                .foregroundStyle(TWTheme.chroma1)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.macDisplayName)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text(host.relayUrls?.first ?? host.relayUrl)
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if host.id == model.selectedHostId {
                Text("Active")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.statusSuccess)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(TWTheme.statusSuccess.opacity(0.12), in: Capsule())
            }
        }
        .padding(10)
        .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(TWTheme.border, lineWidth: 1)
        )
        .contextMenu {
            if host.id != model.selectedHostId {
                Button("Switch to this host") {
                    model.switchHost(to: host.macIdentityPubKey)
                }
            }
            Button("Forget host", role: .destructive) {
                model.forgetHost(macIdentityPubKey: host.macIdentityPubKey)
            }
        }
    }

    private var appVersionLabel: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
    }

    private var composerShellLabel: String {
        switch themes.composerShellPreference {
        case .followMac: return "Follow Mac"
        case .override(let style): return style.label
        }
    }

    private var composerPreviewCard: some View {
        let shell = twResolvedComposerShell(model: model, presentation: .welcome)
        return VStack(alignment: .leading, spacing: 10) {
            // Transcript-font sample — previews the chosen transcript font,
            // independent of the composer shell. Keep this line.
            Text("Assistant transcript text uses \(themes.transcriptFontPreference.label).")
                .font(TWFont.font(for: themes.transcriptFontPreference, size: 15, relativeTo: .body))
                .foregroundStyle(TWTheme.textPrimary)
            // Composer input line — must use the shell's composer font + placeholder ink.
            Text("Message the assistant…")
                .font(twComposerFont(shell.fontDesign, .callout))
                .foregroundStyle(shell.palette.placeholder)
            HStack(spacing: 8) {
                Text(composerShellLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.chroma1)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(TWTheme.chroma1.opacity(0.14), in: twControlShape(shell.geometry.controlShape))
                Text("Tools")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(themes.toolTheme.color)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(themes.toolTheme.color.opacity(0.14), in: twControlShape(shell.geometry.controlShape))
                Spacer(minLength: 0)
                ComposerPreviewSendLabel(shell: shell)
}
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Reuse the real composer-shell chrome (the same render the First Launch
        // preview uses). Draw it unconditionally — a static preview has no real
        // input drawing the surface, so input-owns shells (claude / cursor / …)
        // must be shelled here too or they render blank.
        .composerShell(shell)
    }

    #if os(iOS)
        private func appIconButton(_ variant: TWAppIconVariant) -> some View {
            let selected = appIcon == variant
            return Button {
                appIcon = variant
                TWAppIconController.select(variant)
            } label: {
                VStack(spacing: 7) {
                    Image(variant.thumbnailAssetName)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 58, height: 58)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(alignment: .topTrailing) {
                            if selected {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(TWTheme.chroma1)
                                    .background(Circle().fill(TWTheme.appBg))
                                    .offset(x: 5, y: -5)
                            }
                        }
                    Text(variant.label)
                        .font(.footnote.weight(selected ? .semibold : .regular))
                        .foregroundStyle(selected ? TWTheme.textPrimary : TWTheme.textSecondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(selected ? TWTheme.chroma1.opacity(0.13) : TWTheme.surface2, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .strokeBorder(selected ? TWTheme.chroma1.opacity(0.45) : TWTheme.border, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(variant.label) app icon")
            .accessibilityValue(selected ? "Selected" : "Not selected")
        }
    #endif

    private func themeButton(_ theme: TWSystemTheme) -> some View {
        let selected = themes.systemTheme == theme
        return SettingsSelectionButton(
            title: theme.label,
            selected: selected,
            swatch: theme.surface3
        ) {
            themes.systemTheme = theme
        }
    }

    private func accentButton(_ accent: TWAccentTheme) -> some View {
        SettingsSelectionButton(
            title: accent.label,
            selected: themes.accentTheme == accent,
            swatch: accent.color
        ) {
            themes.accentTheme = accent
        }
    }

    private func toolButton(_ tool: TWToolTheme) -> some View {
        SettingsSelectionButton(
            title: tool.label,
            selected: themes.toolTheme == tool,
            swatch: tool.color
        ) {
            themes.toolTheme = tool
        }
    }

    private var appScaleControl: some View {
        HStack(spacing: 8) {
            Button {
                themes.appScalePreference = themes.appScalePreference.steppedDown()
            } label: {
                Text("-")
                    .frame(maxWidth: .infinity)
            }
            .disabled(themes.appScalePreference == TWAppScale.minimum)
            .accessibilityLabel("Decrease display size")

            Button {
                themes.appScalePreference = .standard
            } label: {
                Text("Default")
                    .frame(maxWidth: .infinity)
            }
            .disabled(themes.appScalePreference == .standard)
            .accessibilityLabel("Reset display size")

            Button {
                themes.appScalePreference = themes.appScalePreference.steppedUp()
            } label: {
                Text("+")
                    .frame(maxWidth: .infinity)
            }
            .disabled(themes.appScalePreference == TWAppScale.maximum)
            .accessibilityLabel("Increase display size")
        }
        .buttonStyle(AppScaleButtonStyle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Display size")
        .accessibilityValue(themes.appScalePreference.label)
    }
}

private struct AppScaleButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.appScale) private var appScale

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(isEnabled ? TWTheme.textPrimary : TWTheme.textMuted)
            .padding(.horizontal, appScale.scaled(10))
            .padding(.vertical, appScale.scaled(9))
            .frame(minHeight: max(44, appScale.scaled(44)))
            .background(
                isEnabled ? TWTheme.surface2 : TWTheme.surface2.opacity(0.45),
                in: RoundedRectangle(cornerRadius: appScale.scaled(11), style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: appScale.scaled(11), style: .continuous)
                    .strokeBorder(configuration.isPressed ? TWTheme.chroma1.opacity(0.5) : TWTheme.border, lineWidth: 1)
            )
    }
}

private struct SettingsIconPlate: View {
    let systemImage: String
    let selected: Bool
    @Environment(\.appScale) private var appScale

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: appScale.scaled(16), weight: .semibold))
            .foregroundStyle(selected ? TWTheme.chroma1 : TWTheme.textSecondary)
            .frame(width: appScale.scaled(34), height: appScale.scaled(34))
            .background(
                selected ? TWTheme.chroma1.opacity(0.15) : TWTheme.surface2,
                in: RoundedRectangle(cornerRadius: appScale.scaled(10), style: .continuous)
            )
    }
}

private struct SettingsMetricPill: View {
    let title: String
    let value: String
    let systemImage: String
    @Environment(\.appScale) private var appScale

    var body: some View {
        HStack(spacing: appScale.scaled(7)) {
            Image(systemName: systemImage)
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(.caption2.weight(.bold))
                    .textCase(.uppercase)
                    .foregroundStyle(TWTheme.textTertiary)
                Text(value)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, appScale.scaled(9))
        .padding(.vertical, appScale.scaled(7))
        .background(TWTheme.surface1.opacity(0.86), in: RoundedRectangle(cornerRadius: appScale.scaled(10), style: .continuous))
    }
}

private struct SettingsCard<Content: View>: View {
    let title: String
    let systemImage: String
    private let content: Content
    @Environment(\.appScale) private var appScale
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted

    init(title: String, systemImage: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.systemImage = systemImage
        self.content = content()
    }

    private var cardFill: Color {
        twGlassSheetChromeFill(glassSheetHosted: glassSheetHosted) ?? TWTheme.surface1
    }

    var body: some View {
        VStack(alignment: .leading, spacing: appScale.scaled(12)) {
            Label(title, systemImage: systemImage)
                .font(.headline.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
            content
        }
        .padding(appScale.scaled(14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(cardFill, in: RoundedRectangle(cornerRadius: appScale.scaled(16), style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: appScale.scaled(16), style: .continuous)
                .strokeBorder(TWTheme.border, lineWidth: 1)
        )
    }
}

private struct SettingsInfoRow: View {
    let icon: String
    let title: String
    let detail: String
    @Environment(\.appScale) private var appScale

    var body: some View {
        HStack(alignment: .top, spacing: appScale.scaled(10)) {
            Group {
                if icon == "ensemble" {
                    ProviderGlyphIcon(
                        provider: "ensemble", isEnsemble: true, size: appScale.scaled(18))
                } else {
                    Image(systemName: icon)
                        .foregroundStyle(TWTheme.chroma1)
                }
            }
            .frame(width: appScale.scaled(22))
            .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(TWTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct SettingsValueRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.body)
                .foregroundStyle(TWTheme.textSecondary)
            Spacer(minLength: 12)
            Text(value)
                .font(.body.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 2)
    }
}

private struct SettingsSelectionButton: View {
    let title: String
    let selected: Bool
    let swatch: Color
    let action: () -> Void
    @Environment(\.appScale) private var appScale

    var body: some View {
        Button(action: action) {
            HStack(spacing: appScale.scaled(8)) {
                Circle()
                    .fill(swatch)
                    .frame(width: appScale.scaled(13), height: appScale.scaled(13))
                    .overlay(Circle().strokeBorder(TWTheme.border, lineWidth: 1))
                Text(title)
                    .font(.footnote.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? TWTheme.textPrimary : TWTheme.textSecondary)
                Spacer(minLength: 4)
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(TWTheme.chroma1)
                }
            }
            .padding(.horizontal, appScale.scaled(10))
            .padding(.vertical, appScale.scaled(9))
            .background(selected ? TWTheme.chroma1.opacity(0.13) : TWTheme.surface2, in: RoundedRectangle(cornerRadius: appScale.scaled(10), style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: appScale.scaled(10), style: .continuous)
                    .strokeBorder(selected ? TWTheme.chroma1.opacity(0.42) : TWTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(selected ? "Selected" : "Not selected")
    }
}

struct SettingsProviderSnapshot: Identifiable, Equatable {
    let id: String
    let label: String
    let optional: Bool
    let statusKind: String
    let statusText: String
    let detail: String
    let setupHint: String
    let usageWindows: [SettingsUsageWindow]

    init(
        id: String,
        label: String,
        optional: Bool,
        statusKind: String,
        statusText: String,
        detail: String,
        setupHint: String,
        usageWindows: [SettingsUsageWindow]
    ) {
        self.id = id
        self.label = label
        self.optional = optional
        self.statusKind = statusKind
        self.statusText = statusText
        self.detail = detail
        self.setupHint = setupHint
        self.usageWindows = usageWindows
    }

    static func build(
        providerCards: [FirstLaunchProviderCard],
        modelUsageProviders: [ModelUsageMessage.ProviderUsage],
        providerModels: [String: [ModelOption]]
    ) -> [SettingsProviderSnapshot] {
        let usageByProvider = Dictionary(
            modelUsageProviders.map { ($0.provider, $0) },
            uniquingKeysWith: { first, _ in first })

        let activeCards = providerCards.filter { !TWTheme.isRetiredProvider($0.id) }
        if !activeCards.isEmpty {
            return activeCards.map { card in
                let cardWindows = card.usageWindows.map(SettingsUsageWindow.init(window:))
                return SettingsProviderSnapshot(
                    id: card.id,
                    label: card.label.isEmpty ? TWTheme.providerLabel(card.id) : card.label,
                    optional: card.optional,
                    statusKind: card.statusKind,
                    statusText: card.statusText,
                    detail: card.detail,
                    setupHint: card.setupHint,
                    usageWindows: cardWindows.isEmpty
                        ? usageByProvider[card.id]?.windows.map(SettingsUsageWindow.init(window:)) ?? []
                        : cardWindows
                )
            }
        }

        return []
    }

}

struct SettingsUsageWindow: Identifiable, Equatable {
    let id: String
    let label: String
    let usedPercent: Int?
    let resetAt: String?

    init(window: ModelUsageMessage.Window) {
        id = window.id
        label = window.label
        usedPercent = window.usedPercent
        resetAt = window.resetAt
    }

    init(window: FirstLaunchUsageWindow) {
        id = window.id
        label = window.label
        usedPercent = window.usedPercent
        resetAt = window.resetAt
    }
}

private struct SettingsProviderUsageMiniRow: View {
    let provider: String
    let providerId: String
    let windows: [SettingsUsageWindow]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(provider)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 0)
                Text("\(windows.count) window\(windows.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            ForEach(windows.prefix(2)) { window in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(window.label)
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textSecondary)
                        Spacer(minLength: 0)
                        if let percent = window.usedPercent {
                            Text("\(percent)%")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(TWTheme.textSecondary)
                        }
                    }
                    if let reset = resetText(window.resetAt) {
                        Text(reset)
                            .font(.caption2)
                            .foregroundStyle(TWTheme.textTertiary)
                    }
                    GeometryReader { proxy in
                        let percent = CGFloat(window.usedPercent ?? 0) / 100
                        ZStack(alignment: .leading) {
                            Capsule().fill(TWTheme.surface3)
                            Capsule()
                                .fill(TWTheme.providerAccent(providerId))
                                .frame(width: max(4, proxy.size.width * percent))
                        }
                    }
                    .frame(height: 5)
                }
            }
        }
        .padding(9)
        .background(TWTheme.appBg.opacity(0.45), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func resetText(_ resetAt: String?) -> String? {
        guard let resetAt, let date = twParseISODate(resetAt) else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return "resets \(formatter.string(from: date))"
    }
}

/// Pins + Notes inspector tab — view/edit thread notes, view/unpin pinned
/// messages (pin FROM the transcript via the row context menu).
struct NotesPanel: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    @State private var notesDraft: String = ""
    @State private var loadedFromSnapshot = false
    @FocusState private var notesFocused: Bool

    private var card: RemoteTaskCard? {
        model.taskCards.first { $0.id == threadId }
    }
    private var snapshot: RemoteThreadSnapshot? { model.threadSnapshots[threadId] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            BlackboardPanelSection(entries: snapshot?.blackboardEntries ?? [])

            Text("Notes")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textTertiary)
            TextEditor(text: $notesDraft)
                .focused($notesFocused)
                .frame(minHeight: 110)
                .font(.footnote)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border)
                )
                .accessibilityLabel("Thread notes")
                .accessibilityHint("Edits save with Save notes button.")
            if notesFocused || notesDraft != (snapshot?.notes ?? "") {
                Button {
                    card.map { model.setThreadNotes($0, notes: notesDraft) }
                    notesFocused = false
                } label: {
                    Text("Save notes")
                        .font(.caption.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 7)
                        .background(TWTheme.chroma1.opacity(0.18), in: Capsule())
                        .foregroundStyle(TWTheme.chroma1)
                }
                .buttonStyle(.plain)
            }

            Text("Pinned messages")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textTertiary)
                .padding(.top, 4)
            let pins = snapshot?.pinnedRows ?? []
            if pins.isEmpty {
                Text("No pinned messages — long-press a transcript message to pin it.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
            } else {
                ForEach(pins, id: \.id) { row in
                    if let item = PinnedMessageActionsModel.makeItem(
                        id: row.id,
                        speaker: row.speaker,
                        role: row.role,
                        preview: row.preview,
                        truncated: row.truncated
                    ) {
                        PinnedMessagePinRow(
                            item: item,
                            onCopy: { _, _ in
                                model.copyPinnedTranscriptRow(
                                    threadId: threadId, sourceRow: row)
                            },
                            onJumpToSource: { _ in
                                model.requestPinnedTranscriptJump(
                                    threadId: threadId, sourceRow: row)
                                model.inspectorPresented = false
                            },
                            onUnpin: { messageId in
                                if let card {
                                    model.toggleMessagePin(
                                        card, messageId: messageId, pinned: false)
                                }
                            }
                        )
                    }
                }
            }
        }
        .onAppear {
            if !loadedFromSnapshot {
                notesDraft = snapshot?.notes ?? ""
                loadedFromSnapshot = true
            }
        }
        .onChange(of: snapshot?.notes ?? "") { _, fresh in
            if !notesFocused { notesDraft = fresh }
        }
    }

}

private struct BlackboardPanelSection: View {
    let entries: [RemoteThreadSnapshot.BlackboardEntry]

    private static let categoryOrder = ["decision", "fact", "risk", "do-not-repeat", "note"]
    private static let categoryLabels: [String: String] = [
        "decision": "Decisions",
        "fact": "Facts",
        "risk": "Risks",
        "do-not-repeat": "Do not repeat",
        "note": "Notes",
    ]

    private var visibleEntries: [RemoteThreadSnapshot.BlackboardEntry] {
        entries
            .filter { !$0.key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .filter { !$0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { lhs, rhs in
                let lhsRank = Self.categoryOrder.firstIndex(of: lhs.category) ?? Int.max
                let rhsRank = Self.categoryOrder.firstIndex(of: rhs.category) ?? Int.max
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                return (lhs.createdAt ?? "") > (rhs.createdAt ?? "")
            }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Blackboard")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Spacer(minLength: 8)
                if !visibleEntries.isEmpty {
                    Text("\(visibleEntries.count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TWTheme.chroma1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(TWTheme.chroma1.opacity(0.14), in: Capsule())
                }
            }

            if visibleEntries.isEmpty {
                Text("No blackboard entries.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .padding(.vertical, 2)
            } else {
                ForEach(Self.categoryOrder, id: \.self) { category in
                    let group = visibleEntries.filter { $0.category == category }
                    if !group.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(Self.categoryLabels[category] ?? category)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(TWTheme.textMuted)
                                .textCase(.uppercase)
                            ForEach(group) { entry in
                                BlackboardEntryCard(entry: entry)
                            }
                        }
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1.opacity(0.62), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }
}

private struct BlackboardEntryCard: View {
    let entry: RemoteThreadSnapshot.BlackboardEntry

    private var scopeLabel: String {
        entry.scope.replacingOccurrences(of: "-", with: " ").uppercased()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.key)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(scopeLabel)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(TWTheme.textMuted)
            }
            MarkdownLite(entry.value, baseColor: TWTheme.textPrimary)
                .font(.caption)
                .lineLimit(5)
            if let images = entry.images, !images.isEmpty {
                BlackboardThumbnailGrid(images: images)
            }
            if let participant = entry.participantId, !participant.isEmpty {
                Text(participant)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textMuted)
                    .lineLimit(1)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface2.opacity(0.72), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(TWTheme.border.opacity(0.7)))
    }
}

struct BlackboardThumbnailGrid: View {
    let images: [RemoteThreadSnapshot.BlackboardEntry.BlackboardImage]

    var body: some View {
        #if canImport(UIKit)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(images) { item in
                    if let dataBase64 = item.thumbnail?.dataBase64,
                        let data = Data(base64Encoded: dataBase64),
                        let image = UIImage(data: data)
                    {
                        VStack(alignment: .leading, spacing: 3) {
                            Image(uiImage: image)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(width: 96, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            Text(item.name)
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(TWTheme.textMuted)
                                .lineLimit(1)
                                .frame(width: 96, alignment: .leading)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Attached image \(item.name)")
                    }
                }
            }
        }
        #else
        EmptyView()
        #endif
    }
}

// ── Graceful status banners (lifecycle + action feedback) ──────────────────
// Raw caption-text errors above the composer were hard to read; these are
// severity-tinted bubbles with white text, an icon, and a dismiss control.
// Errors persist until dismissed; informational acks auto-fade.

public enum TWBannerSeverity {
    case error, warning, info, success

    var fill: Color {
        switch self {
        case .error: return Color(hex: 0xC4373C)
        case .warning: return Color(hex: 0xB07816)
        case .info: return Color(hex: 0x2F5FBF)
        case .success: return Color(hex: 0x2E7D4F)
        }
    }

    var icon: String {
        switch self {
        case .error: return "exclamationmark.octagon.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        }
    }
}

/// Heuristic severity from a bridge ack / transport message.
public func twBannerSeverity(for message: String) -> TWBannerSeverity {
    let lower = message.lowercased()
    if lower.contains("denied") || lower.contains("failed") || lower.contains("error")
        || lower.contains("not found") || lower.contains("did not dispatch")
    {
        return .error
    }
    // Foundation's Codable/JSON copy ("The data couldn't be read because it
    // isn't in the correct format.") names no actor and trips none of the
    // keywords above, so an unreadable payload rendered as a calm blue notice
    // that auto-faded. Matched on apostrophe-free fragments on purpose:
    // Foundation localizes with a TYPOGRAPHIC apostrophe (U+2019), so
    // "couldn't" written with an ASCII quote would never match. Covers the
    // `PairedHostSessionError.invalidResponse` wrapper too.
    if lower.contains("be read because") || lower.contains("correct format")
        || lower.contains("invalid response") || lower.contains("unreadable")
    {
        return .error
    }
    if lower.contains("timeout") || lower.contains("timed out") || lower.contains("lost")
        || lower.contains("reconnect") || lower.contains("retry")
    {
        return .warning
    }
    if lower.contains("saved") || lower.contains("updated") || lower.contains("pinned")
        || lower.contains("started") || lower.contains("created") || lower.contains("sent")
    {
        return .success
    }
    return .info
}

/// Whether a banner's auto-dismiss timer should dismiss when it wakes.
///
/// Extracted so the wake decision can be pinned without driving a SwiftUI
/// `.task`. `waitCancelled` is true when the wait was interrupted rather than
/// completed.
public func twBannerShouldAutoDismiss(severity: TWBannerSeverity, waitCancelled: Bool) -> Bool {
    // Cancellation means SUPERSEDED — SwiftUI restarts `.task(id:)` when the
    // message changes, i.e. when a DIFFERENT banner replaced this one. The old
    // `try? await Task.sleep` swallowed that and dismissed anyway, erasing the
    // banner that had just arrived: two banners in quick succession lost the
    // second. It never means "time is up".
    guard !waitCancelled else { return false }
    return severity == .success || severity == .info
}

/// Posts a VoiceOver announcement for transient status banners and feedback.
public func twAnnounceForAccessibility(_ message: String) {
    guard !message.isEmpty else { return }
    AccessibilityNotification.Announcement(message).post()
}

/// Friendlier phrasing for the handful of raw messages users actually hit.
public func twFriendlyMessage(_ raw: String) -> String {
    let lower = raw.lowercased()
    if lower.contains("timeout") || lower.contains("timed out") {
        return "Your Mac didn't respond in time — it may be busy or asleep."
    }
    if lower.contains("not allowlisted") || lower.contains("denied") {
        return "This workspace doesn't allow that action from paired devices."
    }
    if lower.contains("did not dispatch") {
        return "The run couldn't start — check the provider's setup on your computer."
    }
    return raw
}

public struct StatusBanner: View {
    let message: String
    let onDismiss: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(message: String, onDismiss: @escaping () -> Void) {
        self.message = message
        self.onDismiss = onDismiss
    }

    private var severity: TWBannerSeverity { twBannerSeverity(for: message) }

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: severity.icon)
                .font(.caption)
                .padding(.top, 1)
            Text(twFriendlyMessage(message))
                .font(.footnote.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .opacity(0.7)
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .modifier(TWBannerGlassBackground(severity: severity, shape: .rounded(radius: 12)))
        .shadow(color: severity.fill.opacity(0.32), radius: 10, y: 3)
        .padding(.horizontal, 10)
        .transition(ComposerMotion.cardPresence(reduceMotion: reduceMotion))
        .onAppear { twAnnounceForAccessibility(twFriendlyMessage(message)) }
        .onChange(of: message) { _, newMessage in
            twAnnounceForAccessibility(twFriendlyMessage(newMessage))
        }
        .task(id: message) {
            // Non-error feedback fades on its own; errors stay until read.
            let sev = severity
            guard sev == .success || sev == .info else { return }
            var waitCancelled = false
            do { try await Task.sleep(nanoseconds: 3_500_000_000) } catch { waitCancelled = true }
            if twBannerShouldAutoDismiss(severity: sev, waitCancelled: waitCancelled) {
                onDismiss()
            }
        }
    }
}

private struct TWBannerGlassBackground: ViewModifier {
    enum ShapeKind {
        case rounded(radius: CGFloat)
        case capsule
    }

    let severity: TWBannerSeverity
    let shape: ShapeKind

    @ViewBuilder
    func body(content: Content) -> some View {
        switch shape {
        case .rounded(let radius):
            let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
            bannerBackground(content: content, shape: shape)
        case .capsule:
            bannerBackground(content: content, shape: Capsule())
        }
    }

    @ViewBuilder
    private func bannerBackground<S: InsettableShape>(content: Content, shape: S) -> some View {
        let hue = severity.fill
        // Translucent severity wash — kept light so the material/blur shows
        // through and the banner reads as glass rather than a hard color block.
        let tint = LinearGradient(
            colors: [
                hue.opacity(0.46),
                hue.opacity(0.30),
                hue.opacity(0.18)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        // Top-lit rim highlight: a crisp light edge along the top fading down
        // the sides — the house "glass rim" look (mirrors the composer dock).
        let rim = LinearGradient(
            colors: [
                Color.white.opacity(0.55),
                hue.opacity(0.55),
                hue.opacity(0.26),
                Color.white.opacity(0.10)
            ],
            startPoint: .top,
            endPoint: .bottom
        )

        if #available(iOS 26.0, macOS 26.0, *) {
            content
                .background(shape.fill(hue.opacity(0.14)))
                .glassEffect(.regular, in: shape)
                .background(shape.fill(tint))
                .overlay(shape.strokeBorder(rim, lineWidth: 1))
        } else {
            content
                .background {
                    shape
                        .fill(.ultraThinMaterial)
                        .overlay(shape.fill(tint))
                }
                .overlay(shape.strokeBorder(rim, lineWidth: 1))
        }
    }
}

/// Slim connection-state strip shown over the shell while a trusted
/// reconnect is in flight — the user stays exactly where they were.
public struct ConnectionBanner: View {
    public enum State: Equatable {
        case reconnecting(detail: String?)
        case offline(detail: String?)
    }

    let state: State
    let onRetry: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(state: State, onRetry: @escaping () -> Void) {
        self.state = state
        self.onRetry = onRetry
    }

    public var body: some View {
        HStack(spacing: 8) {
            switch state {
            case .reconnecting:
                ProgressView()
                    .controlSize(.small)
                    .tint(.white)
                Text("Reconnecting…")
                    .font(.footnote.weight(.semibold))
            case .offline(let detail):
                Image(systemName: "wifi.exclamationmark")
                    .font(.caption)
                Text(detail ?? "Connection lost.")
                    .font(.footnote.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 4)
                Button("Retry", action: onRetry)
                    .font(.footnote.weight(.bold))
                    .buttonStyle(.plain)
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(TWBannerGlassBackground(severity: bannerSeverity, shape: .capsule))
        .padding(.horizontal, 12)
        .shadow(color: bannerSeverity.fill.opacity(0.34), radius: 10, y: 3)
        .transition(ComposerMotion.cardPresence(reduceMotion: reduceMotion))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(connectionAccessibilityLabel)
        .accessibilityValue(connectionAccessibilityValue)
        .accessibilityAddTraits(connectionUpdatesFrequently ? .updatesFrequently : [])
        .onAppear { announceConnectionPhase() }
        .onChange(of: state) { _, _ in announceConnectionPhase() }
    }

    private var connectionAccessibilityLabel: String {
        switch state {
        case .reconnecting: return "Reconnecting"
        case .offline: return "Connection lost"
        }
    }

    private var connectionAccessibilityValue: String {
        switch state {
        case .reconnecting(let detail):
            return detail ?? "Reconnecting to host"
        case .offline(let detail):
            return detail ?? "Connection lost"
        }
    }

    private var connectionUpdatesFrequently: Bool {
        if case .reconnecting = state { return true }
        return false
    }

    private func announceConnectionPhase() {
        switch state {
        case .reconnecting(let detail):
            AccessibilityNotification.Announcement(detail ?? "Reconnecting").post()
        case .offline(let detail):
            AccessibilityNotification.Announcement(detail ?? "Connection lost").post()
        }
    }

    private var bannerSeverity: TWBannerSeverity {
        if case .reconnecting = state {
            return .warning
        }
        return .error
    }
}

/// Per-workspace attached changes row (multi-grant runs): workspace name
/// tail + its own diff stats. First row keeps the rounded top corners.
public struct WorkspaceChangesAttachedRow: View {
    let breakdown: MobileDiffSummary.WorkspaceBreakdown?
    let workspaceName: String?
    let gitSnapshot: GitWorkspaceSnapshot?
    let canWrite: Bool
    let onRemove: (() -> Void)?
    let action: () -> Void

    public init(
        breakdown: MobileDiffSummary.WorkspaceBreakdown?, workspaceName: String? = nil,
        gitSnapshot: GitWorkspaceSnapshot? = nil, canWrite: Bool = false,
        onRemove: (() -> Void)? = nil, action: @escaping () -> Void
    ) {
        self.breakdown = breakdown
        self.workspaceName = workspaceName
        self.gitSnapshot = gitSnapshot
        self.canWrite = canWrite
        self.onRemove = onRemove
        self.action = action
    }

    private var nameTail: String {
        if let workspaceName, !workspaceName.isEmpty { return workspaceName }
        let path = breakdown?.workspacePath ?? ""
        return path.split(separator: "/").last.map(String.init) ?? path
    }

    public var body: some View {
        ComposerGitAttachedRowContent(
            workspaceName: nameTail,
            fallbackName: nil,
            filesChanged: filesChanged,
            additions: additions,
            deletions: deletions,
            gitSnapshot: gitSnapshot,
            actionLabel: actionLabel,
            canWrite: onRemove == nil ? nil : canWrite,
            onRemove: onRemove,
            action: action
        )
    }

    private var filesChanged: Int {
        gitSnapshot?.counts?.changed ?? breakdown?.filesChanged ?? 0
    }

    private var additions: Int {
        gitSnapshot?.lineStats?.additions ?? breakdown?.additions ?? 0
    }

    private var deletions: Int {
        gitSnapshot?.lineStats?.deletions ?? breakdown?.deletions ?? 0
    }

    private var actionLabel: String {
        if filesChanged > 0 { return "Review changes" }
        if (gitSnapshot?.ahead ?? 0) > 0 { return "Push" }
        return "Create PR"
    }
}

private struct ComposerGitAttachedRowContent: View {
    let workspaceName: String?
    let fallbackName: String?
    let filesChanged: Int
    let additions: Int
    let deletions: Int
    let gitSnapshot: GitWorkspaceSnapshot?
    let actionLabel: String
    var canWrite: Bool? = nil
    var onRemove: (() -> Void)? = nil
    let action: () -> Void

    private let minimumActionRowWidth: CGFloat = 520

    private var displayName: String {
        let name = workspaceName ?? fallbackName ?? "Workspace"
        return name.isEmpty ? "Workspace" : name
    }

    private var branchName: String? {
        if gitSnapshot?.detached == true { return "detached HEAD" }
        return gitSnapshot?.branch
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            gitRow(showsAction: true)
                .frame(minWidth: minimumActionRowWidth, maxWidth: .infinity)

            gitRow(showsAction: false)
        }
    }

    private func gitRow(showsAction: Bool) -> some View {
        HStack(spacing: 7) {
            Button(action: action) {
                gitRowContent(showsAction: showsAction)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .accessibilityLabel(accessibilitySummary)
            .accessibilityHint("Open changed files")
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                        .frame(width: 18, height: 18)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove workspace")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func gitRowContent(showsAction: Bool) -> some View {
        HStack(spacing: 7) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                Text(displayName)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let branchName, !branchName.isEmpty {
                    Text("·")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textMuted)
                    Text(branchName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.providerAccent("gemini"))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(minWidth: 0, alignment: .leading)
            syncLabel
            Spacer(minLength: 8)
            Text("\(filesChanged) file\(filesChanged == 1 ? "" : "s") changed")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textPrimary)
                .fixedSize()
            if additions > 0 {
                Text("+\(additions)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(TWTheme.statusSuccess)
                    .fixedSize()
            }
            if deletions > 0 {
                Text("−\(deletions)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(TWTheme.statusFailed)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            if showsAction {
                actionBadge
            }
            if let canWrite {
                Image(systemName: canWrite ? "pencil" : "lock")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(canWrite ? TWTheme.chroma1 : TWTheme.textTertiary)
                    .frame(width: 18, height: 18)
                    .accessibilityLabel(canWrite ? "Write access" : "Read-only access")
            }
        }
    }

    private var actionBadge: some View {
        Text(actionLabel)
            .font(.caption.weight(.medium))
            .foregroundStyle(TWTheme.textSecondary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(TWTheme.surface3, in: Capsule())
            .layoutPriority(2)
    }

    private var accessibilitySummary: String {
        var parts = [displayName]
        if let branchName, !branchName.isEmpty {
            parts.append(branchName)
        }
        parts.append("\(filesChanged) file\(filesChanged == 1 ? "" : "s") changed")
        if additions > 0 {
            parts.append("\(additions) added")
        }
        if deletions > 0 {
            parts.append("\(deletions) removed")
        }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private var syncLabel: some View {
        if let gitSnapshot, gitSnapshot.detached != true, gitSnapshot.branch != nil {
            if gitSnapshot.upstream == nil {
                Text("no upstream")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.statusAttention)
                    .fixedSize()
            } else {
                let ahead = gitSnapshot.ahead ?? 0
                let behind = gitSnapshot.behind ?? 0
                if ahead > 0 || behind > 0 {
                    HStack(spacing: 4) {
                        if ahead > 0 { Text("↑\(ahead)") }
                        if behind > 0 { Text("↓\(behind)") }
                    }
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(TWTheme.statusAttention)
                    .fixedSize()
                }
            }
        }
    }
}

/// Steered/queued prompts waiting for the next injection point — the
/// desktop shows this on the round HUD.
struct QueuedPromptsChip: View {
    let count: Int

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "tray.full")
                .font(.system(size: 9))
            Text("\(count) queued")
                .font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(TWTheme.statusAttention.opacity(0.14), in: Capsule())
        .overlay(Capsule().strokeBorder(TWTheme.statusAttention.opacity(0.4)))
        .foregroundStyle(TWTheme.statusAttention)
    }
}

/// Stacked queued-prompt rows (desktop parity): ↪ icon, 2-line text, Steer,
/// trash, overflow — rendered as a shell deck section under the changes
/// row(s). One shared Mac-side queue: items show here whichever device
/// queued them.
public struct QueuedPromptsStack: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    let prompts: [RemoteEnsembleState.QueuedPrompt]
    let isShellTop: Bool
    let onOwnCard: Bool
    let onEdit: ((String) -> Void)?

    public init(
        model: RemoteSessionModel, card: RemoteTaskCard,
        prompts: [RemoteEnsembleState.QueuedPrompt], isShellTop: Bool,
        onOwnCard: Bool = false, onEdit: ((String) -> Void)? = nil
    ) {
        self.model = model
        self.card = card
        self.prompts = prompts
        self.isShellTop = isShellTop
        self.onOwnCard = onOwnCard
        self.onEdit = onEdit
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(prompts) { prompt in
                row(prompt)
                if prompt.index != prompts.last?.index {
                    Rectangle().fill(TWTheme.border).frame(height: 0.5)
                        .padding(.leading, 34)
                }
            }
        }
        .background(
            onOwnCard ? AnyShapeStyle(Color.clear) : composerAttachedRowFill(),
            in: UnevenRoundedRectangle(
                topLeadingRadius: isShellTop ? 16 : 0, bottomLeadingRadius: 0,
                bottomTrailingRadius: 0, topTrailingRadius: isShellTop ? 16 : 0,
                style: .continuous
            )
        )
    }

    private func row(_ prompt: RemoteEnsembleState.QueuedPrompt) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "text.line.first.and.arrowtriangle.forward")
                .font(.caption2)
                .foregroundStyle(TWTheme.textTertiary)
            Text(prompt.text)
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                model.ensembleQueueItem(
                    card, index: prompt.index, text: prompt.text, op: "steerNow")
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.uturn.right")
                        .font(.system(size: 9, weight: .semibold))
                    Text("Steer")
                        .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(TWTheme.textSecondary)
            }
            .buttonStyle(.plain)
            if let onEdit {
                Button {
                    onEdit(prompt.text)
                    model.ensembleQueueItem(
                        card, index: prompt.index, text: prompt.text, op: "remove")
                } label: {
                    Image(systemName: "pencil")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                }
                .buttonStyle(.plain)
            }
            Button {
                model.ensembleQueueItem(
                    card, index: prompt.index, text: prompt.text, op: "remove")
            } label: {
                Image(systemName: "trash")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            .buttonStyle(.plain)
            Menu {
                Button {
                    model.ensembleQueueItem(
                        card, index: prompt.index, text: prompt.text, op: "steerNow")
                } label: {
                    Label("Steer now", systemImage: "arrow.uturn.right")
                }
                Button(role: .destructive) {
                    model.ensembleQueueItem(
                        card, index: prompt.index, text: prompt.text, op: "remove")
                } label: {
                    Label("Remove from queue", systemImage: "trash")
                }
                if let onEdit {
                    Button {
                        onEdit(prompt.text)
                        model.ensembleQueueItem(
                            card, index: prompt.index, text: prompt.text, op: "remove")
                    } label: {
                        Label("Edit queued prompt", systemImage: "pencil")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// Solo-chat queued prompts waiting for the target chat to become idle.
/// Backed by Mac-side RunQueueJob records so every paired device sees the
/// same stack.
public struct QueuedComposerPromptsStack: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    let prompts: [RemoteTaskCard.QueuedComposerPrompt]
    let isShellTop: Bool
    let onOwnCard: Bool
    let onEdit: ((String) -> Void)?

    public init(
        model: RemoteSessionModel, card: RemoteTaskCard,
        prompts: [RemoteTaskCard.QueuedComposerPrompt], isShellTop: Bool,
        onOwnCard: Bool = false, onEdit: ((String) -> Void)? = nil
    ) {
        self.model = model
        self.card = card
        self.prompts = prompts
        self.isShellTop = isShellTop
        self.onOwnCard = onOwnCard
        self.onEdit = onEdit
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(prompts) { prompt in
                row(prompt)
                if prompt.id != prompts.last?.id {
                    Rectangle().fill(TWTheme.border).frame(height: 0.5)
                        .padding(.leading, 34)
                }
            }
        }
        .background(
            onOwnCard ? AnyShapeStyle(Color.clear) : composerAttachedRowFill(),
            in: UnevenRoundedRectangle(
                topLeadingRadius: isShellTop ? 16 : 0, bottomLeadingRadius: 0,
                bottomTrailingRadius: 0, topTrailingRadius: isShellTop ? 16 : 0,
                style: .continuous
            )
        )
    }

    private func row(_ prompt: RemoteTaskCard.QueuedComposerPrompt) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: prompt.scheduledRunAt == nil ? "tray.and.arrow.down" : "clock")
                .font(.caption2)
                .foregroundStyle(
                    prompt.scheduledRunAt == nil
                        ? TWTheme.providerAccent(prompt.provider) : TWTheme.statusAttention)
            VStack(alignment: .leading, spacing: 2) {
                Text(prompt.text)
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(2)
                if let caption = scheduledCaption(prompt.scheduledRunAt) {
                    Text(caption)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(TWTheme.textTertiary)
                        .lineLimit(1)
                }
            }
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                model.composerQueueItem(card, item: prompt, op: "steerNow")
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.uturn.right")
                        .font(.system(size: 9, weight: .semibold))
                    Text("Steer")
                        .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(TWTheme.textSecondary)
            }
            .buttonStyle(.plain)
            if let onEdit {
                Button {
                    onEdit(prompt.text)
                    model.composerQueueItem(card, item: prompt, op: "remove")
                } label: {
                    Image(systemName: "pencil")
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                }
                .buttonStyle(.plain)
            }
            Button {
                model.composerQueueItem(card, item: prompt, op: "remove")
            } label: {
                Image(systemName: "trash")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func scheduledCaption(_ iso: String?) -> String? {
        guard let date = twParseISODate(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "d MMM, HH:mm"
        return "Scheduled \(formatter.string(from: date))"
    }
}

// MARK: - Floating above-composer pill chrome (Diff + Tools)

/// Shared glass chip chrome for the unfocused Diff + Tools pills that float
/// above the collapsed composer. Applies real Liquid Glass on the content
/// (not a solid fill behind `glassEffect`), with a slightly taller vertical
/// pad so icons/labels breathe without growing wider.
///
/// Material stack, outermost first. Each layer earns its place:
///   • ambient shadow — wide and soft; sells "floating above the composer".
///   • contact shadow — tight and dark; without it the chip reads as a sticker
///     printed on the background rather than an object in front of it. The two
///     together are most of the perceived depth.
///   • Liquid Glass on the CONTENT (iOS 26) / `.ultraThinMaterial` (iOS 17).
///   • top specular rim — the light source, above and slightly forward.
///   • bottom counter-rim — dimmer light bouncing UP off the composer beneath.
///     Real edge-lit glass is never dark on the bottom, and its absence is why
///     a single top-only rim reads flat.
///   • accent wash — optional, data-reactive (see `accentIntensity`).
struct ComposerFloatingPillChrome: ViewModifier {
    /// Data-reactive rim tint. `nil` keeps the chip neutral.
    var accent: Color? = nil
    /// 0…1 weight for `accent`; 0 is neutral even when `accent` is non-nil, so
    /// a caller can pass a colour unconditionally and let the data decide.
    var accentIntensity: Double = 0
    /// 0…1 escalation BEYOND full accent, for data that has run off the end of
    /// the normal scale. Deliberately understated: it widens the halo and lifts
    /// the rim slightly rather than adding a new visual element, so the chip
    /// reads as hotter without turning into an alert.
    var accentOverdrive: Double = 0
    /// Segmented callers carry padding on their own segments so the dividers
    /// can reach the chip's edges.
    var horizontalPadding: CGFloat = 12
    /// Liquid Glass morph identity. Supplied together, sibling chips inside a
    /// `GlassEffectContainer` blend at the edges when near and separate as
    /// they move — the behaviour that distinguishes Liquid Glass from a blur.
    var glassID: String? = nil
    var glassNamespace: Namespace.ID? = nil
    /// When false, the iOS 26+ Liquid Glass effect stays non-interactive so
    /// nested controls (e.g. the segmented Buttons inside ComposerToolsPill)
    /// keep their own hit-testing and haptics. The diff pill uses interactive
    /// glass because it is a single tappable readout; control clusters bring
    /// their own ButtonStyle press feedback and conflict with `.interactive()`.
    var interactive: Bool = true

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var pillShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
    }

    /// Shared inner band for both floating chips. A caption-height readout and
    /// a 16pt icon row are naturally different sizes, which is what made the
    /// diff pill sit visibly shorter than the tools pill; padding to a common
    /// content height is what actually delivers the lockstep this chrome's doc
    /// comment promises. 20 is the tools pill's natural height (16pt glyph plus
    /// 2pt of breathing room each side) — the diff pill's text grows into it.
    /// NOTE: at very large Dynamic Type the diff pill's text can exceed this and
    /// the two will diverge again; equalising there needs a measured height.
    static let contentHeight: CGFloat = 20

    private var weight: Double { max(0, min(1, accentIntensity)) }
    private var overdrive: Double { max(0, min(1, accentOverdrive)) }

    /// Top-lit rim, warming toward the accent as the data heats up. Overdrive
    /// pushes the blend the last of the way so a saturated chip still gains a
    /// little presence.
    private var topRim: Color {
        let base = Color.white.opacity(0.34)
        guard let accent, weight > 0 else { return base }
        return TWTheme.mix(accent.opacity(0.85), weight * (0.7 + 0.2 * overdrive), base)
    }

    /// Upward bounce off the composer below — always dimmer than `topRim`, or
    /// the chip reads as lit from nowhere.
    private var bottomRim: Color {
        let base = Color.white.opacity(0.10)
        guard let accent, weight > 0 else { return base }
        return TWTheme.mix(accent.opacity(0.45), weight * 0.6, base)
    }

    /// Ambient halo. Neutral chips cast plain shade; hot ones bleed a little
    /// accent, which is what makes a far-out branch feel different from a fresh
    /// one before you have read a single digit. Overdrive deepens the bleed.
    private var ambientShadow: Color {
        guard let accent, weight > 0 else { return .black.opacity(0.10) }
        let bleed = 0.22 * weight + 0.16 * overdrive
        return TWTheme.mix(accent.opacity(bleed), 0.55, .black.opacity(0.10))
    }

    /// Halo spread. Grows with overdrive so an extreme chip sits in a wider,
    /// softer pool of its own colour — the "more extreme" read without adding
    /// a ring, a pulse, or anything that would compete with the composer.
    private var ambientRadius: CGFloat { 18 + 8 * overdrive }

    @ViewBuilder
    private func rims(_ view: some View) -> some View {
        view
            .overlay(
                pillShape.strokeBorder(
                    LinearGradient(
                        colors: [topRim, Color.white.opacity(0.04), bottomRim],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
            )
            // Inset hairline: a second ring one point in, at very low alpha,
            // reads as glass THICKNESS rather than a drawn outline.
            .overlay(
                pillShape.inset(by: 1.5)
                    .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5)
            )
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        let chrome = content
            .lineLimit(1)
            // Common inner band FIRST, so both chips are the same height before
            // any padding is added. See `contentHeight`.
            .frame(minHeight: Self.contentHeight)
            .padding(.horizontal, horizontalPadding)
            // Taller than the previous 6pt pad; horizontal stays 12 so chips
            // don't grow wider.
            .padding(.vertical, 9)

        if reduceTransparency || !TWTheme.composerGlassEnabled {
            // Reduce Transparency: opaque surface, no rims, no halo. The accent
            // survives as a plain border so the data signal isn't lost with the
            // material.
            chrome
                .background(TWTheme.surface2, in: pillShape)
                .overlay(
                    pillShape.strokeBorder(
                        weight > 0 && accent != nil
                            ? TWTheme.mix(accent!, weight * 0.8, TWTheme.border)
                            : TWTheme.border,
                        lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.28), radius: 6, y: 2)
        } else if #available(iOS 26.0, macOS 26.0, *) {
            // Apply glassEffect ON the content — Color.clear + opacity in
            // .background collapses into an opaque slab and reads solid.
            // `.interactive()` gives the system's own press deformation, which
            // is tuned better than anything hand-rolled here. Control clusters
            // that contain their own Buttons (ComposerToolsPill) pass
            // interactive=false so the nested segments keep their own hit
            // testing and haptics.
            if interactive {
                let glass = chrome.glassEffect(.regular.interactive(), in: pillShape)
                rims(
                    Group {
                        if let glassID, let glassNamespace {
                            glass.glassEffectID(glassID, in: glassNamespace)
                        } else {
                            glass
                        }
                    }
                )
                .shadow(color: .black.opacity(0.22), radius: 6, y: 2)
                .shadow(color: ambientShadow, radius: ambientRadius, y: 8)
            } else {
                let glass = chrome.glassEffect(.regular, in: pillShape)
                rims(
                    Group {
                        if let glassID, let glassNamespace {
                            glass.glassEffectID(glassID, in: glassNamespace)
                        } else {
                            glass
                        }
                    }
                )
                .shadow(color: .black.opacity(0.22), radius: 6, y: 2)
                .shadow(color: ambientShadow, radius: ambientRadius, y: 8)
            }
        } else {
            rims(
                chrome
                    .background(.ultraThinMaterial, in: pillShape)
                    .overlay(pillShape.fill(Color.black.opacity(0.12)))
            )
            .shadow(color: .black.opacity(0.22), radius: 6, y: 2)
            .shadow(color: ambientShadow, radius: ambientRadius, y: 8)
        }
    }
}

extension View {
    /// Glass chip chrome for floating Diff / Tools pills above the composer.
    func composerFloatingPillChrome(
        accent: Color? = nil,
        accentIntensity: Double = 0,
        accentOverdrive: Double = 0,
        horizontalPadding: CGFloat = 12,
        glassID: String? = nil,
        glassNamespace: Namespace.ID? = nil,
        interactive: Bool = true
    ) -> some View {
        modifier(
            ComposerFloatingPillChrome(
                accent: accent, accentIntensity: accentIntensity,
                accentOverdrive: accentOverdrive,
                horizontalPadding: horizontalPadding,
                glassID: glassID, glassNamespace: glassNamespace,
                interactive: interactive))
    }
}

/// One-shot specular sweep across a floating pill, fired when the numbers
/// underneath it change (a commit lands, files change).
///
/// Deliberately VISUAL ONLY. `MotionHaptics`' law reserves haptics for
/// user-initiated discrete actions; new git state arriving over the wire is
/// passive, so a haptic here would be a violation however good it feels.
struct ComposerPillSpecularSweep: View {
    /// Host bumps this when the underlying data changes.
    let tick: Int
    var cornerRadius: CGFloat = 12

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 1 parks the highlight past the trailing edge (invisible at rest).
    @State private var phase: CGFloat = 1

    var body: some View {
        // This GeometryReader READS width to place the highlight and never
        // writes back to @State. The measurement→@State feedback documented on
        // `ComposerDiffPill.quantizedMeasurement` (one-ULP oscillation that
        // wedged launch at 100% CPU) is not reintroduced here.
        GeometryReader { proxy in
            let w = max(proxy.size.width, 1)
            let band = w * 0.45
            LinearGradient(
                colors: [.clear, Color.white.opacity(0.22), .clear],
                startPoint: .leading, endPoint: .trailing
            )
            .frame(width: band)
            .offset(x: -band + phase * (w + band))
            .blendMode(.plusLighter)
        }
        .allowsHitTesting(false)
        .mask(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .onChange(of: tick) { _, _ in
            guard !reduceMotion else { return }
            phase = 0
            withAnimation(.easeOut(duration: 0.75)) { phase = 1 }
        }
    }
}

/// Add/delete proportion as a hairline rail beneath the counters.
///
/// The digits carry the exact numbers; this carries the SHAPE of the change.
/// `+506 −45` and `+6 −5` are the same glyph count and near-identical as text,
/// but land completely differently here — which is the whole point of a diff
/// pill as opposed to a generic one.
struct DiffRatioRail: View {
    let additions: Int
    let deletions: Int

    private var addFraction: CGFloat {
        let total = additions + deletions
        guard total > 0 else { return 0.5 }
        return CGFloat(additions) / CGFloat(total)
    }

    var body: some View {
        // Hard-stop gradient rather than two measured capsules: the split is
        // expressed in the gradient's own unit space, so this needs no
        // GeometryReader at all — no measurement, nothing that could
        // reintroduce the layout feedback documented on
        // `ComposerDiffPill.quantizedMeasurement`.
        Capsule()
            .fill(
                LinearGradient(
                    stops: [
                        .init(color: TWTheme.diffStatAdd.opacity(0.9), location: 0),
                        .init(color: TWTheme.diffStatAdd.opacity(0.9), location: addFraction),
                        .init(color: TWTheme.diffStatDel.opacity(0.9), location: addFraction),
                        .init(color: TWTheme.diffStatDel.opacity(0.9), location: 1),
                    ],
                    startPoint: .leading, endPoint: .trailing)
            )
            .frame(height: 2)
            .animation(.easeInOut(duration: 0.28), value: addFraction)
            // The digits above are already announced; the rail is the same data.
            .accessibilityHidden(true)
    }
}

/// Compact, generic diff summary shown above the ONE-LINE composer when it's
/// blurred and there are active changes — a stand-in for the (composer-specific)
/// changes row, which only returns on focus. Same look for every shell. Tap
/// opens the diff. (Codex-app-style pill, TaskWraith twist.)
public struct ComposerDiffPill: View {
    let filesChanged: Int
    let additions: Int
    let deletions: Int
    let commitsAhead: Int
    var onTap: (() -> Void)? = nil
    /// Intrinsic-width tappable chip without drag-to-reposition. Used when the
    /// tools pill sits beside this chip in a shared above-composer row.
    var compactInline: Bool = false
    /// Liquid Glass morph namespace shared with the sibling tools pill.
    var glassNamespace: Namespace.ID? = nil

    public init(
        filesChanged: Int, additions: Int, deletions: Int, commitsAhead: Int = 0,
        onTap: (() -> Void)? = nil,
        compactInline: Bool = false,
        glassNamespace: Namespace.ID? = nil
    ) {
        self.filesChanged = filesChanged
        self.additions = additions
        self.deletions = deletions
        self.commitsAhead = max(0, commitsAhead)
        self.onTap = onTap
        self.compactInline = compactInline
        self.glassNamespace = glassNamespace
    }

    /// Where rim heat saturates. Raised from 24 after real branches turned out
    /// to sit far past it — at 24 anything beyond a day's work looked identical.
    private static let accentSaturationCommits = 120.0
    /// Where the escalation past saturation tops out.
    private static let accentOverdriveCommits = 350.0

    /// Rim heat: 0 → 1 across 0…120 commits ahead.
    private var accentIntensity: Double {
        guard commitsAhead > 0 else { return 0 }
        return min(1, Double(commitsAhead) / Self.accentSaturationCommits)
    }

    /// Escalation BEYOND saturation: 0 → 1 across 120…350. Kept to a hue shift
    /// and a wider halo — no new element, no pulse, nothing that competes with
    /// the composer it sits above. The chip should read as hotter at a glance
    /// without ever becoming something you have to dismiss.
    private var accentOverdrive: Double {
        let over = Double(commitsAhead) - Self.accentSaturationCommits
        guard over > 0 else { return 0 }
        return min(1, over / (Self.accentOverdriveCommits - Self.accentSaturationCommits))
    }

    /// Amber at saturation, easing toward the failure red as overdrive climbs.
    /// Capped at a 0.55 blend: this is "you are a long way out", not an error,
    /// and a full statusFailed rim would read as something being broken.
    private var accentColor: Color {
        TWTheme.mix(TWTheme.statusFailed, accentOverdrive * 0.55, TWTheme.statusAttention)
    }

    /// The rail needs both sides to mean anything; a pure-addition diff is
    /// already unambiguous from the digits.
    private var showsRatioRail: Bool { additions > 0 && deletions > 0 }

    /// Change stamp for the specular sweep. Any counter moving re-fires it.
    private var dataSignature: String {
        "\(commitsAhead)/\(filesChanged)/\(additions)/\(deletions)"
    }

    /// 2_100 → "2.1k", 25_000 → "25k", 718 → "718".
    private func compact(_ n: Int) -> String {
        guard n >= 1000 else { return "\(n)" }
        let k = Double(n) / 1000
        return String(format: k >= 10 ? "%.0fk" : "%.1fk", k)
    }

    private var hasFileStats: Bool {
        filesChanged > 0 || additions > 0 || deletions > 0
    }

    /// Softer rounded-rect (not a full capsule) so the chip reads as a glass
    /// panel rather than a tablet — matches ComposerFloatingPillChrome radius.
    private var pillShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
    }

    // Persisted horizontal nudge from centre (points); survives threads + launches.
    // Touch-and-hold picks the pill up to drag it off-centre; an upward flick
    // snaps it back. A plain tap still opens the diff (onTap).
    @AppStorage("tw.diffPill.offsetX") private var persistedOffsetX: Double = 0
    @GestureState private var dragState: DragState = .inactive
    @State private var containerWidth: CGFloat = 0
    @State private var pillWidth: CGFloat = 0
    @State private var commitTick = 0
    @State private var resetTick = 0
    /// Bumped when the git counters change — drives the specular sweep only.
    @State private var dataTick = 0

    /// An upward drag past this — and more vertical than horizontal — recentres
    /// the pill. The threshold keeps an accidental nudge from snapping it back.
    private static let resetThreshold: CGFloat = 48

    private enum DragState: Equatable {
        case inactive
        case pressing
        case dragging(translation: CGSize)

        var isActive: Bool { self != .inactive }
        var isDragging: Bool { if case .dragging = self { return true } else { return false } }
    }

    /// Keep-clear inset from each side of the measured slot. Must exceed the iPad
    /// NavigationSplitView screen-edge-swipe gutter (~20pt for the system
    /// UIScreenEdgePanGestureRecognizer) so the pill's long-press / drag hit-area
    /// never sits in the gutter and swallows the sidebar swipe; with the call
    /// site's `.padding(.horizontal, 10)` the pill's near edge lands 28 + 10 =
    /// 38pt from the column edge. It also guarantees >=28pt of layout slack on the
    /// pushed side so the single-line pill text can't be starved into a wrap.
    private static let edgeMargin: CGFloat = 28

    /// Quantized gate for the two GeometryReader→@State measurement feedbacks
    /// below. At 440pt and 420pt iPhone widths (17 Pro Max, Air) the measured
    /// slot width oscillates by one ULP per layout pass (420.0 ↔
    /// 420.00000000000006); writing every bit-level change back into @State
    /// re-invalidates layout forever — the first frame never commits and
    /// launch wedges on the splash at 100% CPU (on hardware the watchdog
    /// would kill it). The centring math only needs point accuracy, so
    /// quantize to whole points and swallow sub-point deltas.
    private static func quantizedMeasurement(_ measured: CGFloat, current: CGFloat) -> CGFloat? {
        let points = measured.rounded()
        return abs(points - current) >= 0.5 ? points : nil
    }

    /// Half the slack between the pill and its column — how far the pill may
    /// travel before its edge meets the keep-clear margin. CLAMPED TO CENTRE (0)
    /// until BOTH measurements land: a finite 0 keeps the onEnded commit bounded
    /// even on the first/stale frame (the old .greatestFiniteMagnitude sentinel
    /// turned clampOffset into a no-op, letting an unbounded offset be flung to
    /// the very edge before measurement caught up).
    private var maxOffsetX: CGFloat {
        guard containerWidth > 0, pillWidth > 0 else { return 0 }
        return max(0, (containerWidth - pillWidth) / 2 - Self.edgeMargin)
    }

    private func clampOffset(_ x: Double) -> Double {
        let limit = Double(maxOffsetX)
        return Swift.min(limit, Swift.max(-limit, x))
    }

    /// Intentional upward drag (not an accidental sideways wobble).
    private func isRecenterDrag(_ t: CGSize) -> Bool {
        t.height < -Self.resetThreshold && abs(t.height) > abs(t.width)
    }

    /// Resting horizontal position expressed as a LAYOUT leading inset (centre +
    /// committed nudge, clamped within the column) so the pill's hit-frame sits
    /// where the pill is drawn — a visual-only `.offset` left the tap/long-press
    /// target stranded at centre. Centred until the column + pill are measured
    /// (applying a persisted offset against the unbounded pre-measure clamp could
    /// flash the pill off-screen on a narrower column).
    private var restingLeadingInset: CGFloat {
        guard containerWidth > 0, pillWidth > 0 else { return 0 }
        let centred = (containerWidth - pillWidth) / 2
        // Hard ceiling so the leading inset + pill can NEVER exceed the column,
        // even if containerWidth and pillWidth were measured on different passes
        // and a stale pair makes `centred` momentarily too large (which would
        // overflow the HStack, compress the pill, and latch a multi-line wrap).
        let ceiling = max(0, containerWidth - pillWidth - Self.edgeMargin)
        return min(ceiling, max(0, centred + CGFloat(clampOffset(persistedOffsetX))))
    }

    /// Visual-only offset applied DURING a live drag (the finger is on the pill,
    /// so the hit-frame is irrelevant); zero at rest. An upward flick telegraphs
    /// the recentre by easing back toward the middle and lifting up.
    private var dragVisualOffset: CGSize {
        guard containerWidth > 0, pillWidth > 0,
            case .dragging(let t) = dragState
        else { return .zero }
        if isRecenterDrag(t) {
            return CGSize(
                width: -CGFloat(clampOffset(persistedOffsetX)) * 0.75,
                height: max(t.height, -56))
        }
        let committed = clampOffset(persistedOffsetX)
        let dragged = clampOffset(persistedOffsetX + Double(t.width))
        return CGSize(width: CGFloat(dragged - committed), height: t.height * 0.1)
    }

    private var repositionGesture: some Gesture {
        LongPressGesture(minimumDuration: 0.35)
            .sequenced(before: DragGesture(minimumDistance: 0))
            .updating($dragState) { value, state, _ in
                switch value {
                case .first(true):
                    state = .pressing
                case .second(true, let drag):
                    state = .dragging(translation: drag?.translation ?? .zero)
                default:
                    state = .inactive
                }
            }
            .onEnded { value in
                guard case .second(true, let drag?) = value else { return }
                let t = drag.translation
                if isRecenterDrag(t) {
                    persistedOffsetX = 0
                    resetTick += 1
                } else if abs(t.width) > 3 {
                    // Ignore a stationary hold-release (no real horizontal move) so
                    // it neither nudges the pill nor fires a spurious haptic.
                    persistedOffsetX = clampOffset(persistedOffsetX + Double(t.width))
                    commitTick += 1
                }
            }
    }

    private var pillBody: some View {
        statsRow
            // The rail hangs off the stats row as an overlay and is nudged DOWN
            // into the chrome's 9pt bottom pad. Three constraints meet here:
            //   • overlay, not a VStack sibling — a Shape is greedy in both
            //     axes, so as a sibling it stretched the whole chip to the
            //     composer's full width. As an overlay it adopts the row's.
            //   • offset rather than padding — padding would add height and
            //     this chip must stay exactly as tall as the tools pill (the
            //     lockstep the chrome's doc comment promises). Overlays aren't
            //     clipped, so it draws into the pad for free.
            //   • INSIDE the chrome, not over it — layered above the glass the
            //     rail's fill flattened to near-black.
            .overlay(alignment: .bottom) {
                if showsRatioRail {
                    DiffRatioRail(additions: additions, deletions: deletions)
                        .offset(y: 7)
                }
            }
            // Shared chrome with ComposerToolsPill: slightly taller + real
            // glass. The accent is passed unconditionally; `accentIntensity`
            // decides whether it shows, so a clean tree stays neutral chrome.
            .composerFloatingPillChrome(
                accent: accentColor,
                accentIntensity: accentIntensity,
                accentOverdrive: accentOverdrive,
                glassID: glassNamespace == nil ? nil : "tw.composer.pill.diff",
                glassNamespace: glassNamespace
            )
            .overlay(ComposerPillSpecularSweep(tick: dataTick))
            .onChange(of: dataSignature) { _, _ in dataTick += 1 }
    }

    private var statsRow: some View {
        HStack(spacing: 8) {
            if commitsAhead > 0 {
                NumericTickText(
                    "↑ \(compact(commitsAhead))",
                    value: Double(commitsAhead),
                    font: .caption.weight(.semibold).monospacedDigit(),
                    color: TWTheme.statusAttention)
            }
            if hasFileStats {
                NumericTickText(
                    "\(filesChanged) file\(filesChanged == 1 ? "" : "s")",
                    value: Double(filesChanged),
                    font: .caption.weight(.semibold).monospacedDigit(),
                    color: TWTheme.textSecondary)
                NumericTickText(
                    "+\(compact(additions))",
                    value: Double(additions),
                    font: .caption.weight(.semibold).monospacedDigit(),
                    color: TWTheme.diffStatAdd)
                NumericTickText(
                    "−\(compact(deletions))",
                    value: Double(deletions),
                    font: .caption.weight(.semibold).monospacedDigit(),
                    color: TWTheme.diffStatDel)
            }
        }
    }

    public var body: some View {
        if compactInline {
            // `.contentShape` is load-bearing, not decoration: the glass-chromed
            // `pillBody` leaves the Button with no hit region inside the row's
            // GlassEffectContainer (iOS 26). Same fix as ComposerWorkspacePill;
            // the non-compact branch below already names its shape.
            Button { onTap?() } label: {
                pillBody.contentShape(
                    RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(accessibilityText)
                .accessibilityAction { onTap?() }
        } else {
        HStack(spacing: 0) {
            // Resting position is a LAYOUT inset so the gesture's hit-frame moves
            // WITH the pill — previously a visual-only .offset left the tap /
            // long-press target stranded at centre, so after nudging the pill to
            // an edge you had to press the empty middle to move it again.
            // height 0 so this width-only spacer can't grab vertical space and
            // float the pill to the screen's middle (Color is greedy in 2D, and
            // the empty transcript offers a tall column).
            Color.clear.frame(width: restingLeadingInset, height: 0)
            pillBody
                // Pin to the intrinsic single-line width + outrank the flanking
                // leading inset / trailing Spacer, so an over-constrained row near
                // an edge makes the SPACERS yield — never the pill text (which used
                // to compress into a multi-line wrap). fixedSize is BEFORE the
                // GeometryReader so pillWidth is measured as the true single-line
                // width, keeping maxOffsetX / restingLeadingInset stable.
                .fixedSize(horizontal: true, vertical: false)
                .layoutPriority(1)
                .background(GeometryReader { proxy in
                    Color.clear
                        .onAppear {
                            if let w = Self.quantizedMeasurement(proxy.size.width, current: pillWidth) {
                                pillWidth = w
                            }
                        }
                        .onChange(of: proxy.size.width) { _, w in
                            if let q = Self.quantizedMeasurement(w, current: pillWidth) {
                                pillWidth = q
                            }
                        }
                })
                .scaleEffect(dragState.isActive ? 1.06 : 1)
                // Visual delta DURING a live drag only (the finger is on the pill,
                // so the hit-frame doesn't matter); the committed nudge is layout.
                .offset(x: dragVisualOffset.width, y: dragVisualOffset.height)
                // Lift shadow while repositioning so the pill reads as picked-up.
                .shadow(
                    color: .black.opacity(dragState.isActive ? 0.3 : 0),
                    radius: dragState.isActive ? 12 : 0, y: dragState.isActive ? 6 : 0)
                .contentShape(pillShape)
                // Exclusive so a hold that arms reposition can't ALSO fire the tap:
                // the long-press takes precedence; a quick tap (long-press fails to
                // reach 0.35s) opens the diff. A stationary hold-release no longer
                // opens it — the tap is excluded once the long-press wins.
                .gesture(ExclusiveGesture(repositionGesture, TapGesture().onEnded { onTap?() }))
                // Restore the hardware-keyboard / Full-Keyboard-Access activation the
                // old Button gave (VoiceOver uses the accessibilityAction below).
                .focusable()
                .onKeyPress(.return) {
                    onTap?()
                    return .handled
                }
            Spacer(minLength: 0)
        }
        .animation(
            dragState.isDragging ? nil : .spring(response: 0.32, dampingFraction: 0.72),
            value: dragState)
        // Ease to the new resting inset when a drag commits (the visual delta
        // resets to zero in the same step, so the pill stays put then settles).
        .animation(.spring(response: 0.32, dampingFraction: 0.72), value: persistedOffsetX)
        // Full-width slot keeps the pill centred at rest; the leading inset shifts
        // it via layout (hit-frame follows), and the slot measures the column.
        .frame(maxWidth: .infinity)
        .background(GeometryReader { proxy in
            Color.clear
                .onAppear {
                    if let w = Self.quantizedMeasurement(proxy.size.width, current: containerWidth) {
                        containerWidth = w
                    }
                }
                .onChange(of: proxy.size.width) { _, w in
                    if let q = Self.quantizedMeasurement(w, current: containerWidth) {
                        containerWidth = q
                    }
                }
        })
        .sensoryFeedback(trigger: dragState.isActive) { wasActive, isActive in
            isActive && !wasActive ? MotionHaptics.impactMedium : nil
        }
        .motionHaptic(MotionHaptics.selection, trigger: commitTick)
        .motionHaptic(MotionHaptics.success, trigger: resetTick)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint("Touch and hold to move the pill; drag up to recentre.")
        .accessibilityAction { onTap?() }
        .accessibilityAction(named: Text("Recentre")) { persistedOffsetX = 0 }
        } // !compactInline
    }

    private var accessibilityText: String {
        var parts: [String] = []
        if commitsAhead > 0 {
            parts.append("\(commitsAhead) commit\(commitsAhead == 1 ? "" : "s") ahead")
        }
        if hasFileStats {
            parts.append("\(filesChanged) file\(filesChanged == 1 ? "" : "s") changed")
            parts.append("\(additions) added")
            parts.append("\(deletions) removed")
        }
        return "\(parts.joined(separator: ", ")). Open changes."
    }
}

/// Third floating chip above the composer: which workspace and branch this
/// thread is pointed at, plus the git state the diff pill does NOT carry.
///
/// Deliberately complementary rather than duplicative. `ComposerDiffPill` owns
/// commits-AHEAD, files changed and ±lines; this owns the things it has no room
/// for — where you are (workspace, branch) and what is in your way (behind
/// count, an in-progress merge/rebase, conflicts).
///
/// Wide viewports only. On a portrait phone the row has no width to spare and
/// two chips is already the limit.
///
/// The workspace picker is OPTIONAL and off by default. A thread's workspace is
/// only choosable before its first turn (`ThreadEmptyWelcomeCanvas` owns that);
/// a live thread cannot be repointed, so from the transcript this chip is a
/// readout. The picker exists for hosts that legitimately can switch.
///
/// NOTE: no pull-request state. The iOS models carry no PR/checks data at all
/// (`GitWorkspaceSnapshot` stops at remoteUrl), so a PR chip would need a bridge
/// change first. Branch + upstream is the honest subset available today.
public struct ComposerWorkspacePill: View {
    let workspaceName: String?
    let branch: String?
    let behind: Int
    let mergeState: String?
    let conflicts: Int
    /// Empty disables the picker and the chip renders as a plain readout.
    let workspaceOptions: [(id: String, name: String)]
    let primaryWorkspaceId: String?
    var onSelectWorkspace: ((String) -> Void)? = nil
    /// Opens the git workspace surface (branch / commit / PR). When set, this
    /// wins over the workspace-switch menu: on a live thread the workspace is
    /// fixed but the BRANCH and its changes are exactly what the pill is
    /// reporting, so the git surface is what a tap should reach. Without it the
    /// pill was a dead readout — it stated a branch and did nothing about it.
    var onOpenGitSurface: (() -> Void)? = nil
    var glassNamespace: Namespace.ID? = nil

    public init(
        workspaceName: String?,
        branch: String?,
        behind: Int = 0,
        mergeState: String? = nil,
        conflicts: Int = 0,
        workspaceOptions: [(id: String, name: String)] = [],
        primaryWorkspaceId: String? = nil,
        onSelectWorkspace: ((String) -> Void)? = nil,
        onOpenGitSurface: (() -> Void)? = nil,
        glassNamespace: Namespace.ID? = nil
    ) {
        self.workspaceName = workspaceName
        self.branch = branch
        self.behind = max(0, behind)
        self.mergeState = mergeState
        self.conflicts = max(0, conflicts)
        self.workspaceOptions = workspaceOptions
        self.primaryWorkspaceId = primaryWorkspaceId
        self.onSelectWorkspace = onSelectWorkspace
        self.onOpenGitSurface = onOpenGitSurface
        self.glassNamespace = glassNamespace
    }

    /// Nothing to say without at least a workspace or a branch.
    public var hasContent: Bool {
        !(workspaceName ?? "").isEmpty || !(branch ?? "").isEmpty
    }

    private var isObstructed: Bool { conflicts > 0 || (mergeState?.isEmpty == false) }

    /// Conflicts outrank a plain in-progress merge; behind is the mild case.
    private var accentIntensity: Double {
        if conflicts > 0 { return 1 }
        if mergeState?.isEmpty == false { return 0.7 }
        return behind > 0 ? min(0.6, Double(behind) / 40) : 0
    }

    private var accentColor: Color {
        conflicts > 0 ? TWTheme.statusFailed : TWTheme.statusAttention
    }

    private var canSwitch: Bool { onSelectWorkspace != nil && workspaceOptions.count > 1 }

    public var body: some View {
        Group {
            if let onOpenGitSurface {
                Button(action: onOpenGitSurface) {
                    // Load-bearing (iOS 26): `chipBody` ends in
                    // `composerFloatingPillChrome`, whose `glassEffect` is
                    // rendered by the row's shared `GlassEffectContainer`. A
                    // Button whose label is nothing but that effect gets NO hit
                    // region — the pill drew, animated and read correctly to
                    // VoiceOver, and taps did nothing at all. Naming the shape
                    // gives the Button its own region back. ComposerToolsPill
                    // dodges this by passing `interactive: false` and owning its
                    // Buttons INSIDE the glass; that is not an option here,
                    // where the whole chip is one target.
                    chipBody.contentShape(
                        RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
            } else if canSwitch {
                Menu {
                    Section("Workspace") {
                        ForEach(workspaceOptions, id: \.id) { option in
                            Button {
                                onSelectWorkspace?(option.id)
                            } label: {
                                if option.id == primaryWorkspaceId {
                                    Label(option.name, systemImage: "checkmark")
                                } else {
                                    Text(option.name)
                                }
                            }
                        }
                    }
                } label: {
                    chipBody
                }
                .buttonStyle(.plain)
            } else {
                chipBody
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint(
            onOpenGitSurface != nil
                ? "Open branch, changes and pull request controls."
                : canSwitch ? "Switch the thread's workspace." : "")
    }

    private var chipBody: some View {
        HStack(spacing: 6) {
            if let workspaceName, !workspaceName.isEmpty {
                Image(systemName: "folder")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Text(workspaceName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textSecondary)
                    // The branch is the more specific fact, so the workspace
                    // name is what yields when the row is tight.
                    .layoutPriority(-1)
            }

            if let branch, !branch.isEmpty {
                Image(systemName: "arrow.trianglehead.branch")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Text(branch)
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(TWTheme.textPrimary)
            }

            if behind > 0 {
                NumericTickText(
                    "↓ \(behind)",
                    value: Double(behind),
                    font: .caption.weight(.semibold).monospacedDigit(),
                    color: TWTheme.statusAttention)
            }

            if isObstructed {
                Image(
                    systemName: conflicts > 0
                        ? "exclamationmark.triangle.fill" : "arrow.triangle.merge"
                )
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(accentColor)
            }
        }
        .lineLimit(1)
        .composerFloatingPillChrome(
            accent: accentColor,
            accentIntensity: accentIntensity,
            glassID: glassNamespace == nil ? nil : "tw.composer.pill.workspace",
            glassNamespace: glassNamespace)
    }

    private var accessibilityText: String {
        var parts: [String] = []
        if let workspaceName, !workspaceName.isEmpty { parts.append("Workspace \(workspaceName)") }
        if let branch, !branch.isEmpty { parts.append("Branch \(branch)") }
        if behind > 0 { parts.append("\(behind) behind") }
        if let mergeState, !mergeState.isEmpty { parts.append("\(mergeState) in progress") }
        if conflicts > 0 { parts.append("\(conflicts) conflict\(conflicts == 1 ? "" : "s")") }
        return parts.joined(separator: ", ")
    }
}

/// Side chats tab — the thread's isolated/guest side chats, plus creation.
struct SideChatsPanel: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    var onOpenThread: ((String) -> Void)? = nil
    /// Inline-selected side chat — renders the mini chat window (the
    /// desktop's right-hand side-chat pane, phone-idiom).
    @State private var selectedSideChatId: String? = nil
    @State private var createSheetPresented = false
    @State private var createProvider = "codex"
    @State private var createModelId: String?
    @State private var createReasoningEffort: String?
    @State private var pendingOpen: RemoteTaskCard?

    private var card: RemoteTaskCard? { model.taskCards.first { $0.id == threadId } }

    private var sideChats: [RemoteTaskCard] {
        // Isolated side chats only — a guest-mode side chat (sideChatMode
        // "guestParticipant") was historically a MAIN-transcript peer whose
        // replies mirrored inline rather than an isolated sidecar. The live
        // guest feature is removed, but pre-existing guest side chats still
        // carry that mode, so they stay excluded here to avoid double-listing.
        model.taskCards.filter {
            $0.parentChatId == threadId && $0.isIsolatedSideChat
        }
    }

    private var catalogs: [ProviderModelCatalog] {
        twOfferedProviderCatalogs(
            model.providerModels)
    }
    private var createCatalog: ProviderModelCatalog? {
        catalogs.first { $0.provider.lowercased() == createProvider.lowercased() }
    }

    var body: some View {
        Group {
            if let selected = selectedSideChatId {
                if let sideCard = selectedSideChatCard(selected) {
                    MiniThreadView(
                        model: model, card: sideCard,
                        onBack: { selectedSideChatId = nil },
                        onExpand: { onOpenThread?(selected) })
                } else {
                    SideChatOpeningView {
                        selectedSideChatId = nil
                    }
                    .task(id: selected) {
                        model.requestThreadSnapshot(selected)
                    }
                }
            } else {
                ScrollView {
                    listBody
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(.bottom, 16)
                }
            }
        }
        .confirmationDialog(
            pendingOpenTitle, isPresented: openDialogPresented,
            titleVisibility: .visible
        ) {
            if let pendingOpen {
                Button("Open in Main") {
                    onOpenThread?(pendingOpen.id)
                }
                Button("Open in Side Chat") {
                    openInline(pendingOpen)
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear { adoptRequestedSideChat() }
        .onChange(of: model.inspectorSideChatTarget) { _, _ in
            adoptRequestedSideChat()
        }
    }

    private var listBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                seedCreateSelection()
                createSheetPresented = true
            } label: {
                Label("New side chat", systemImage: "plus.bubble")
                    .font(.caption.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(TWTheme.chroma1.opacity(0.14), in: Capsule())
                    .foregroundStyle(TWTheme.chroma1)
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $createSheetPresented) {
                ProviderModelPickerSheet(
                    catalogs: catalogs,
                    provider: $createProvider,
                    modelId: $createModelId,
                    reasoningEffort: $createReasoningEffort,
                    title: "New Side Chat",
                    confirmationTitle: "Create",
                    dismissesOnSelection: false
                ) {
                    guard let card else { return }
                    model.createSideChat(
                        card,
                        provider: createProvider,
                        // Pass nil (not the string "default") when no model was
                        // picked — the wire builder omits the key and the Mac
                        // resolves the provider default; "default" isn't a valid
                        // Codex sentinel and would dispatch a bogus model.
                        model: createModelId,
                        reasoningEffort: createReasoningEffort,
                        navigateOnAck: false
                    ) { threadId in
                        if let threadId, threadId != card.threadId {
                            selectedSideChatId = threadId
                            if let workspaceId = card.workspaceId {
                                model.rememberThreadWorkspace(threadId, workspaceId: workspaceId)
                            }
                            model.requestThreadSnapshot(threadId)
                        }
                    }
                }
                .twSheetLiquidGlass(detents: [.medium, .large])
            }

            if sideChats.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "arrow.left.arrow.right.circle")
                        .font(.title2)
                        .foregroundStyle(TWTheme.textTertiary)
                    Text("No side chats yet — isolated conversations that hang off this thread.")
                        .font(.footnote)
                        .foregroundStyle(TWTheme.textSecondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
            } else {
                ForEach(sideChats, id: \.id) { sideChat in
                    Button {
                        pendingOpen = sideChat
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            if let agentName = sideChat.agentName {
                                AgentIdentityBadge(
                                    name: agentName,
                                    accentHex: sideChat.agentAccent,
                                    slug: sideChat.agentSlug)
                            } else {
                                Image(systemName: "arrow.left.arrow.right")
                                    .font(.caption)
                                    .foregroundStyle(
                                        TWTheme.providerAccent(sideChat.provider))
                                    .frame(width: 16)
                                    .padding(.top, 2)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(sideChat.title ?? sideChat.id)
                                    .font(.subheadline)
                                    .foregroundStyle(TWTheme.textPrimary)
                                    .lineLimit(2)
                                HStack(spacing: 6) {
                                    Text(TWTheme.providerLabel(sideChat.provider))
                                        .font(.caption2.weight(.medium))
                                        .foregroundStyle(
                                            TWTheme.providerAccent(sideChat.provider))
                                    Text(sideChat.isGuestSideChat ? "Guest" : "Isolated")
                                        .font(.caption2)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 1)
                                        .background(TWTheme.surface3, in: Capsule())
                                        .foregroundStyle(TWTheme.textTertiary)
                                    if let status = sideChat.status {
                                        Circle()
                                            .fill(TWTheme.statusColor(status))
                                            .frame(width: 5, height: 5)
                                    }
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.caption2)
                                .foregroundStyle(TWTheme.textMuted)
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .onAppear { seedCreateSelection() }
        .onChange(of: card?.provider ?? "") { _, _ in seedCreateSelection() }
    }

    private var pendingOpenTitle: String {
        guard let pendingOpen else { return "Open chat" }
        return "Open \(pendingOpen.title ?? pendingOpen.agentName ?? "side chat")"
    }

    private var openDialogPresented: Binding<Bool> {
        Binding(
            get: { pendingOpen != nil },
            set: { isPresented in
                if !isPresented { pendingOpen = nil }
            })
    }

    private func openInline(_ child: RemoteTaskCard) {
        if let workspaceId = child.workspaceId {
            model.rememberThreadWorkspace(child.id, workspaceId: workspaceId)
        }
        model.requestThreadSnapshot(child.id)
        selectedSideChatId = child.id
    }

    private func seedCreateSelection() {
        let preferred = card?.provider ?? createProvider
        let known = catalogs.first { $0.provider.lowercased() == preferred.lowercased() }
        createProvider = known?.provider ?? catalogs.first?.provider ?? preferred
        createModelId = nil
        twNormalizeReasoningSelection(
            catalog: createCatalog, modelId: createModelId,
            reasoningEffort: &createReasoningEffort)
    }

    private func selectedSideChatCard(_ id: String) -> RemoteTaskCard? {
        guard id != threadId else { return nil }
        return model.taskCards.first {
            $0.id == id && $0.parentChatId == threadId && $0.isIsolatedSideChat
        }
    }

    private func adoptRequestedSideChat() {
        guard let target = model.inspectorSideChatTarget,
            selectedSideChatCard(target) != nil
        else { return }
        selectedSideChatId = target
        model.inspectorSideChatTarget = nil
        model.requestThreadSnapshot(target)
    }
}

private struct SideChatOpeningView: View {
    var onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Button(action: onCancel) {
                    Image(systemName: "chevron.left")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TWTheme.textSecondary)
                        .frame(width: 24, height: 24)
                        .background(TWTheme.surface3, in: Circle())
                }
                .buttonStyle(.plain)
                ProgressView()
                    .controlSize(.small)
                    .tint(TWTheme.chroma1)
                Text("Opening side chat…")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer(minLength: 0)
            }
            Text("Waiting for the Mac to project the new isolated thread.")
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, 8)
    }
}

/// Mini chat window for a side chat inside the inspector column — the
/// SAME transcript rows + composer shell conventions/tokens as the main
/// pane, slimmed naturally by the column width (≈2× the iPhone composer).
/// See ThreadDetailView.awaitNextMainRunloop — same NOT-`Task.yield()`
/// rationale (a cooperative suspension can resume before SwiftUI has
/// materialized the new sentinel row for this update); duplicated as a free
/// function here since MiniThreadView is a separate type in a separate file.
@MainActor
private func twAwaitNextMainRunloop() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        DispatchQueue.main.async { continuation.resume() }
    }
}

struct MiniThreadView: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    var onBack: () -> Void
    var onExpand: () -> Void
    @State private var draft = ""
    @State private var composerOverlayHeight: CGFloat = 150
    /// Follow the tail as content streams in — mirrors the main transcript's
    /// `autoFollow` (ThreadDetailView), driven by the same bottom-sentinel
    /// appear/disappear pattern. Previously this panel had NO auto-follow at
    /// all: a bare ScrollView, so new messages never scrolled into view and
    /// nothing disengaged on a manual scroll either.
    @State private var autoFollow = true
    @State private var followPin = TranscriptFollowPin()

    private var threadId: String { card.id }
    private var snapshot: RemoteThreadSnapshot? { model.threadSnapshots[threadId] }
    private var transcriptBottomInset: CGFloat { composerOverlayHeight + 12 }
    private var isPadInterface: Bool {
        #if os(iOS)
            return UIDevice.current.userInterfaceIdiom == .pad
        #else
            return false
        #endif
    }

    var body: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 8) {
                header
                transcriptStage(proxy: proxy)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .onPreferenceChange(MiniThreadComposerHeightKey.self) { height in
                guard height > 0 else { return }
                guard abs(composerOverlayHeight - height) > 1 else { return }
                composerOverlayHeight = height
            }
            .onChange(of: snapshot?.rows?.count ?? 0) { _, _ in
                guard autoFollow else { return }
                requestFollowPin(proxy, force: true)
            }
            .onChange(of: model.streamingTexts[threadId] ?? "") { _, _ in
                guard autoFollow else { return }
                requestFollowPin(proxy, force: true)
            }
            .task(id: threadId) {
                model.requestThreadSnapshot(threadId)
                followPin.userLatchedOff = false
                autoFollow = true
                try? await Task.sleep(nanoseconds: 350_000_000)
                requestFollowPin(proxy, force: true)
            }
        }
    }

    /// Mirrors ThreadDetailView.requestFollowPin (main transcript): coalesced,
    /// two-runloop-deferred scroll-to-bottom, gated by TranscriptFollowPolicy.
    /// Kept as a lightweight instance twin rather than shared, since the two
    /// views' proxies/sentinel ids differ and this panel has no reveal-pump
    /// onRevealFrame hook to throttle (every call here is a real content
    /// change, so there's no non-forced path to rate-limit).
    private func requestFollowPin(_ proxy: ScrollViewProxy, force: Bool = false) {
        guard autoFollow else { return }
        guard !followPin.scheduled else { return }
        followPin.scheduled = true
        Task { @MainActor in
            defer { followPin.scheduled = false }
            await twAwaitNextMainRunloop()
            guard TranscriptFollowPolicy.shouldScroll(
                autoFollow: autoFollow,
                force: force,
                lastUserTouchAt: followPin.lastUserTouchAt
            ) else { return }
            scrollMiniSentinelToBottomNow(proxy)
            await twAwaitNextMainRunloop()
            guard TranscriptFollowPolicy.shouldScroll(
                autoFollow: autoFollow,
                force: force,
                lastUserTouchAt: followPin.lastUserTouchAt
            ) else { return }
            scrollMiniSentinelToBottomNow(proxy)
        }
    }

    private func scrollMiniSentinelToBottomNow(_ proxy: ScrollViewProxy) {
        followPin.lastProgrammaticPinAt = Date()
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            // Tail id (not the visibility sentinel) — same shape as the main
            // transcript, so settle pins and sentinel appear/disappear stay
            // independent.
            proxy.scrollTo("mini-transcript-tail", anchor: .bottom)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TWTheme.textSecondary)
                        .frame(width: 24, height: 24)
                        .background(TWTheme.surface3, in: Circle())
                }
                .buttonStyle(.plain)
                if let agentName = card.agentName {
                    AgentIdentityBadge(
                        name: agentName, accentHex: card.agentAccent,
                        slug: card.agentSlug, size: 18)
                }
                Text(card.title ?? "Side chat")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                Spacer()
                Button(action: onExpand) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                        .frame(width: 24, height: 24)
                        .background(TWTheme.surface3, in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func transcriptStage(proxy: ScrollViewProxy) -> some View {
        ZStack(alignment: .bottom) {
            transcriptArea(proxy: proxy)
            composerOverlay
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func transcriptArea(proxy: ScrollViewProxy) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                transcriptContent
                // Bottom sentinel — same self-correcting appear/disappear
                // pattern as the main transcript's "transcript-bottom": on
                // screen ⇒ we're at the latest message (keep following);
                // off-screen ⇒ the user scrolled up (stop following) until
                // they scroll back down themselves. Touch-gated OFF + pin
                // grace on ON match ThreadDetailView so layout thrash cannot
                // latch follow off or yank it back on.
                Color.clear
                    .frame(height: 1)
                    .id("mini-transcript-bottom")
                    .onAppear {
                        guard TranscriptFollowPolicy.sentinelAppearShouldRearmFollowing(
                            userLatchedOff: followPin.userLatchedOff,
                            lastProgrammaticPinAt: followPin.lastProgrammaticPinAt)
                        else { return }
                        followPin.userLatchedOff = false
                        autoFollow = true
                    }
                    .onDisappear {
                        if TranscriptFollowPolicy.sentinelDisappearanceEndsFollowing(
                            lastUserTouchAt: followPin.lastUserTouchAt)
                        {
                            followPin.userLatchedOff = true
                            followPin.lastProgrammaticPinAt = .distantPast
                            autoFollow = false
                        } else if autoFollow {
                            requestFollowPin(proxy, force: true)
                        }
                    }
                Color.clear
                    .frame(height: 1)
                    .id("mini-transcript-tail")
                    .accessibilityHidden(true)
                Color.clear
                    .frame(height: transcriptBottomInset)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .transcriptTouchTracking(isPadInterface: isPadInterface) {
            followPin.lastUserTouchAt = Date()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var composerOverlay: some View {
        VStack(spacing: 0) {
            LinearGradient(
                colors: [
                    TWTheme.appBg.opacity(0),
                    TWTheme.appBg.opacity(0.92),
                    TWTheme.appBg
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 18)
            .allowsHitTesting(false)
            composerShell
        }
        .background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: MiniThreadComposerHeightKey.self,
                    value: proxy.size.height)
            }
        )
        .shadow(color: .black.opacity(0.28), radius: 10, y: -2)
    }

    @ViewBuilder
    private var transcriptContent: some View {
        // Transcript (recent window; full history lives in the main pane)
        let rows = Array((snapshot?.rows ?? []).suffix(30))
        if rows.isEmpty {
            // Same trap the main thread view already solved: an
            // existing side chat WITH history briefly looked like an
            // empty one while its snapshot was in flight (the .task
            // below requests it on open). Only a delivered snapshot
            // with zero total rows is genuinely "no messages".
            if let snapshot, (snapshot.totalRows ?? 0) == 0 {
                Text("No messages yet — say hi below.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .padding(.vertical, 10)
            } else {
                HydrationTicker("Loading side chat…")
            }
        } else {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(rows, id: \.id) { row in
                    ThreadRowView(
                        model: model, threadId: threadId,
                        row: model.resolvedRow(row, threadId: threadId),
                        threadProvider: card.provider,
                        agentIdentity: ThreadAgentIdentity(card: card),
                        isExpanding: model.expandingRows.contains(row.id),
                        participants: model.ensembleStates[threadId]?.displayParticipants ?? [],
                        isPinned: snapshot?.pinnedRows?.contains(where: { $0.id == row.id }) == true
                    )
                    .equatable()
                }
            }
        }
        if let live = model.streamingTexts[threadId], !live.isEmpty {
            StreamingRowView(
                text: live, provider: card.provider,
                model: snapshot?.runSummary?.model,
                agentIdentity: ThreadAgentIdentity(card: card),
                participants: model.ensembleStates[threadId]?.displayParticipants ?? [],
                isComplete: model.streamingTerminalThreads.contains(threadId))
        }
    }

    private var composerShell: some View {
        VStack(spacing: 0) {
            if let queued = card.queuedComposerPrompts, !queued.isEmpty {
                QueuedComposerPromptsStack(
                    model: model, card: card, prompts: queued,
                    isShellTop: true
                ) { queuedText in
                    draft = queuedText
                }
                Rectangle().fill(TWTheme.border).frame(height: 1)
            }
            Composer(
                model: model, card: card,
                runModel: snapshot?.runSummary?.model,
                runStatus: snapshot?.runSummary?.status,
                attachedTop: !(card.queuedComposerPrompts ?? []).isEmpty,
                attachedBottom: true,
                navigateOnSend: false,
                // Side-chat mini composer stays full for v1 (its queued stack +
                // rail show unconditionally); idle-collapse here is a follow-up.
                forcesExpanded: true,
                text: $draft)
            .onAppear {
                if draft.isEmpty { draft = TWDraftPersistence.draft(for: card.id) }
            }
            .onChange(of: draft) { _, newValue in
                TWDraftPersistence.setDraft(newValue, for: card.id)
            }
            Rectangle().fill(TWTheme.border).frame(height: 1)
            TelemetryFooterRail(
                run: snapshot?.runSummary,
                conversationCostText: snapshot?.conversationCostText,
                workspaceName: model.workspaceName(for: card.workspaceId),
                activeGoal: card.activeGoal,
                onGoalUpdate: { op, objective, reason in
                    model.updateGoal(card, op: op, objective: objective, reason: reason)
                })
        }
        .composerShellUnlessInputOwns(twResolvedComposerShell(model: model, presentation: .miniSideChat))
    }
}

private struct MiniThreadComposerHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Usage tab — MODEL USAGE sidebar parity: per-provider quota sections with
/// gradient limit bars, plus the activity heatmap below. Data refreshes
/// over the bridge every ~7.5 minutes (cheap: the Mac serves its own
/// TTL-cached snapshots).
struct UsagePanel: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String?
    @State private var selectedView: UsagePanelView = .plan

    private static let providerOrder = [
        "gemini", "codex", "claude", "kimi", "cursor", "grok", "pi", "mistral", "muse",
        "antigravity", "ollama", "deepseek", "cerebras",
    ]

    private enum UsagePanelView: String, CaseIterable, Identifiable {
        case plan
        case spend
        case context

        var id: String { rawValue }
        var title: String {
            switch self {
            case .plan: return "Plan"
            case .spend: return "Spend"
            case .context: return "Context"
            }
        }
    }

    private var providers: [ModelUsageMessage.ProviderUsage] {
        let entries = model.modelUsage?.providers ?? []
        return entries.sorted {
            (Self.providerOrder.firstIndex(of: $0.provider) ?? 99)
                < (Self.providerOrder.firstIndex(of: $1.provider) ?? 99)
        }
    }

    private var spendProviders: [ModelUsageMessage.SpendProvider] {
        (model.modelUsage?.spend?.providers ?? [])
            .sorted {
                (Self.providerOrder.firstIndex(of: $0.provider) ?? 99)
                    < (Self.providerOrder.firstIndex(of: $1.provider) ?? 99)
            }
    }

    private var hasSpendView: Bool {
        !spendProviders.isEmpty
            || model.modelUsage?.antigravityBudget != nil
            || model.modelUsage?.museBudget != nil
    }

    private var asOfText: String? {
        guard let generated = model.modelUsage?.generatedAt,
            let date = twParseISODate(generated)
        else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return "as of \(formatter.string(from: date))"
    }

    private var inspectedCard: RemoteTaskCard? {
        guard let threadId, !threadId.isEmpty else { return nil }
        return model.taskCards.first { $0.id == threadId || $0.threadId == threadId }
    }

    private var workspaceActivityCards: [RemoteTaskCard] {
        guard let workspaceId = inspectedCard?.workspaceId, !workspaceId.isEmpty else {
            return model.taskCards.filter { ($0.workspaceId ?? "").isEmpty }
        }
        return model.taskCards.filter { $0.workspaceId == workspaceId }
    }

    private var activityHeatmapEntries: [ActivityHeatmapStack.Entry] {
        let workspaceEvents = twActivityHeatmapEvents(from: workspaceActivityCards)
        let taskWraithEvents = twActivityHeatmapEvents(from: model.taskCards)
        let externalEvents: [ActivityHeatmapEvent] = []
        return [
            .init(
                flavor: .init(
                    id: "taskwraith", title: "TaskWraith Activity",
                    caption: "all TaskWraith runs", accent: TWTheme.chroma3,
                    events: taskWraithEvents)),
            .init(
                flavor: .init(
                    id: "workspace", title: "Workspace Activity",
                    caption: "current workspace", accent: TWTheme.chroma1,
                    events: workspaceEvents)),
            .init(
                flavor: .init(
                    id: "external", title: "External Activity",
                    caption: "external usage", accent: TWTheme.providerAccent("cursor"),
                    events: externalEvents),
                rollup: model.usageRollup),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Model usage")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Spacer()
                if let asOfText {
                    Text(asOfText)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textMuted)
                }
            }
            if hasSpendView {
                Picker("Usage view", selection: $selectedView) {
                    ForEach(UsagePanelView.allCases) { view in
                        Text(view.title).tag(view)
                    }
                }
                .pickerStyle(.segmented)
            }
            switch hasSpendView ? selectedView : .plan {
            case .plan:
                if providers.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "gauge.with.dots.needle.50percent")
                            .font(.title2)
                            .foregroundStyle(TWTheme.textTertiary)
                        Text("Usage data arrives from your computer within a few minutes of connecting.")
                            .font(.footnote)
                            .foregroundStyle(TWTheme.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
                } else {
                    ForEach(providers) { entry in
                        providerSection(entry)
                    }
                }
            case .spend:
                spendView
            case .context:
                ContextLengthsView(includeOllama: true, excludeProviders: ["gemini"])
            }

            ActivityHeatmapStack(entries: activityHeatmapEntries)
            .padding(.top, 6)

            TokenUsageBarChart(title: "TaskWraith Tokens", series: model.taskwraithTokenDaily)
                .padding(.top, 6)
            TokenUsageBarChart(title: "External Tokens", series: model.externalTokenDaily)
        }
    }

    @ViewBuilder
    private func providerSection(_ entry: ModelUsageMessage.ProviderUsage) -> some View {
        let accent = TWTheme.providerAccent(entry.provider)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                ProviderLogoIcon(provider: entry.provider, size: 20)
                Text(TWTheme.providerLabel(entry.provider))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textPrimary)
                if let planName = entry.planName,
                    !planName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                {
                    Text(planName)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(accent)
                }
                Spacer()
            }
            ForEach(entry.windows) { window in
                limitRow(window, accent: accent)
            }
        }
        .padding(10)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }

    @ViewBuilder
    private var spendView: some View {
        if spendProviders.isEmpty && model.modelUsage?.antigravityBudget == nil && model.modelUsage?.museBudget == nil {
            Text("No API spend tracked in the last 30 days.")
                .font(.footnote)
                .foregroundStyle(TWTheme.textSecondary)
        } else {
            ForEach(spendProviders) { entry in
                spendProviderSection(entry)
            }
            if let budget = model.modelUsage?.antigravityBudget {
                softBudgetSection(budget, title: "AntiGravity budget")
            }
            if let budget = model.modelUsage?.museBudget {
                softBudgetSection(budget, title: "Muse budget")
            }
            Text("Projected API-equivalent spend — estimated, not billed.")
                .font(.caption2)
                .foregroundStyle(TWTheme.textTertiary)
        }
    }

    @ViewBuilder
    private func spendProviderSection(_ entry: ModelUsageMessage.SpendProvider) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                ProviderLogoIcon(provider: entry.provider, size: 20)
                Text(TWTheme.providerLabel(entry.provider))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
            }
            ForEach(entry.windows) { window in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(window.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text("\(window.totalTokens.formatted()) tok")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(TWTheme.textTertiary)
                    Spacer()
                    Text(window.costText.map { "~\($0)" } ?? "—")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                }
                Text("\(window.runs) run\(window.runs == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
        }
        .padding(10)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }

    @ViewBuilder
    private func softBudgetSection(
        _ budget: ModelUsageMessage.AntigravityBudget,
        title: String
    ) -> some View {
        let accent = TWTheme.providerAccent(budget.provider)
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 7) {
                Image(systemName: "gauge.with.dots.needle.67percent")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(accent)
                Text(title)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textPrimary)
                Spacer()
                Text("\(budget.usedPercent)%")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
            }
            HStack {
                Text(budget.spentText.map { "~\($0)" } ?? "—")
                Text("of \(budget.capText)")
                    .foregroundStyle(TWTheme.textTertiary)
                Spacer()
                if let resets = resetsText(budget.resetAt) {
                    Text(resets)
                        .foregroundStyle(TWTheme.textTertiary)
                }
            }
            .font(.caption2.monospacedDigit())
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(TWTheme.textPrimary.opacity(0.08))
                    Capsule()
                        .fill(accent)
                        .frame(width: max(2, geo.size.width * CGFloat(budget.usedPercent) / 100))
                }
            }
            .frame(height: 6)
            Text("Soft advisory budget — it never blocks a run.")
                .font(.caption2)
                .foregroundStyle(TWTheme.textTertiary)
        }
        .padding(10)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
    }

    @ViewBuilder
    private func limitRow(_ window: ModelUsageMessage.Window, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(window.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                if let resets = resetsText(window.resetAt) {
                    Text(resets)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                }
                Spacer()
                Text(window.valueText ?? "\(window.usedPercent)%")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
            }
            // Desktop bar anatomy: 6pt track, gradient defined in TRACK
            // coordinates (accent → amber@90% → red@100%) and masked to the
            // used fraction — so a 40% bar shows pure accent and the amber/
            // red only appear as usage approaches the limit.
            GeometryReader { geo in
                let fraction = CGFloat(window.usedPercent) / 100
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(TWTheme.textPrimary.opacity(0.08))
                    LinearGradient(
                        stops: [
                            .init(color: accent, location: 0),
                            .init(color: accent, location: 0.6),
                            .init(color: Color(hex: 0xF59E0B), location: 0.9),
                            .init(color: Color(hex: 0xDC2626), location: 1.0),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: geo.size.width)
                    .mask(
                        HStack {
                            Capsule()
                                .frame(width: max(2, geo.size.width * fraction))
                            Spacer(minLength: 0)
                        }
                    )
                }
            }
            .frame(height: 6)
            Text(window.limitLabel)
                .font(.caption2)
                .foregroundStyle(TWTheme.textTertiary)
        }
    }

    private func resetsText(_ resetAt: String?) -> String? {
        guard let resetAt, let date = twParseISODate(resetAt) else { return nil }
        let formatter = DateFormatter()
        let sameDay = Calendar.current.isDateInToday(date)
        formatter.dateFormat = sameDay ? "'resets' HH:mm" : "'resets' d MMM"
        return formatter.string(from: date)
    }
}
