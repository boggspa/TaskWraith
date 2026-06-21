// Read-only "Canvas open" card, projected from the Mac (RemoteTaskCard.canvasPreviews,
// built by RemoteTaskProjection.buildRemoteCanvasPreviews). It tells the phone that
// one or more TaskWraith Canvas web previews are open in this chat — driver-agnostic,
// VIEW-ONLY (no pixels, no actions). Phone write-actions land in a later slice; the
// Codable shape is kept in sync with the TS projection by CanvasPreviewDecodeTests.

import SwiftUI
import TaskWraithKit

struct CanvasPreviewCard: View {
    let previews: [RemoteCanvasPreview]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "macwindow")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.chroma1)
                Text(previews.count == 1 ? "Canvas" : "Canvases")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TWTheme.textTertiary)
                Spacer(minLength: 6)
                Text("Open on desktop")
                    .font(.caption2)
                    .foregroundStyle(TWTheme.textTertiary)
            }
            ForEach(previews) { preview in
                row(preview)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(
                colors: [TWTheme.chroma1.opacity(0.10), TWTheme.surface1.opacity(0.76)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 12)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(TWTheme.chroma1.opacity(0.40), lineWidth: 1.1)
        )
    }

    private func row(_ preview: RemoteCanvasPreview) -> some View {
        HStack(alignment: .center, spacing: 9) {
            VStack(alignment: .leading, spacing: 2) {
                Text(preview.displayLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TWTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let url = preview.url, !url.isEmpty {
                    Text(url)
                        .font(.caption2)
                        .foregroundStyle(TWTheme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 6)
            statusPill(preview)
        }
    }

    @ViewBuilder private func statusPill(_ preview: RemoteCanvasPreview) -> some View {
        let label: String
        let color: Color
        switch preview.status {
        case "active":
            label = "Live"
            color = TWTheme.statusSuccess
        case "opening":
            label = "Opening"
            color = TWTheme.statusAttention
        case "error":
            label = "Error"
            color = TWTheme.statusFailed
        case "closed":
            label = "Closed"
            color = TWTheme.textTertiary
        default:
            label = preview.status ?? "—"
            color = TWTheme.textTertiary
        }
        return Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }
}
