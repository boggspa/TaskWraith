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

    public init(size: CGFloat = 58, glow: Bool = true) {
        self.size = size
        self.glow = glow
    }

    public var body: some View {
        ZStack {
            if glow {
                Circle()
                    .fill(
                        RadialGradient(
                            gradient: Gradient(
                                stops: [
                                    .init(color: TWTheme.chroma1Default.opacity(0.34), location: 0),
                                    .init(
                                        color: TWTheme.chroma1Default.opacity(0.16),
                                        location: 0.46
                                    ),
                                    .init(color: TWTheme.chroma1Default.opacity(0), location: 0.76)
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
                if let image = Self.loadImage() {
                    image
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                } else {
                    Image(systemName: "sparkles")
                        .font(.system(size: size * 0.55, weight: .semibold))
                }
            }
            .foregroundStyle(markColor)
            .shadow(color: shadowColor, radius: 1, y: 1)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var markColor: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.black.opacity(0.76) : Color.white.opacity(0.94)
    }

    private var shadowColor: Color {
        TWThemeStore.shared.systemTheme.isLight
            ? Color.white.opacity(0.4) : Color.black.opacity(0.24)
    }

    private static func loadImage() -> Image? {
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
    }
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
    var count: Int? = nil
    var collapsed: Bool = false
    var onToggle: (() -> Void)? = nil

    var body: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { onToggle?() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TWTheme.textTertiary)
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                }
                Text(title)
                    .font(.subheadline.weight(.semibold))
                if let count, count > 0 {
                    Text("\(count)")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(TWTheme.surface3, in: Capsule())
                        .foregroundStyle(TWTheme.textTertiary)
                }
            }
            .foregroundStyle(TWTheme.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .modifier(GlassPillBackground())
        }
        .buttonStyle(.plain)
        .disabled(onToggle == nil)
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

/// Hierarchical provider → model menu for phone-sized composer surfaces.
struct ProviderModelPicker: View {
    let catalogs: [ProviderModelCatalog]
    @Binding var provider: String
    @Binding var modelId: String?
    @Binding var reasoningEffort: String?
    var allowsProviderChange: Bool = true

    private var currentCatalog: ProviderModelCatalog? {
        catalogs.first { $0.provider.lowercased() == provider.lowercased() }
    }
    private var reasoningLabel: String? {
        guard let effort = reasoningEffort,
            !twReasoningOptions(in: currentCatalog, modelId: modelId).isEmpty
        else { return nil }
        return twReasoningDisplayLabel(effort)
    }

    var body: some View {
        Menu {
            pickerMenuContent
        } label: {
            pickerLabel
        }
        .buttonStyle(.plain)
        .onChange(of: provider) { _, newProvider in
            // Switching provider invalidates a model from the OLD catalog —
            // reset to nil (= inherit on existing chats / provider default
            // on new ones, resolved Mac-side). Never force-pick a default:
            // that stamped the catalog default over the chat's real model
            // before the snapshot could land.
            guard modelId != nil else { return }
            let catalog = catalogs.first {
                $0.provider.lowercased() == newProvider.lowercased()
            }
            if catalog == nil || !(catalog!.models.contains { $0.id == modelId }) {
                modelId = nil
            }
            twNormalizeReasoningSelection(
                catalog: catalog, modelId: modelId, reasoningEffort: &reasoningEffort)
        }
        .onChange(of: modelId) { _, _ in
            twNormalizeReasoningSelection(
                catalog: currentCatalog, modelId: modelId, reasoningEffort: &reasoningEffort)
        }
        .onAppear {
            twNormalizeReasoningSelection(
                catalog: currentCatalog, modelId: modelId, reasoningEffort: &reasoningEffort)
        }
    }

    private var pickerLabel: some View {
        // Flat text labels (desktop composer parity) — the whole run of
        // text is the tap target; no pill chrome.
        HStack(spacing: 6) {
            Circle()
                .fill(TWTheme.providerAccent(provider))
                .frame(width: 7, height: 7)
            Text(TWTheme.providerLabel(provider))
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.providerAccent(provider))
            Text(modelId.map(shortModelLabel) ?? "Default")
                .font(.caption)
                .foregroundStyle(TWTheme.textPrimary)
                .lineLimit(1)
            if let reasoningLabel {
                Text("· \(reasoningLabel)")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textSecondary)
                    .lineLimit(1)
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(TWTheme.textMuted)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var pickerMenuContent: some View {
        if allowsProviderChange {
            ForEach(catalogs) { catalog in
                Menu {
                    modelMenuEntries(for: catalog)
                } label: {
                    providerMenuLabel(catalog)
                }
            }
        } else {
            modelMenuEntries(for: currentCatalog)
        }
    }

    @ViewBuilder
    private func modelMenuEntries(for catalog: ProviderModelCatalog?) -> some View {
        if let catalog {
            Button {
                selectDefault(in: catalog)
            } label: {
                checkedMenuLabel(
                    "Default",
                    selected: catalog.provider.lowercased() == provider.lowercased()
                        && modelId == nil)
            }
            ForEach(catalog.models) { option in
                Button {
                    selectModel(option, in: catalog)
                } label: {
                    checkedMenuLabel(
                        option.label ?? option.id,
                        selected: catalog.provider.lowercased() == provider.lowercased()
                            && modelId == option.id)
                }
            }
            if catalog.provider.lowercased() == provider.lowercased() {
                let options = twReasoningOptions(in: catalog, modelId: modelId)
                if !options.isEmpty {
                    Menu("Reasoning") {
                        ForEach(options) { option in
                            Button {
                                reasoningEffort = option.reasoningEffort
                            } label: {
                                checkedMenuLabel(
                                    twReasoningDisplayLabel(option.reasoningEffort),
                                    selected: reasoningEffort == option.reasoningEffort)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func providerMenuLabel(_ catalog: ProviderModelCatalog) -> some View {
        let selected = catalog.provider.lowercased() == provider.lowercased()
        if selected {
            Label(TWTheme.providerLabel(catalog.provider), systemImage: "checkmark")
        } else {
            Text(TWTheme.providerLabel(catalog.provider))
        }
    }

    @ViewBuilder
    private func checkedMenuLabel(_ title: String, selected: Bool) -> some View {
        if selected {
            Label(title, systemImage: "checkmark")
        } else {
            Text(title)
        }
    }

    private func selectDefault(in catalog: ProviderModelCatalog) {
        if allowsProviderChange {
            provider = catalog.provider
        }
        modelId = nil
        twNormalizeReasoningSelection(
            catalog: catalog, modelId: nil, reasoningEffort: &reasoningEffort)
    }

    private func selectModel(_ option: ModelOption, in catalog: ProviderModelCatalog) {
        if allowsProviderChange {
            provider = catalog.provider
        }
        modelId = option.id
        twNormalizeReasoningSelection(
            catalog: catalog, modelId: option.id, reasoningEffort: &reasoningEffort)
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
    let efforts = option.supportedReasoningEfforts?.map(\.reasoningEffort) ?? []
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
    let efforts = option?.supportedReasoningEfforts?.map(\.reasoningEffort) ?? []
    guard !efforts.isEmpty else {
        reasoningEffort = nil
        return
    }
    if let current = reasoningEffort, efforts.contains(current) { return }
    reasoningEffort = twDefaultReasoningEffort(for: option)
}

private func twReasoningDisplayLabel(_ effort: String) -> String {
    switch effort.lowercased() {
    case "off": return "Off"
    case "low": return "Low"
    case "medium": return "Medium"
    case "high": return "High"
    case "xhigh": return "Extra High"
    case "max": return "Max"
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
    @State private var expandedProvider: String?

    private var currentCatalog: ProviderModelCatalog? {
        catalogs.first { $0.provider.lowercased() == provider.lowercased() }
    }
    private var reasoningOptions: [ReasoningEffortOption] {
        twReasoningOptions(in: currentCatalog, modelId: modelId)
    }

    var body: some View {
        NavigationStack {
            List {
                if allowsProviderChange {
                    Section("Provider") {
                        ForEach(catalogs) { catalog in
                            providerTree(catalog)
                        }
                    }
                } else {
                    Section(TWTheme.providerLabel(provider)) {
                        defaultModelRow(for: currentCatalog)
                        ForEach(currentCatalog?.models ?? []) { option in
                            modelRow(option, catalog: currentCatalog)
                        }
                        ForEach(reasoningOptions) { option in
                            reasoningRow(option)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(TWTheme.appBg)
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmationTitle) {
                        onConfirm?()
                        dismiss()
                    }
                }
            }
            .onAppear {
                expandedProvider = provider.lowercased()
                normalizeReasoningSelection()
            }
            .onChange(of: provider) { _, newProvider in
                expandedProvider = newProvider.lowercased()
                normalizeReasoningSelection()
            }
            .onChange(of: modelId) { _, _ in normalizeReasoningSelection() }
        }
        #if os(iOS)
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        #endif
    }

    private func providerTree(_ catalog: ProviderModelCatalog) -> some View {
        let selected = catalog.provider.lowercased() == provider.lowercased()
        let accent = TWTheme.providerAccent(catalog.provider)
        return DisclosureGroup(
            isExpanded: Binding(
                get: { expandedProvider == catalog.provider.lowercased() },
                set: { expandedProvider = $0 ? catalog.provider.lowercased() : nil }
            )
        ) {
            defaultModelRow(for: catalog, indented: true)
            ForEach(catalog.models) { option in
                modelRow(option, catalog: catalog, indented: true)
            }
            if selected, !reasoningOptions.isEmpty {
                ForEach(reasoningOptions) { option in
                    reasoningRow(option, indented: true)
                }
            }
        } label: {
            HStack(spacing: 10) {
                Circle().fill(accent).frame(width: 8, height: 8)
                Text(TWTheme.providerLabel(catalog.provider))
                    .foregroundStyle(selected ? accent : TWTheme.textPrimary)
                    .fontWeight(selected ? .semibold : .regular)
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(accent)
                }
            }
            .contentShape(Rectangle())
        }
        .tint(accent)
    }

    private func defaultModelRow(
        for catalog: ProviderModelCatalog?, indented: Bool = false
    ) -> some View {
        let selected =
            catalog?.provider.lowercased() == provider.lowercased() && modelId == nil
        return Button {
            if let catalog, allowsProviderChange {
                provider = catalog.provider
            }
            modelId = nil
            normalizeReasoningSelection(catalog: catalog, selectedModelId: nil)
            let hasReasoning = !twReasoningOptions(in: catalog, modelId: nil).isEmpty
            if dismissesOnSelection && !hasReasoning { dismiss() }
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Default")
                        .foregroundStyle(TWTheme.textPrimary)
                    Text("Use the selected provider's default model")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TWTheme.providerAccent(catalog?.provider ?? provider))
                }
            }
            .padding(.leading, indented ? 18 : 0)
        }
        .buttonStyle(.plain)
    }

    private func modelRow(
        _ option: ModelOption, catalog: ProviderModelCatalog?, indented: Bool = false
    ) -> some View {
        let selected =
            catalog?.provider.lowercased() == provider.lowercased() && modelId == option.id
        return Button {
            if let catalog, allowsProviderChange {
                provider = catalog.provider
            }
            modelId = option.id
            normalizeReasoningSelection(catalog: catalog, selectedModelId: option.id)
            let hasReasoning = !(option.supportedReasoningEfforts ?? []).isEmpty
            if dismissesOnSelection && !hasReasoning { dismiss() }
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label ?? option.id)
                        .foregroundStyle(TWTheme.textPrimary)
                    if option.isDefault == true {
                        Text("Provider default")
                            .font(.caption)
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TWTheme.providerAccent(catalog?.provider ?? provider))
                }
            }
            .padding(.leading, indented ? 18 : 0)
        }
        .buttonStyle(.plain)
    }

    private func reasoningRow(
        _ option: ReasoningEffortOption, indented: Bool = false
    ) -> some View {
        let selected = reasoningEffort == option.reasoningEffort
        return Button {
            reasoningEffort = option.reasoningEffort
            if dismissesOnSelection { dismiss() }
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(twReasoningDisplayLabel(option.reasoningEffort))
                        .foregroundStyle(TWTheme.textPrimary)
                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(TWTheme.textSecondary)
                    }
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TWTheme.providerAccent(provider))
                }
            }
            .padding(.leading, indented ? 18 : 0)
        }
        .buttonStyle(.plain)
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
        case .monospaced: return .system(size: size, weight: weight, design: .monospaced)
        case .rounded: return .system(size: size, weight: weight, design: .rounded)
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

    public init(target: String, font: Font, color: Color, onRevealFrame: (() -> Void)? = nil) {
        self.target = target
        self.font = font
        self.color = color
        self.onRevealFrame = onRevealFrame
    }

    /// Roughly a line-and-a-half on phone transcript widths. Keep every band
    /// readable: this is a materialization tail, not placeholder shimmer.
    private static let tailBands: [(length: Int, opacity: Double)] = [
        (22, 0.62), (24, 0.74), (26, 0.88)
    ]
    private static let frameDelayNanos: UInt64 = 42_000_000
    private static let settleStep = 7
    private static let coldRevealSnapThreshold = 220

    public var body: some View {
        renderedText
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
            .onAppear {
                goal = target
                if reduceMotion || target.count > Self.coldRevealSnapThreshold {
                    revealed = target.count
                    solidified = revealed
                    onRevealFrame?()
                } else {
                    startPumpIfNeeded()
                }
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
        // Fade bands cover ONLY the not-yet-solidified tail (text that just
        // arrived); once the pump's settle phase catches `solidified` up to
        // `revealed`, everything renders solid.
        var tailBudget = max(0, revealed - solidified)
        var bands: [(text: String, opacity: Double)] = []
        var remaining = Substring(shown)
        for band in Self.tailBands.reversed() where !remaining.isEmpty && tailBudget > 0 {
            let take = min(band.length, remaining.count, tailBudget)
            bands.append((String(remaining.suffix(take)), band.opacity))
            remaining = remaining.dropLast(take)
            tailBudget -= take
        }
        var result = Text(String(remaining)).foregroundColor(color)
        for band in bands.reversed() {
            result = result + Text(band.text).foregroundColor(color.opacity(band.opacity))
        }
        return result
    }

    private func startPumpIfNeeded() {
        guard pump == nil, revealed < goal.count || solidified < revealed else { return }
        pump = Task { @MainActor in
            while !Task.isCancelled {
                let backlog = goal.count - revealed
                if backlog > 0 {
                    // Reveal phase: transport-paced near the frontier, capped
                    // catch-up for bursts so the materialization band spans the
                    // live flow without replaying huge chunks in one tick.
                    revealed += Self.revealStep(for: backlog)
                    if revealed > goal.count { revealed = goal.count }
                    // Keep the fade tail bounded while tokens flow.
                    let maxTail = Self.tailBands.reduce(0) { $0 + $1.length }
                    if solidified < revealed - maxTail { solidified = revealed - maxTail }
                } else if solidified < revealed {
                    // Settle phase: no new tokens — melt the tail to solid
                    // instead of freezing half-faded.
                    solidified = min(revealed, solidified + Self.settleStep)
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

    private static func revealStep(for backlog: Int) -> Int {
        min(24, max(2, backlog / 10))
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

    /// Downscale + JPEG-compress a picked image to fit the relay frame
    /// budget (~330KB binary per image; the Mac caps combined base64 at
    /// ~900KB for 2 images). Returns the wire dict for composerPrompt.
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
/// concat variant is also registered Mac-side, so inserting
/// "@RoleNoSpaces" always resolves).
public struct MentionCandidate: Identifiable {
    public let id: String
    public let insertText: String
    public let display: String
    public let provider: String?

    public init(id: String, insertText: String, display: String, provider: String?) {
        self.id = id
        self.insertText = insertText
        self.display = display
        self.provider = provider
    }
}

public func twMentionCandidates(
    participants: [RemoteEnsembleState.Participant]
) -> [MentionCandidate] {
    participants
        .sorted { ($0.order ?? 0) < ($1.order ?? 0) }
        .map { participant in
            let role = participant.role?.trimmingCharacters(in: .whitespaces) ?? ""
            let label = role.isEmpty ? TWTheme.providerLabel(participant.provider) : role
            let insert = "@" + label.replacingOccurrences(of: " ", with: "")
            return MentionCandidate(
                id: participant.participantId,
                insertText: insert,
                display: label,
                provider: participant.provider)
        }
}

/// Color known @mentions in a transcript preview with their participant's
/// provider accent. Conservative: only EXACT alias tokens are tinted.
@MainActor public func twColorizeMentions(
    _ text: String, participants: [RemoteEnsembleState.Participant]
) -> AttributedString {
    var attributed = AttributedString(text)
    guard !participants.isEmpty else { return attributed }
    var aliasAccent: [String: Color] = [:]
    for participant in participants {
        let accent = TWTheme.providerAccent(participant.provider)
        if let role = participant.role, !role.isEmpty {
            aliasAccent[role.lowercased()] = accent
            aliasAccent[role.replacingOccurrences(of: " ", with: "").lowercased()] = accent
        }
        if let provider = participant.provider {
            aliasAccent[provider.lowercased()] = accent
            aliasAccent[TWTheme.providerLabel(provider).lowercased()] = accent
        }
    }
    aliasAccent["user"] = TWTheme.chroma1

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

/// Monoline provider glyph — the sidebar's upgrade from the plain colored
/// dot. Loads a white-on-alpha template PNG from the app asset catalog or
/// package resources and tints it with the provider accent at runtime, so one
/// master serves every theme.
/// Ensembles and providers with a baked glyph use the monoline PNG;
/// providers without one (qwen, unknown) keep the original dot.
public struct ProviderGlyphIcon: View {
    let provider: String?
    let isEnsemble: Bool
    let size: CGFloat

    public init(provider: String?, isEnsemble: Bool = false, size: CGFloat = 16) {
        self.provider = provider
        self.isEnsemble = isEnsemble
        self.size = size
    }

    private static func glyphImage(for provider: String?) -> Image? {
        guard let provider = provider?.lowercased(), !provider.isEmpty else { return nil }
        #if canImport(UIKit)
            if let ui = UIImage(named: "provider-glyph-\(provider)") {
                return Image(uiImage: ui)
            }
            if let url = Bundle.module.url(
                forResource: "provider-glyph-\(provider)", withExtension: "png"),
                let data = try? Data(contentsOf: url),
                let ui = UIImage(data: data)
            {
                return Image(uiImage: ui)
            }
        #endif
        return nil
    }

    public var body: some View {
        if isEnsemble {
            if let glyph = Self.glyphImage(for: "ensemble") {
                glyph
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
                    .foregroundStyle(TWTheme.providerAccent("ensemble"))
            } else {
                Image(systemName: "star.fill")
                    .font(.system(size: size * 0.72, weight: .semibold))
                    .foregroundStyle(TWTheme.providerAccent("ensemble"))
                    .frame(width: size, height: size)
            }
        } else if let glyph = Self.glyphImage(for: provider) {
            glyph
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(TWTheme.providerAccent(provider))
        } else {
            Circle()
                .fill(TWTheme.providerAccent(provider))
                .frame(width: size * 0.44, height: size * 0.44)
                .frame(width: size, height: size)
        }
    }
}

public struct MarkdownLite: View {
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
        case code(lines: [String])
        case table(rows: [String])
        case quote(text: String)
        case paragraph(text: String)
        case divider
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbers: [String] = []
        var tableRows: [String] = []
        var codeLines: [String] = []
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
                out.append(.table(rows: tableRows))
                tableRows = []
            }
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flushParagraph()
                flushLists()
                if inFence {
                    out.append(.code(lines: codeLines))
                    codeLines = []
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
            if let heading = headingLevel(trimmed) {
                flushParagraph()
                flushLists()
                out.append(.heading(level: heading.level, text: heading.text))
                continue
            }
            if isThematicBreak(trimmed) {
                flushParagraph()
                flushLists()
                out.append(.divider)
                continue
            }
            if trimmed.hasPrefix("|") {
                flushParagraph()
                // Skip pure separator rows (|---|---|).
                let bare = trimmed.replacingOccurrences(of: "|", with: "")
                    .replacingOccurrences(of: "-", with: "")
                    .replacingOccurrences(of: ":", with: "")
                    .trimmingCharacters(in: .whitespaces)
                if !bare.isEmpty { tableRows.append(trimmed) }
                continue
            }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("• ") {
                flushParagraph()
                bullets.append(String(trimmed.dropFirst(2)))
                continue
            }
            if let numbered = numberedItem(trimmed) {
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
        if inFence, !codeLines.isEmpty { out.append(.code(lines: codeLines)) }
        flushParagraph()
        flushLists()
        return out
    }

    private func headingLevel(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        for character in line {
            if character == "#" { level += 1 } else { break }
        }
        guard level >= 1, level <= 6 else { return nil }
        let body = line.dropFirst(level).trimmingCharacters(in: .whitespaces)
        guard !body.isEmpty else { return nil }
        return (level, body)
    }

    private func numberedItem(_ line: String) -> String? {
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
    private func isThematicBreak(_ line: String) -> Bool {
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
                        inlineText(item).font(TWFont.transcript())
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
                        inlineText(item).font(TWFont.transcript())
                    }
                }
            }
        case .code(let lines):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(lines.joined(separator: "\n"))
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(TWTheme.textPrimary)
                    .padding(10)
            }
            .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TWTheme.border))
        case .table(let rows):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    Text(tableLine(row))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(index == 0 ? TWTheme.textPrimary : TWTheme.textSecondary)
                        .lineLimit(2)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TWTheme.surface2, in: RoundedRectangle(cornerRadius: 8))
        case .quote(let text):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1).fill(TWTheme.chroma1).frame(width: 3)
                inlineText(text)
                    .font(TWFont.transcript())
                    .foregroundStyle(TWTheme.textSecondary)
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

    /// Compact a `| a | b |` table row for the monospaced grid.
    private func tableLine(_ row: String) -> String {
        row.split(separator: "|", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .joined(separator: "  ·  ")
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
        // Style inline code runs.
        for run in attributed.runs
        where run.inlinePresentationIntent?.contains(.code) == true {
            attributed[run.range].font = .system(size: 14, design: .monospaced)
            attributed[run.range].foregroundColor = TWTheme.chroma3
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
    var aliasAccent: [String: Color] = [:]
    for participant in participants {
        let accent = TWTheme.providerAccent(participant.provider)
        if let role = participant.role, !role.isEmpty {
            aliasAccent[role.lowercased()] = accent
            aliasAccent[role.replacingOccurrences(of: " ", with: "").lowercased()] = accent
        }
        if let provider = participant.provider {
            aliasAccent[provider.lowercased()] = accent
            aliasAccent[TWTheme.providerLabel(provider).lowercased()] = accent
        }
    }
    aliasAccent["user"] = TWTheme.chroma1
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

/// Desktop ActivityStack parity: one card per tool call — tool-family icon,
/// name, touched file, per-edit +/− diff chips, status dot, result line.
public struct ToolActivityCards: View {
    let entries: [RemoteThreadSnapshot.Row.ToolEntry]
    let totalCount: Int
    let status: String?

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
                    toolName: entry.toolName ?? last.entry.toolName
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
                        Text("×\(count)")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(TWTheme.surface3, in: Capsule())
                            .foregroundStyle(TWTheme.textSecondary)
                            .contentTransition(.numericText(value: Double(count)))
                            .animation(.snappy(duration: 0.25), value: count)
                    }
                    if let file = entry.file {
                        Text(fileTail(file))
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(isEdit ? TWTheme.chroma1 : TWTheme.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    // Live edits tick like an odometer — numericText rolls
                    // the digits as the Mac re-projects growing ± totals.
                    // Desktop parity: when EITHER side is nonzero, BOTH
                    // chips render ("+1 −0"), zero included. fixedSize keeps
                    // the chips rigid so a long filename truncates instead
                    // of squeezing the counters.
                    let additions = entry.additions ?? 0
                    let deletions = entry.deletions ?? 0
                    if additions > 0 || deletions > 0 {
                        Text("+\(additions)")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.statusSuccess)
                            .contentTransition(.numericText(value: Double(additions)))
                            .animation(.snappy(duration: 0.25), value: additions)
                            .fixedSize()
                        Text("−\(deletions)")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.statusFailed)
                            .contentTransition(.numericText(value: Double(deletions)))
                            .animation(.snappy(duration: 0.25), value: deletions)
                            .fixedSize()
                    }
                    Spacer(minLength: 0)
                    Circle()
                        .fill(TWTheme.statusColor(entry.status))
                        .frame(width: 5, height: 5)
                }
                if let detail = entry.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                        .lineLimit(2)
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

    private func fileTail(_ path: String) -> String {
        let parts = path.split(separator: "/")
        return parts.suffix(2).joined(separator: "/")
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
    private let expandLabel: String?
    private let collapseLabel: String?
    private let content: Content
    @State private var contentHeight: CGFloat = 0
    @State private var expanded = false

    init(
        maxHeight: CGFloat = 172,
        fadeHeight: CGFloat = 34,
        expandLabel: String? = nil,
        collapseLabel: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.maxHeight = maxHeight
        self.fadeHeight = fadeHeight
        self.expandLabel = expandLabel
        self.collapseLabel = collapseLabel
        self.content = content()
    }

    private var shouldScroll: Bool {
        contentHeight > maxHeight + 8
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            viewport
            if shouldScroll, let expandLabel {
                Button {
                    withAnimation(.easeInOut(duration: 0.16)) {
                        expanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(expanded ? (collapseLabel ?? "Collapse") : expandLabel)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(TWTheme.surface3, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? (collapseLabel ?? "Collapse") : expandLabel)
            }
        }
        .onPreferenceChange(ToolActivityViewportHeightKey.self) { height in
            guard abs(contentHeight - height) > 1 else { return }
            contentHeight = height
        }
    }

    @ViewBuilder
    private var viewport: some View {
        if shouldScroll && !expanded {
            ScrollView(.vertical, showsIndicators: false) {
                measuredContent
            }
            .frame(height: maxHeight)
            .mask(edgeFadeMask)
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
    @State private var tab = 0

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

    public var body: some View {
        VStack(spacing: 0) {
            Picker("Inspector", selection: $tab) {
                Text("Changes").tag(0)
                Text("Agents").tag(1)
                Text("Side chats").tag(3)
                Text("Notes").tag(2)
                Text("Usage").tag(4)
            }
            .pickerStyle(.segmented)
            .padding(12)
            if tab == 3 {
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
                            // tier (gitSnapshot); mutations additionally gate
                            // on fileWrite inside the panel. Hidden in demo —
                            // stage/commit/push has no offline equivalent (the
                            // diff pill + Diff Studio still work from canned data).
                            if !model.isDemo,
                                let workspaceId = model.taskCards.first(where: { $0.id == threadId })?
                                    .workspaceId,
                                model.workspaceCanReviewDiffs(workspaceId)
                            {
                                GitWorkflowPanel(model: model, workspaceId: workspaceId)
                            }
                        } else if tab == 4 {
                            UsagePanel(model: model, threadId: threadId)
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
        tab = 3
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
                            .foregroundStyle(TWTheme.statusSuccess)
                    }
                    if let deletions = diff.deletions, deletions > 0 {
                        Text("−\(deletions)")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(TWTheme.statusFailed)
                    }
                    Spacer()
                }
                HStack(spacing: 8) {
                    statChip("Created", diff.createdFiles, TWTheme.statusSuccess)
                    statChip("Edited", diff.modifiedFiles, TWTheme.chroma1)
                    statChip("Deleted", diff.deletedFiles, TWTheme.statusFailed)
                    Spacer()
                }
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(files) { file in
                        fileRow(file)
                    }
                }
                if diff.truncated == true {
                    Text("More changes on your Mac — open Review changes there for the full diff.")
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
                        .foregroundStyle(TWTheme.statusSuccess)
                }
                if let deletions = file.deletions, deletions > 0 {
                    Text("−\(deletions)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(TWTheme.statusFailed)
                }
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 8))
    }

    private func statusColor(_ status: String?) -> Color {
        switch status {
        case "created", "added": return TWTheme.statusSuccess
        case "deleted", "removed": return TWTheme.statusFailed
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
                        .foregroundStyle(TWTheme.statusSuccess)
                }
                if let deletions = diff.deletions, deletions > 0 {
                    Text("−\(deletions)")
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(TWTheme.statusFailed)
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
public struct TelemetryFooterRail: View {
    let run: RemoteThreadSnapshot.RunSummary?
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
    @State private var compactTelemetryShowsCost = false
    @State private var railWidth: CGFloat = 0

    public init(
        run: RemoteThreadSnapshot.RunSummary?, workspaceName: String?,
        workspaceOptions: [(id: String, name: String)] = [],
        primaryWorkspaceId: String? = nil,
        secondaryWorkspaceId: Binding<String?>? = nil,
        onPrimaryWorkspaceSelect: ((String) -> Void)? = nil,
        activeGoal: RemoteActiveGoal? = nil,
        onGoalUpdate: ((String, String?, String?) -> Void)? = nil,
        planLanes: [RemoteTodoLane] = []
    ) {
        self.run = run
        self.workspaceName = workspaceName
        self.activeGoal = activeGoal
        self.onGoalUpdate = onGoalUpdate
        self.planLanes = planLanes
        self.workspaceOptions = workspaceOptions
        self.primaryWorkspaceId = primaryWorkspaceId
        self.secondaryWorkspaceId = secondaryWorkspaceId
        self.onPrimaryWorkspaceSelect = onPrimaryWorkspaceSelect
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
        guard let cost = run?.costText?.trimmingCharacters(in: .whitespacesAndNewlines),
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
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
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
                .background(TWTheme.surface2)
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
                            onUpdate("block", nil, reason.isEmpty ? "Blocked from iPhone." : reason)
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
                .background(TWTheme.surface2)
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

public struct EditableRosterStrip: View {
    @ObservedObject var model: RemoteSessionModel
    let threadId: String
    let workspaceId: String

    @State private var draft: [RemoteSessionModel.RosterDraftEntry] = []
    @State private var editingEntry: RemoteSessionModel.RosterDraftEntry? = nil
    @State private var draggingId: String? = nil
    /// Id-order we last committed; suppress reconcile until the Mac echoes a
    /// matching order so an in-flight snapshot can't snap a reorder back.
    @State private var pendingOrderIds: [String]? = nil

    public init(
        model: RemoteSessionModel, threadId: String, workspaceId: String,
        attached: Bool = false, isShellTop: Bool = false, onOwnCard: Bool = false
    ) {
        self.model = model
        self.threadId = threadId
        self.workspaceId = workspaceId
        self.attached = attached
        self.isShellTop = isShellTop
        self.onOwnCard = onOwnCard
    }

    private var state: RemoteEnsembleState? { model.ensembleStates[threadId] }

    private var catalogs: [ProviderModelCatalog] {
        model.providerModels
            .map { ProviderModelCatalog(provider: $0.key, models: $0.value) }
            .filter { !TWTheme.isRetiredProvider($0.provider) }
            .sorted { TWTheme.providerLabel($0.provider) < TWTheme.providerLabel($1.provider) }
    }

    private var remoteRoster: [RemoteSessionModel.RosterDraftEntry] {
        (state?.roster ?? [])
            .sorted { ($0.order ?? 0) < ($1.order ?? 0) }
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
                    thinkingEnabled: entry.thinkingEnabled ?? false
                )
            }
    }

    /// Round status per participant id (active speaker ring, status dot).
    private func roundStatus(for id: String) -> String? {
        state?.participants?.first { $0.participantId == id }?.status
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
        .onAppear { if draft.isEmpty { draft = remoteRoster } }
        .onChange(of: remoteRoster) { _, fresh in
            // Reconcile from the Mac unless mid-edit (popover open / drag).
            guard editingEntry == nil, draggingId == nil else { return }
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
        // Present from a stable @State entry, NOT a binding re-derived from
        // `draft` every render — that computed binding collapsed to nil on the
        // keyboard-driven re-render when the role field was focused, dismissing
        // the sheet. @State survives parent re-renders.
        .sheet(item: $editingEntry) { entry in
            RosterChipEditor(
                entry: entry,
                catalogs: catalogs,
                canRemove: draft.count > 1,
                onApply: { updated in
                    if let index = draft.firstIndex(where: { $0.id == updated.id }) {
                        draft[index] = updated
                    }
                    editingEntry = nil
                    commit()
                },
                onMove: { direction in
                    guard let index = draft.firstIndex(where: { $0.id == entry.id }) else {
                        return
                    }
                    let target = index + direction
                    guard target >= 0, target < draft.count else { return }
                    draft.swapAt(index, target)
                    commit()
                },
                onRemove: {
                    draft.removeAll { $0.id == entry.id }
                    editingEntry = nil
                    commit()
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private func chip(_ entry: RemoteSessionModel.RosterDraftEntry) -> some View {
        let retired = TWTheme.isRetiredProvider(entry.provider)
        let accent = retired ? TWTheme.textMuted : TWTheme.providerAccent(entry.provider)
        let status = roundStatus(for: entry.id)
        let isActive = !retired && (status == "running" || state?.activeParticipantId == entry.id)
        let live = entry.enabled && !retired
        let fillOpacity: Double = live ? 0.12 : 0.04
        let strokeColor: Color =
            isActive ? accent : accent.opacity(live ? 0.35 : 0.15)
        let strokeWidth: CGFloat = isActive ? 1.5 : 1
        let labelColor: Color = live ? accent : TWTheme.textMuted
        let dotColor: Color = live ? accent : TWTheme.textMuted
        let title =
            entry.role.isEmpty ? TWTheme.providerLabel(entry.provider) : entry.role
        return Button {
            editingEntry = entry
        } label: {
            HStack(spacing: 5) {
                if retired {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(TWTheme.textMuted)
                } else {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 6, height: 6)
                }
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(labelColor)
                    .lineLimit(1)
                    .strikethrough(retired, color: TWTheme.textMuted)
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
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(accent.opacity(fillOpacity), in: Capsule())
            .overlay(Capsule().strokeBorder(strokeColor, lineWidth: strokeWidth))
            .opacity(draggingId == entry.id ? 0.4 : 1)
        }
        .buttonStyle(.plain)
    }

    private var addMenu: some View {
        Menu {
            ForEach(catalogs.map(\.provider), id: \.self) { provider in
                Button {
                    draft.append(
                        RemoteSessionModel.RosterDraftEntry(
                            id: "draft-\(UUID().uuidString.prefix(8))",
                            provider: provider,
                            model: nil,
                            role: TWTheme.providerLabel(provider),
                            brief: "",
                            enabled: true
                        ))
                    commit()
                } label: {
                    Label(TWTheme.providerLabel(provider), systemImage: "cpu")
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.caption.weight(.semibold))
                .foregroundStyle(TWTheme.textSecondary)
                .frame(width: 24, height: 24)
                .background(TWTheme.surface3, in: Circle())
        }
    }

    private func commit() {
        guard !draft.isEmpty else { return }
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

/// Per-chip editor — enable, role, goal/brief, provider/model, move, remove.
struct RosterChipEditor: View {
    @State var entry: RemoteSessionModel.RosterDraftEntry
    let catalogs: [ProviderModelCatalog]
    let canRemove: Bool
    let onApply: (RemoteSessionModel.RosterDraftEntry) -> Void
    let onMove: (Int) -> Void
    let onRemove: () -> Void
    @Environment(\.dismiss) private var dismiss

    private var participantCatalog: ProviderModelCatalog? {
        catalogs.first { $0.provider.lowercased() == entry.provider.lowercased() }
    }
    private var reasoningEfforts: [String] {
        twReasoningModelOption(in: participantCatalog, modelId: entry.model)?
            .supportedReasoningEfforts?.map(\.reasoningEffort) ?? []
    }
    private var permissionBinding: Binding<String> {
        Binding(
            get: { entry.permissionPresetId ?? "default" },
            set: { entry.permissionPresetId = $0 }
        )
    }
    private var reasoningBinding: Binding<String> {
        Binding(
            get: { entry.reasoningEffort ?? reasoningEfforts.first ?? "medium" },
            set: { entry.reasoningEffort = $0 }
        )
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Enabled in ensemble rounds", isOn: $entry.enabled)
                        .tint(TWTheme.providerAccent(entry.provider))
                }
                Section("Role") {
                    TextField("Role name", text: $entry.role)
                }
                Section("Goal / brief") {
                    TextEditor(text: $entry.brief)
                        .frame(minHeight: 88)
                        .font(.footnote)
                }
                Section("Provider · model") {
                    Menu {
                        ForEach(catalogs.map(\.provider), id: \.self) { provider in
                            Button(TWTheme.providerLabel(provider)) {
                                entry.provider = provider
                                entry.model = nil
                                entry.reasoningEffort = nil
                            }
                        }
                    } label: {
                        HStack {
                            Circle()
                                .fill(TWTheme.providerAccent(entry.provider))
                                .frame(width: 7, height: 7)
                            Text(TWTheme.providerLabel(entry.provider))
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                    }
                    Menu {
                        Button("CLI Default") { entry.model = nil }
                        ForEach(
                            catalogs.first {
                                $0.provider.lowercased() == entry.provider.lowercased()
                            }?.models ?? []
                        ) { modelOption in
                            Button(modelOption.label ?? modelOption.id) {
                                entry.model = modelOption.id
                            }
                        }
                    } label: {
                        HStack {
                            Text(entry.model ?? "CLI Default")
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                    }
                }
                Section("Permission") {
                    Picker("Approval", selection: permissionBinding) {
                        Text("Plan / Read-only").tag("read_only")
                        Text("Default approval").tag("default")
                        Text("Full workspace").tag("workspace_write")
                    }
                    .pickerStyle(.menu)
                }
                if entry.provider.lowercased() == "kimi" {
                    Section("Reasoning") {
                        Toggle("Extended thinking", isOn: $entry.thinkingEnabled)
                            .tint(TWTheme.providerAccent(entry.provider))
                    }
                } else if !reasoningEfforts.isEmpty {
                    Section("Reasoning") {
                        Picker("Effort", selection: reasoningBinding) {
                            ForEach(reasoningEfforts, id: \.self) { effort in
                                Text(twReasoningDisplayLabel(effort)).tag(effort)
                            }
                        }
                        .pickerStyle(.menu)
                        if entry.provider.lowercased() == "codex"
                            || entry.provider.lowercased() == "claude"
                        {
                            Toggle("Fast mode", isOn: $entry.fastModeEnabled)
                                .tint(TWTheme.providerAccent(entry.provider))
                        }
                    }
                }
                Section {
                    HStack {
                        Button {
                            onMove(-1)
                        } label: {
                            Label("Earlier", systemImage: "arrow.left")
                        }
                        Spacer()
                        Button {
                            onMove(1)
                        } label: {
                            Label("Later", systemImage: "arrow.right")
                        }
                    }
                    if canRemove {
                        Button(role: .destructive) {
                            onRemove()
                            dismiss()
                        } label: {
                            Label("Remove participant", systemImage: "trash")
                        }
                    }
                }
            }
            .navigationTitle(
                entry.role.isEmpty ? TWTheme.providerLabel(entry.provider) : entry.role
            )
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        onApply(entry)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .twColorScheme()
    }
}

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
    private static func catalogImage(for slug: String?) -> Image? {
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

/// App settings — theme controls land here next pass (mirroring the
/// desktop's theme system where sensible; composer theming deferred).
public struct AppSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var themes = TWThemeStore.shared

    public init() {}

    public var body: some View {
        NavigationStack {
            Form {
                Section("Themes") {
                    Picker(
                        selection: Binding(
                            get: { themes.systemTheme },
                            set: { themes.systemTheme = $0 }
                        )
                    ) {
                        ForEach(TWSystemTheme.allCases) { theme in
                            HStack {
                                Circle().fill(theme.surface3).frame(width: 12, height: 12)
                                Text(theme.label)
                            }
                            .tag(theme)
                        }
                    } label: {
                        Label("System Theme", systemImage: "circle.lefthalf.filled")
                    }
                    Picker(
                        selection: Binding(
                            get: { themes.accentTheme },
                            set: { themes.accentTheme = $0 }
                        )
                    ) {
                        ForEach(TWAccentTheme.allCases) { accent in
                            HStack {
                                Circle().fill(accent.color).frame(width: 12, height: 12)
                                Text(accent.label)
                            }
                            .tag(accent)
                        }
                    } label: {
                        Label("Accent Theme", systemImage: "paintpalette")
                    }
                    Picker(
                        selection: Binding(
                            get: { themes.toolTheme },
                            set: { themes.toolTheme = $0 }
                        )
                    ) {
                        ForEach(TWToolTheme.allCases) { tool in
                            Text(tool.label).tag(tool)
                        }
                    } label: {
                        Label("Tool Call Theme", systemImage: "wrench.and.screwdriver")
                    }
                    Text("Mirrors your Mac's Appearance settings where sensible.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textMuted)
                }
                Section("Composer Shell") {
                    Picker(
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
                    } label: {
                        Label("Style", systemImage: "rectangle.and.pencil.and.ellipsis")
                    }
                    Text(
                        "Follow Mac mirrors your desktop composer style. Override to pin a style on this device."
                    )
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                }
                Section("Transcript") {
                    Picker(
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
                    } label: {
                        Label("Response Font", systemImage: "textformat")
                    }
                    Text("Typeface for assistant response text in the transcript.")
                        .font(.caption)
                        .foregroundStyle(TWTheme.textMuted)
                }
                Section("About") {
                    LabeledContent("App", value: "TaskWraith Remote")
                    LabeledContent("Transport", value: "taskwraith-e2ee-v1")
                }
            }
            .navigationTitle("Settings")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .twColorScheme()
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
                    HStack(alignment: .top, spacing: 7) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 9))
                            .foregroundStyle(TWTheme.statusAttention)
                            .padding(.top, 3)
                        VStack(alignment: .leading, spacing: 2) {
                            if let speaker = row.speaker {
                                Text(speaker)
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(TWTheme.textTertiary)
                            }
                            Text(row.preview ?? "")
                                .font(.caption)
                                .foregroundStyle(TWTheme.textPrimary)
                                .lineLimit(4)
                        }
                        Spacer(minLength: 4)
                        Button {
                            if let card {
                                model.toggleMessagePin(
                                    card, messageId: row.id, pinned: false)
                            }
                        } label: {
                            Image(systemName: "pin.slash")
                                .font(.caption2)
                                .foregroundStyle(TWTheme.textMuted)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 10))
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
        return "The run couldn't start — check the provider's setup on your Mac."
    }
    return raw
}

public struct StatusBanner: View {
    let message: String
    let onDismiss: () -> Void

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
        .transition(.move(edge: .top).combined(with: .opacity))
        .task(id: message) {
            // Non-error feedback fades on its own; errors stay until read.
            let sev = severity
            if sev == .success || sev == .info {
                try? await Task.sleep(nanoseconds: 3_500_000_000)
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
    public enum State {
        case reconnecting(detail: String?)
        case offline(detail: String?)
    }

    let state: State
    let onRetry: () -> Void

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
                Text("Reconnecting to your Mac…")
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
        .transition(.move(edge: .top).combined(with: .opacity))
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
                actionButton
            }
            if let canWrite {
                Image(systemName: canWrite ? "pencil" : "lock")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(canWrite ? TWTheme.chroma1 : TWTheme.textTertiary)
                    .frame(width: 18, height: 18)
                    .accessibilityLabel(canWrite ? "Write access" : "Read-only access")
            }
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

    private var actionButton: some View {
        Button(action: action) {
            Text(actionLabel)
                .font(.caption.weight(.medium))
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(TWTheme.surface3, in: Capsule())
        }
        .buttonStyle(.plain)
        .layoutPriority(2)
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
            Image(systemName: "tray.and.arrow.down")
                .font(.caption2)
                .foregroundStyle(TWTheme.providerAccent(prompt.provider))
            Text(prompt.text)
                .font(.caption)
                .foregroundStyle(TWTheme.textSecondary)
                .lineLimit(2)
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
}

/// Guest participant control for solo composers: + opens the full provider /
/// model picker; an active guest renders as a green-accent chip
/// — tap to change provider/model, × to remove. One guest per thread
/// (desktop set/remove semantics).
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

    public init(
        filesChanged: Int, additions: Int, deletions: Int, commitsAhead: Int = 0,
        onTap: (() -> Void)? = nil
    ) {
        self.filesChanged = filesChanged
        self.additions = additions
        self.deletions = deletions
        self.commitsAhead = max(0, commitsAhead)
        self.onTap = onTap
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

    public var body: some View {
        Button { onTap?() } label: {
            HStack(spacing: 8) {
                if commitsAhead > 0 {
                    Text("↑ \(compact(commitsAhead))")
                        .foregroundStyle(TWTheme.statusAttention)
                }
                if hasFileStats {
                    Text("\(filesChanged) file\(filesChanged == 1 ? "" : "s")")
                        .foregroundStyle(TWTheme.textSecondary)
                    Text("+\(compact(additions))")
                        .foregroundStyle(TWTheme.statusSuccess)
                    Text("−\(compact(deletions))")
                        .foregroundStyle(TWTheme.statusFailed)
                }
            }
            .font(.caption.weight(.semibold).monospacedDigit())
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            // Liquid Glass where the OS has it; ultra-thin material capsule below.
            .modifier(GlassPillBackground())
            // Rim highlight: a bright top-edge specular fading down, so the pill
            // reads as a floating glass chip above the composer.
            .overlay(
                Capsule().strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(0.34), Color.white.opacity(0.06)],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.28), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            accessibilityText)
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

public struct GuestParticipantControl: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard

    public init(model: RemoteSessionModel, card: RemoteTaskCard) {
        self.model = model
        self.card = card
    }

    private var guest: RemoteTaskCard? {
        card.threadId.flatMap { model.guestParticipant(of: $0) }
    }

    private var catalogs: [ProviderModelCatalog] {
        model.providerModels
            .map { ProviderModelCatalog(provider: $0.key, models: $0.value) }
            .filter { !TWTheme.isRetiredProvider($0.provider) }
            .sorted { TWTheme.providerLabel($0.provider) < TWTheme.providerLabel($1.provider) }
    }

    private let guestAccent = Color(hex: 0x35C284)

    public var body: some View {
        Group {
            if let guest {
                HStack(spacing: 4) {
                    Menu {
                        guestPickerEntries
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "person.crop.circle.badge.plus")
                                .font(.system(size: 10))
                            Text(guestLabel(guest))
                                .font(.caption2.weight(.semibold))
                                .lineLimit(1)
                        }
                        .foregroundStyle(guestAccent)
                    }
                    .buttonStyle(.plain)
                    Button {
                        model.removeGuestParticipant(card)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(TWTheme.textMuted)
                            // An 8pt glyph with no frame gave a ~8×8pt tap target
                            // (far below the 44pt minimum), so taps missed and the
                            // guest never got removed. Give it real hit area.
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove guest")
                }
                .padding(.leading, 7)
                .padding(.trailing, 1)
                .padding(.vertical, 3)
                .background(guestAccent.opacity(0.12), in: Capsule())
                .overlay(Capsule().strokeBorder(guestAccent.opacity(0.4)))
            } else {
                Menu {
                    guestPickerEntries
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(TWTheme.textTertiary)
                        .frame(width: 20, height: 20)
                        .background(TWTheme.surface3, in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var guestPickerEntries: some View {
        ForEach(catalogs) { catalog in
            Menu {
                guestDefaultEntry(for: catalog)
                ForEach(catalog.models) { option in
                    guestModelEntry(option, catalog: catalog)
                }
            } label: {
                if guest?.provider?.lowercased() == catalog.provider.lowercased() {
                    Label(TWTheme.providerLabel(catalog.provider), systemImage: "checkmark")
                } else {
                    Text(TWTheme.providerLabel(catalog.provider))
                }
            }
        }
        // A reliable removal path from the provider/model picker itself — the
        // tiny inline X is easy to miss. Only meaningful once a guest exists.
        if guest != nil {
            Divider()
            Button(role: .destructive) {
                model.removeGuestParticipant(card)
            } label: {
                Label("Remove guest", systemImage: "person.crop.circle.badge.minus")
            }
        }
    }

    @ViewBuilder
    private func guestDefaultEntry(for catalog: ProviderModelCatalog) -> some View {
        let option = twReasoningModelOption(in: catalog, modelId: nil)
        let reasoning = option?.supportedReasoningEfforts ?? []
        if reasoning.isEmpty {
            Button("Default") {
                model.setGuestParticipant(
                    card, provider: catalog.provider, model: nil, reasoningEffort: nil)
            }
        } else {
            Menu("Default") {
                Button("Default reasoning") {
                    model.setGuestParticipant(
                        card, provider: catalog.provider, model: nil, reasoningEffort: nil)
                }
                ForEach(reasoning) { effort in
                    Button(twReasoningDisplayLabel(effort.reasoningEffort)) {
                        model.setGuestParticipant(
                            card, provider: catalog.provider, model: nil,
                            reasoningEffort: effort.reasoningEffort)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func guestModelEntry(_ option: ModelOption, catalog: ProviderModelCatalog) -> some View {
        let reasoning = option.supportedReasoningEfforts ?? []
        if reasoning.isEmpty {
            Button(option.label ?? option.id) {
                model.setGuestParticipant(
                    card, provider: catalog.provider, model: option.id, reasoningEffort: nil)
            }
        } else {
            Menu(option.label ?? option.id) {
                Button("Default reasoning") {
                    model.setGuestParticipant(
                        card, provider: catalog.provider, model: option.id,
                        reasoningEffort: nil)
                }
                ForEach(reasoning) { effort in
                    Button(twReasoningDisplayLabel(effort.reasoningEffort)) {
                        model.setGuestParticipant(
                            card, provider: catalog.provider, model: option.id,
                            reasoningEffort: effort.reasoningEffort)
                    }
                }
            }
        }
    }

    private func guestLabel(_ guest: RemoteTaskCard) -> String {
        if let name = guest.agentName { return name }
        return TWTheme.providerLabel(guest.provider)
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
        // Isolated side chats only — a guest participant (sideChatMode
        // "guestParticipant") is a MAIN-transcript peer whose replies mirror
        // inline, not an isolated sidecar, so it belongs to the composer guest
        // control, not this tab.
        model.taskCards.filter {
            $0.parentChatId == threadId && $0.isIsolatedSideChat
        }
    }

    private var catalogs: [ProviderModelCatalog] {
        model.providerModels
            .map { ProviderModelCatalog(provider: $0.key, models: $0.value) }
            .filter { !TWTheme.isRetiredProvider($0.provider) }
            .sorted { TWTheme.providerLabel($0.provider) < TWTheme.providerLabel($1.provider) }
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
                        model: createModelId ?? "default",
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
struct MiniThreadView: View {
    @ObservedObject var model: RemoteSessionModel
    let card: RemoteTaskCard
    var onBack: () -> Void
    var onExpand: () -> Void
    @State private var draft = ""
    @State private var composerOverlayHeight: CGFloat = 150

    private var threadId: String { card.id }
    private var snapshot: RemoteThreadSnapshot? { model.threadSnapshots[threadId] }
    private var transcriptBottomInset: CGFloat { composerOverlayHeight + 12 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            transcriptStage
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onPreferenceChange(MiniThreadComposerHeightKey.self) { height in
            guard height > 0 else { return }
            guard abs(composerOverlayHeight - height) > 1 else { return }
            composerOverlayHeight = height
        }
        .task(id: threadId) {
            model.requestThreadSnapshot(threadId)
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

    private var transcriptStage: some View {
        ZStack(alignment: .bottom) {
            transcriptArea
            composerOverlay
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var transcriptArea: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                transcriptContent
                Color.clear
                    .frame(height: transcriptBottomInset)
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
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
                HydrationTicker("Loading side chat from your Mac…")
            }
        } else {
            LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(rows, id: \.id) { row in
                    ThreadRowView(
                        model: model, threadId: threadId,
                        row: model.resolvedRow(row, threadId: threadId),
                        threadProvider: card.provider,
                        agentIdentity: ThreadAgentIdentity(card: card))
                }
            }
        }
        if let live = model.streamingTexts[threadId], !live.isEmpty {
            StreamingRowView(
                text: live, provider: card.provider,
                model: snapshot?.runSummary?.model,
                agentIdentity: ThreadAgentIdentity(card: card))
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
            Rectangle().fill(TWTheme.border).frame(height: 1)
            TelemetryFooterRail(
                run: snapshot?.runSummary,
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

    private static let providerOrder = ["gemini", "codex", "claude", "kimi", "cursor", "grok"]

    private var providers: [ModelUsageMessage.ProviderUsage] {
        let entries = (model.modelUsage?.providers ?? [])
            .filter { !TWTheme.isRetiredProvider($0.provider) }
        return entries.sorted {
            (Self.providerOrder.firstIndex(of: $0.provider) ?? 99)
                < (Self.providerOrder.firstIndex(of: $1.provider) ?? 99)
        }
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
            if providers.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "gauge.with.dots.needle.50percent")
                        .font(.title2)
                        .foregroundStyle(TWTheme.textTertiary)
                    Text("Usage data arrives from your Mac within a few minutes of connecting.")
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
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(accent.opacity(0.18))
                    .frame(width: 20, height: 20)
                    .overlay(
                        Image(systemName: "cpu")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(accent)
                    )
                Text(TWTheme.providerLabel(entry.provider))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textPrimary)
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
                Text("\(window.usedPercent)%")
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
