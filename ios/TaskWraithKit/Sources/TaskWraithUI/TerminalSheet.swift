// Workspace terminal — the paired-device shell, file-editor UX: open a
// sheet, work, dismiss. The trust ceremony is deliberately IN YOUR FACE:
// an elevation confirm on this device, then the Mac's own shellCommands
// approval (which may render right here as an approval card) before any
// shell starts. Output is a polled ring; ANSI control sequences are
// stripped for v1's plain-text scrollback — this is a working terminal,
// not a VT100 emulator.

import SwiftUI
import TaskWraithKit

struct TerminalSheet: View {
    @ObservedObject var model: RemoteSessionModel
    let workspaceId: String
    let workspaceName: String
    @Environment(\.dismiss) private var dismiss

    private enum Phase: Equatable {
        case elevation
        case opening
        case live(String)
        case failed(String)
        case exited
    }

    @State private var phase: Phase = .elevation
    @State private var scrollback = ""
    @State private var lastSeq = 0
    @State private var command = ""
    @State private var pollTask: Task<Void, Never>? = nil

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .elevation: elevationGate
                case .opening:
                    ProgressView("Waiting for the Mac's approval…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .live, .exited: terminalBody
                case .failed(let reason):
                    VStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle")
                            .foregroundStyle(TWTheme.statusAttention)
                        Text(reason)
                            .font(.caption)
                            .foregroundStyle(TWTheme.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(TWTheme.appBg)
            .navigationTitle("Terminal — \(workspaceName)")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onDisappear { teardown() }
    }

    // MARK: Elevation

    private var elevationGate: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("This opens a real shell", systemImage: "exclamationmark.shield")
                .font(.headline)
                .foregroundStyle(TWTheme.statusAttention)
            Text(
                "A terminal runs with your Mac account's full rights inside \"\(workspaceName)\" — beyond every posture and approval boundary agents run under. The Mac will also ask for its own approval before the shell starts, and the session is recorded in the approval ledger."
            )
            .font(.callout)
            .foregroundStyle(TWTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button {
                phase = .opening
                Task { await open() }
            } label: {
                Text("Open terminal")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(TWTheme.statusAttention)
            Button("Cancel") { dismiss() }
                .frame(maxWidth: .infinity)
        }
        .padding()
    }

    // MARK: Terminal

    private var terminalBody: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    Text(scrollback.isEmpty ? " " : scrollback)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(TWTheme.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .textSelection(.enabled)
                        .id("terminal-tail")
                }
                .background(TWTheme.surface1)
                .onChange(of: scrollback) {
                    proxy.scrollTo("terminal-tail", anchor: .bottom)
                }
            }
            if phase == .exited {
                Text("Shell exited.")
                    .font(.caption)
                    .foregroundStyle(TWTheme.textMuted)
                    .padding(6)
            } else {
                keyRow
                HStack(spacing: 8) {
                    TextField("Command", text: $command)
                        .font(.system(size: 13, design: .monospaced))
                        .textFieldStyle(.plain)
                        #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        #endif
                        .onSubmit { submitCommand() }
                    Button {
                        submitCommand()
                    } label: {
                        Image(systemName: "return")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .disabled(command.isEmpty)
                }
                .padding(10)
                .background(TWTheme.surface2)
            }
        }
    }

    private var keyRow: some View {
        HStack(spacing: 10) {
            keyButton("Ctrl-C") { send(bytes: [0x03]) }
            keyButton("Tab") { send(bytes: [0x09]) }
            keyButton("↑") { send(bytes: [0x1B, 0x5B, 0x41]) }
            keyButton("↓") { send(bytes: [0x1B, 0x5B, 0x42]) }
            keyButton("Ctrl-D") { send(bytes: [0x04]) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(TWTheme.surface2)
    }

    private func keyButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(TWTheme.surface3, in: Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(TWTheme.textSecondary)
    }

    // MARK: Session plumbing

    private func open() async {
        do {
            let terminalId = try await model.openTerminal(
                workspaceId: workspaceId, cols: 80, rows: 24)
            phase = .live(terminalId)
            startPolling(terminalId: terminalId)
        } catch {
            phase = .failed(
                (error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
    }

    private func startPolling(terminalId: String) {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                do {
                    let read = try await model.readTerminal(
                        workspaceId: workspaceId, terminalId: terminalId, afterSeq: lastSeq)
                    if !read.chunks.isEmpty {
                        var appended = ""
                        for chunk in read.chunks {
                            if let data = Data(base64Encoded: chunk.dataBase64),
                                let text = String(data: data, encoding: .utf8)
                            {
                                appended += text
                            }
                        }
                        scrollback = String(
                            (scrollback + Self.stripAnsi(appended)).suffix(40_000))
                        lastSeq = read.latestSeq
                    }
                    if read.exited {
                        phase = .exited
                        break
                    }
                } catch {
                    // Transient read failures ride the next poll; a dead
                    // session surfaces as `exited` from the Mac.
                }
                try? await Task.sleep(for: .milliseconds(350))
            }
        }
    }

    private func submitCommand() {
        let text = command
        command = ""
        send(bytes: Array((text + "\n").utf8))
    }

    private func send(bytes: [UInt8]) {
        guard case .live(let terminalId) = phase else { return }
        Task {
            try? await model.sendTerminalInput(
                workspaceId: workspaceId, terminalId: terminalId, data: Data(bytes))
        }
    }

    private func teardown() {
        pollTask?.cancel()
        if case .live(let terminalId) = phase {
            Task { await model.closeTerminal(workspaceId: workspaceId, terminalId: terminalId) }
        }
    }

    /// v1 plain-text discipline: drop CSI/OSC control sequences and lone
    /// escapes so shell colour codes do not litter the scrollback.
    static func stripAnsi(_ text: String) -> String {
        let pattern = "\u{001B}(\\[[0-9;?]*[a-zA-Z]|\\][^\u{0007}]*(\u{0007}|\u{001B}\\\\))"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(text.startIndex..., in: text)
        let stripped = regex.stringByReplacingMatches(
            in: text, range: range, withTemplate: "")
        return stripped.replacingOccurrences(of: "\u{001B}", with: "")
    }
}
