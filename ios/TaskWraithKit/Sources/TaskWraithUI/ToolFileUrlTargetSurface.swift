// Extracted SwiftUI surface for tool file/URL targets.
//
// Presentation-only: Open / Reveal / Copy / Inspect fire host-supplied
// callbacks. No bridge open, Finder reveal, or pasteboard side effects live
// here — integrators (@CodexBoss) wire those when composing ToolActivityCards.
//
// Desktop mirrors: TranscriptFileTarget hover card + ToolUrlBadge sources.

import SwiftUI

// MARK: - Inline chips

/// Monospaced clickable file path chip. Primary tap = Open; long-press or
/// inspect control expands the action strip when callbacks are present.
struct ToolFileTargetChip: View {
    let target: ToolFilePresentationTarget
    var isEditAccent: Bool = false
    var onOpen: ((ToolFilePresentationTarget) -> Void)?
    var onReveal: ((ToolFilePresentationTarget) -> Void)?
    var onCopyPath: ((ToolFilePresentationTarget) -> Void)?
    var onInspect: ((ToolFilePresentationTarget) -> Void)?

    @State private var showInspect = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if let onOpen {
                    onOpen(target)
                } else if onInspect != nil || onReveal != nil || onCopyPath != nil {
                    showInspect.toggle()
                }
            } label: {
                Text(target.displayLabel)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(isEditAccent ? TWTheme.chroma1 : TWTheme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ToolFileUrlTargetModel.accessibilityLabel(forFile: target))
            .accessibilityHint(target.displayPath)
            .help(target.absolutePath)

            if showInspect {
                ToolFileTargetInspectStrip(
                    target: target,
                    onOpen: onOpen,
                    onReveal: onReveal,
                    onCopyPath: onCopyPath,
                    onInspect: onInspect
                )
            }
        }
    }
}

/// Compact host badge for a normalized HTTP(S) target (desktop ToolUrlBadge).
struct ToolUrlTargetChip: View {
    let target: ToolUrlPresentationTarget
    var compact: Bool = true
    var onOpen: ((ToolUrlPresentationTarget) -> Void)?
    var onCopy: ((ToolUrlPresentationTarget) -> Void)?
    var onInspect: ((ToolUrlPresentationTarget) -> Void)?

    @State private var showInspect = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                if let onOpen {
                    onOpen(target)
                } else {
                    showInspect.toggle()
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "link")
                        .font(.system(size: compact ? 9 : 11, weight: .semibold))
                        .foregroundStyle(TWTheme.chroma1)
                    Text(target.host)
                        .font(compact ? .caption2.weight(.semibold) : .caption.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                        .lineLimit(1)
                }
                .padding(.horizontal, compact ? 6 : 8)
                .padding(.vertical, compact ? 2 : 4)
                .background(TWTheme.surface2, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ToolFileUrlTargetModel.accessibilityLabel(forUrl: target))
            .accessibilityHint(target.url)
            .help(target.url)

            if showInspect {
                ToolUrlTargetInspectStrip(
                    target: target,
                    onOpen: onOpen,
                    onCopy: onCopy,
                    onInspect: onInspect
                )
            }
        }
    }
}

// MARK: - Inspect strips

/// Desktop TranscriptFileTarget card actions — callbacks only.
struct ToolFileTargetInspectStrip: View {
    let target: ToolFilePresentationTarget
    var onOpen: ((ToolFilePresentationTarget) -> Void)?
    var onReveal: ((ToolFilePresentationTarget) -> Void)?
    var onCopyPath: ((ToolFilePresentationTarget) -> Void)?
    var onInspect: ((ToolFilePresentationTarget) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(target.absolutePath)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TWTheme.textTertiary)
                .lineLimit(3)
                .textSelection(.enabled)

            HStack(spacing: 6) {
                if onOpen != nil,
                    ToolFileUrlTargetModel.canPerform(.open, onFile: target)
                {
                    actionButton(.open) { onOpen?(target) }
                }
                if onReveal != nil,
                    ToolFileUrlTargetModel.canPerform(.reveal, onFile: target)
                {
                    actionButton(.reveal) { onReveal?(target) }
                }
                if onCopyPath != nil,
                    ToolFileUrlTargetModel.canPerform(.copyPath, onFile: target)
                {
                    actionButton(.copyPath) { onCopyPath?(target) }
                }
                if onInspect != nil,
                    ToolFileUrlTargetModel.canPerform(.inspect, onFile: target)
                {
                    actionButton(.inspect) { onInspect?(target) }
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("File actions for \(target.displayLabel)")
    }

    private func actionButton(
        _ action: ToolTargetInspectAction,
        run: @escaping () -> Void
    ) -> some View {
        Button(action: run) {
            Label(
                ToolFileUrlTargetModel.actionTitle(action),
                systemImage: ToolFileUrlTargetModel.actionSystemImage(action)
            )
            .font(.caption2.weight(.semibold))
            .foregroundStyle(action == .open ? TWTheme.chroma1 : TWTheme.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(TWTheme.surface2, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            ToolFileUrlTargetModel.accessibilityLabel(for: action, file: target)
        )
    }
}

struct ToolUrlTargetInspectStrip: View {
    let target: ToolUrlPresentationTarget
    var onOpen: ((ToolUrlPresentationTarget) -> Void)?
    var onCopy: ((ToolUrlPresentationTarget) -> Void)?
    var onInspect: ((ToolUrlPresentationTarget) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(target.url)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TWTheme.textTertiary)
                .lineLimit(3)
                .textSelection(.enabled)

            HStack(spacing: 6) {
                if onOpen != nil,
                    ToolFileUrlTargetModel.canPerform(.open, onUrl: target)
                {
                    actionButton(.open) { onOpen?(target) }
                }
                if onCopy != nil,
                    ToolFileUrlTargetModel.canPerform(.copyPath, onUrl: target)
                {
                    actionButton(.copyPath) { onCopy?(target) }
                }
                if onInspect != nil,
                    ToolFileUrlTargetModel.canPerform(.inspect, onUrl: target)
                {
                    actionButton(.inspect) { onInspect?(target) }
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TWTheme.surface1, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Link actions for \(target.host)")
    }

    private func actionButton(
        _ action: ToolTargetInspectAction,
        run: @escaping () -> Void
    ) -> some View {
        Button(action: run) {
            Label(
                ToolFileUrlTargetModel.actionTitle(action),
                systemImage: ToolFileUrlTargetModel.actionSystemImage(action)
            )
            .font(.caption2.weight(.semibold))
            .foregroundStyle(action == .open ? TWTheme.chroma1 : TWTheme.textSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(TWTheme.surface2, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            ToolFileUrlTargetModel.accessibilityLabel(for: action, url: target)
        )
    }
}

// MARK: - Composed row chrome

/// Drop-in target chrome for a detected tool presentation model.
/// Callbacks only — never opens files/URLs itself.
struct ToolFileUrlTargetSurface: View {
    let model: ToolTargetPresentationModel
    var isEditAccent: Bool = false
    var showsPrimaryUrlInline: Bool = true
    var showsAllUrlSources: Bool = false

    var onOpenFile: ((ToolFilePresentationTarget) -> Void)?
    var onRevealFile: ((ToolFilePresentationTarget) -> Void)?
    var onCopyFilePath: ((ToolFilePresentationTarget) -> Void)?
    var onInspectFile: ((ToolFilePresentationTarget) -> Void)?

    var onOpenUrl: ((ToolUrlPresentationTarget) -> Void)?
    var onCopyUrl: ((ToolUrlPresentationTarget) -> Void)?
    var onInspectUrl: ((ToolUrlPresentationTarget) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let file = model.fileTarget {
                    ToolFileTargetChip(
                        target: file,
                        isEditAccent: isEditAccent,
                        onOpen: onOpenFile,
                        onReveal: onRevealFile,
                        onCopyPath: onCopyFilePath,
                        onInspect: onInspectFile
                    )
                }
                if showsPrimaryUrlInline, let url = model.primaryUrlTarget, !showsAllUrlSources {
                    ToolUrlTargetChip(
                        target: url,
                        compact: true,
                        onOpen: onOpenUrl,
                        onCopy: onCopyUrl,
                        onInspect: onInspectUrl
                    )
                }
            }

            if showsAllUrlSources, model.showsSourcesSection {
                ToolUrlSourcesSection(
                    targets: model.urlTargets,
                    onOpen: onOpenUrl,
                    onCopy: onCopyUrl,
                    onInspect: onInspectUrl
                )
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Desktop compact-tool-trace "Sources" foldout — list of URL badges.
struct ToolUrlSourcesSection: View {
    let targets: [ToolUrlPresentationTarget]
    var onOpen: ((ToolUrlPresentationTarget) -> Void)?
    var onCopy: ((ToolUrlPresentationTarget) -> Void)?
    var onInspect: ((ToolUrlPresentationTarget) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Sources")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(TWTheme.textMuted)
                .textCase(.uppercase)
            FlowLikeUrlTargets(
                targets: targets,
                onOpen: onOpen,
                onCopy: onCopy,
                onInspect: onInspect
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sources, \(targets.count) link\(targets.count == 1 ? "" : "s")")
    }
}

/// Simple wrapping stack without a custom layout engine — sufficient for
/// ≤5 URL badges on a phone row.
private struct FlowLikeUrlTargets: View {
    let targets: [ToolUrlPresentationTarget]
    var onOpen: ((ToolUrlPresentationTarget) -> Void)?
    var onCopy: ((ToolUrlPresentationTarget) -> Void)?
    var onInspect: ((ToolUrlPresentationTarget) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(targets) { target in
                ToolUrlTargetChip(
                    target: target,
                    compact: false,
                    onOpen: onOpen,
                    onCopy: onCopy,
                    onInspect: onInspect
                )
            }
        }
    }
}
