import SwiftUI

struct ComposerScheduleSheet: View {
    let threadTitle: String
    let validationReason: String?
    let onSchedule: (Date) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draftDate: Date
    @State private var selectedDate: Date?
    @State private var now = Date()

    init(threadTitle: String, validationReason: String?, onSchedule: @escaping (Date) -> Void) {
        self.threadTitle = threadTitle
        self.validationReason = validationReason
        self.onSchedule = onSchedule
        _draftDate = State(initialValue: Date().addingTimeInterval(15 * 60))
    }

    private var minDate: Date {
        now.addingTimeInterval(60)
    }

    private var canSchedule: Bool {
        guard validationReason == nil, let selectedDate else { return false }
        return selectedDate > now
    }

    private var statusText: String {
        if let validationReason { return validationReason }
        guard let selectedDate else { return "No time selected" }
        if selectedDate <= now { return "Choose a future time" }
        return "Scheduled for \(formatScheduleDate(selectedDate))"
    }

    private var timeZoneLabel: String {
        TimeZone.current.identifier
    }

    var body: some View {
        NavigationStack {
            Form {
                Group {
                    Section {
                        DatePicker(
                            "Date & time",
                            selection: Binding(
                                get: { draftDate },
                                set: { value in
                                    draftDate = value
                                    selectedDate = value
                                }
                            ),
                            in: minDate...,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                    } header: {
                        HStack {
                            Text("Date & time")
                            Spacer()
                            Text(timeZoneLabel)
                        }
                    }

                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                presetButton("15m") { selectOffset(minutes: 15) }
                                presetButton("1h") { selectOffset(minutes: 60) }
                                presetButton("Tonight") { selectTonight() }
                                presetButton("Tomorrow") { selectTomorrow() }
                            }
                            .padding(.vertical, 2)
                        }
                    }

                    Section {
                        HStack {
                            Text(statusText)
                                .foregroundStyle(statusColor)
                            Spacer()
                            Button("Clear") {
                                selectedDate = nil
                            }
                            .disabled(selectedDate == nil)
                        }
                    }
                }
                .twGlassSheetRowBackground()
            }
            .twGlassSheetListCanvas()
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) {
                    TWPrincipalTitle(title: "Schedule message", subtitle: threadTitle)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schedule") { schedule() }
                        .disabled(!canSchedule)
                }
            }
            .onAppear { now = Date() }
        }
        .twColorScheme()
    }

    private var statusColor: Color {
        canSchedule ? TWTheme.textSecondary : TWTheme.textMuted
    }

    private func presetButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(TWTheme.surface3, in: Capsule())
                .overlay(Capsule().strokeBorder(TWTheme.border.opacity(0.8)))
                .foregroundStyle(TWTheme.textSecondary)
        }
        .buttonStyle(.plain)
    }

    private func selectOffset(minutes: Int) {
        let value = Date().addingTimeInterval(TimeInterval(minutes * 60))
        draftDate = value
        selectedDate = value
        now = Date()
    }

    private func selectTonight() {
        var components = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        components.hour = 20
        components.minute = 0
        components.second = 0
        var value = Calendar.current.date(from: components) ?? Date().addingTimeInterval(15 * 60)
        if value <= Date().addingTimeInterval(60) {
            value = Calendar.current.date(byAdding: .day, value: 1, to: value) ?? value.addingTimeInterval(24 * 60 * 60)
        }
        draftDate = value
        selectedDate = value
        now = Date()
    }

    private func selectTomorrow() {
        var components = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        components.day = (components.day ?? 0) + 1
        components.hour = 9
        components.minute = 0
        components.second = 0
        let value = Calendar.current.date(from: components) ?? Date().addingTimeInterval(24 * 60 * 60)
        draftDate = value
        selectedDate = value
        now = Date()
    }

    private func schedule() {
        now = Date()
        guard canSchedule, let selectedDate else { return }
        onSchedule(selectedDate)
        dismiss()
    }

    private func formatScheduleDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        if Calendar.current.isDateInToday(date) {
            formatter.dateFormat = "HH:mm"
        } else {
            formatter.dateFormat = "d MMM, HH:mm"
        }
        return formatter.string(from: date)
    }
}
