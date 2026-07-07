import SwiftUI

struct ThreadRenameSheet: View {
    let currentTitle: String
    let subtitle: String?
    let onSave: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool
    @State private var draft: String

    init(currentTitle: String, subtitle: String? = nil, onSave: @escaping (String) -> Void) {
        self.currentTitle = currentTitle
        self.subtitle = subtitle
        self.onSave = onSave
        _draft = State(initialValue: currentTitle)
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedCurrentTitle: String {
        currentTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        !trimmedDraft.isEmpty && trimmedDraft != trimmedCurrentTitle
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Chat name", text: $draft, axis: .vertical)
                        .focused($focused)
                        .lineLimit(1...3)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .accessibilityLabel("Chat name")
                        .accessibilityValue(draft)
                        #if os(iOS)
                            .textInputAutocapitalization(.sentences)
                        #endif
                } footer: {
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                    }
                }
                .twGlassSheetRowBackground()
            }
            .twGlassSheetListCanvas()
            .navigationTitle("Rename chat")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(!canSave)
                }
            }
            .onAppear { focused = true }
        }
        .twColorScheme()
    }

    private func save() {
        guard canSave else { return }
        onSave(trimmedDraft)
        dismiss()
    }
}
