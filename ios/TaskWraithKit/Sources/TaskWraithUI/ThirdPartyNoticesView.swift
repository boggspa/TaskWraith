import SwiftUI

enum TaskWraithLicenseResource: String, Identifiable {
    case taskWraith
    case thirdParty

    var id: String { rawValue }

    var title: String {
        switch self {
        case .taskWraith: return "TaskWraith License"
        case .thirdParty: return "Third-Party Notices"
        }
    }

    private var fileName: String {
        switch self {
        case .taskWraith: return "TASKWRAITH-LICENSE"
        case .thirdParty: return "THIRD-PARTY-NOTICES"
        }
    }

    func text() throws -> String {
        guard let url = Bundle.module.url(forResource: fileName, withExtension: "txt") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try String(contentsOf: url, encoding: .utf8)
    }
}

struct ThirdPartyNoticesSettingsView: View {
    @State private var selectedNotice: TaskWraithLicenseResource?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            noticeButton(.taskWraith, subtitle: "Apache 2.0 terms for TaskWraith")
            noticeButton(.thirdParty, subtitle: "3 pinned Swift packages · 5 preserved sources")
            Text(
                "The release gate rebuilds this inventory from both Package.resolved graphs and fails if a package or exact notice mapping is missing."
            )
            .font(.footnote)
            .foregroundStyle(TWTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .sheet(item: $selectedNotice) { resource in
            LicenseNoticeDocumentView(resource: resource)
                .twSheetLiquidGlass(detents: [.large])
        }
    }

    private func noticeButton(
        _ resource: TaskWraithLicenseResource,
        subtitle: String
    ) -> some View {
        Button {
            selectedNotice = resource
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "doc.text")
                    .foregroundStyle(TWTheme.chroma1)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(resource.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(TWTheme.textPrimary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(TWTheme.textSecondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TWTheme.textTertiary)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                TWTheme.surface2,
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(TWTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(resource.title)
        .accessibilityHint("Opens the bundled license text")
    }
}

private struct LicenseNoticeDocumentView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.twGlassSheetHosted) private var glassSheetHosted
    let resource: TaskWraithLicenseResource

    private var noticeText: String {
        (try? resource.text()) ?? "This bundled notice is unavailable."
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(noticeText)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(TWTheme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(
                (glassSheetHosted ? Color.clear : TWTheme.appBg)
                    .ignoresSafeArea()
            )
            .navigationTitle(resource.title)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .twColorScheme()
    }
}
