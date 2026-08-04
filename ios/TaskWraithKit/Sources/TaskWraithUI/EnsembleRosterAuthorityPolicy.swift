import Foundation

/// Pure roster-draft authority policy shared by both iOS roster editors.
/// Authority is configuration, not availability: disabled foreground seats
/// remain eligible, while background seats cannot be Boss or Captain.
enum EnsembleRosterAuthorityPolicy {
    static let maximumCaptainCount = 3

    typealias Entry = RemoteSessionModel.RosterDraftEntry

    static func hydrate(
        _ entries: [Entry],
        bossmanParticipantId: String?,
        captainParticipantIds: [String]?,
        secondInCommandParticipantId: String?
    ) -> [Entry] {
        let eligibleIds = Set(entries.filter(isForeground).map(\.id))
        let bossId: String? = {
            if let bossmanParticipantId, eligibleIds.contains(bossmanParticipantId) {
                return bossmanParticipantId
            }
            return entries.first(where: { isForeground($0) && $0.isBossman })?.id
                ?? entries.first(where: isForeground)?.id
        }()

        let requestedCaptainIds: Set<String>
        if let captainParticipantIds {
            requestedCaptainIds = Set(captainParticipantIds)
        } else {
            var legacy = Set(entries.filter { $0.isSecondInCommand }.map(\.id))
            if let secondInCommandParticipantId {
                legacy.insert(secondInCommandParticipantId)
            }
            requestedCaptainIds = legacy
        }
        let captainIds = Set(
            entries
                .filter {
                    isForeground($0) && $0.id != bossId
                        && requestedCaptainIds.contains($0.id)
                }
                .prefix(maximumCaptainCount)
                .map(\.id)
        )

        return entries.map { entry in
            var entry = entry
            entry.isBossman = entry.id == bossId
            entry.isSecondInCommand = captainIds.contains(entry.id)
            return entry
        }
    }

    static func normalize(_ entries: [Entry]) -> [Entry] {
        hydrate(
            entries,
            bossmanParticipantId: entries.first(where: { isForeground($0) && $0.isBossman })?.id,
            captainParticipantIds: entries.filter { $0.isSecondInCommand }.map(\.id),
            secondInCommandParticipantId: nil
        )
    }

    static func applying(_ updated: Entry, to entries: [Entry]) -> [Entry]? {
        var normalized = normalize(entries)
        guard let index = normalized.firstIndex(where: { $0.id == updated.id }),
            let bossId = normalized.first(where: { $0.isBossman })?.id
        else { return nil }

        if updated.id == bossId && (!updated.isBossman || !isForeground(updated)) {
            return nil
        }

        var candidate = updated
        if !isForeground(candidate) {
            candidate.isBossman = false
            candidate.isSecondInCommand = false
        } else if candidate.isBossman {
            candidate.isSecondInCommand = false
            for seatIndex in normalized.indices {
                normalized[seatIndex].isBossman = false
            }
        } else if candidate.isSecondInCommand {
            let existingCaptainIds = Set(normalized.filter { $0.isSecondInCommand }.map(\.id))
            if !existingCaptainIds.contains(candidate.id)
                && existingCaptainIds.count >= maximumCaptainCount
            {
                return nil
            }
        }

        normalized[index] = candidate
        let result = normalize(normalized)
        return result.contains(where: { $0.isBossman }) ? result : nil
    }

    static func appending(_ entry: Entry, to entries: [Entry]) -> [Entry]? {
        var normalized = normalize(entries)
        var candidate = entry
        if !isForeground(candidate) {
            candidate.isBossman = false
            candidate.isSecondInCommand = false
        } else if candidate.isBossman {
            candidate.isSecondInCommand = false
            for index in normalized.indices {
                normalized[index].isBossman = false
            }
        } else if candidate.isSecondInCommand {
            let captainCount = normalized.filter { $0.isSecondInCommand }.count
            guard captainCount < maximumCaptainCount else { return nil }
        }
        normalized.append(candidate)
        let result = normalize(normalized)
        return result.contains(where: { $0.isBossman }) ? result : nil
    }

    static func removing(_ participantId: String, from entries: [Entry]) -> [Entry]? {
        let normalized = normalize(entries)
        guard normalized.count > 1,
            !normalized.contains(where: { $0.id == participantId && $0.isBossman })
        else { return nil }
        let result = normalize(normalized.filter { $0.id != participantId })
        return result.contains(where: { $0.isBossman }) ? result : nil
    }

    static func captainAssignmentDisabled(for participantId: String, in entries: [Entry]) -> Bool {
        let normalized = normalize(entries)
        guard let entry = normalized.first(where: { $0.id == participantId }) else { return true }
        if entry.isSecondInCommand { return false }
        return entry.isBossman || !isForeground(entry)
            || normalized.filter { $0.isSecondInCommand }.count >= maximumCaptainCount
    }

    static func canRemove(_ participantId: String, from entries: [Entry]) -> Bool {
        let normalized = normalize(entries)
        return normalized.count > 1
            && !normalized.contains(where: { $0.id == participantId && $0.isBossman })
    }

    static func canBackground(_ participantId: String, in entries: [Entry]) -> Bool {
        !normalize(entries).contains(where: { $0.id == participantId && $0.isBossman })
    }

    static func hasConfiguredBoss(_ entries: [Entry]) -> Bool {
        normalize(entries).contains(where: { $0.isBossman })
    }

    private static func isForeground(_ entry: Entry) -> Bool {
        entry.stageRole != "background"
    }
}
