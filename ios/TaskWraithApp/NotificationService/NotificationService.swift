// TaskWraith Notification Service Extension — decrypts a run-complete push's
// rich blob ON-DEVICE (works backgrounded/closed) and rewrites the banner so it
// shows "Codex finished · 3 files changed · <summary>" instead of the generic
// "Task complete". Apple/the relay only ever saw ciphertext.
//
// Fail-safe by construction: `bestAttempt` starts as the ORIGINAL (generic)
// content and is upgraded only on a FULL successful decrypt + decode. Every
// other path — no blob, key not yet shared, decrypt/decode failure, or the 30s
// timeout — ships the generic notification, strictly never worse than today.

import UserNotifications

import TaskWraithKit

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let best = request.content.mutableCopy() as? UNMutableNotificationContent
        bestAttempt = best
        guard let best else {
            contentHandler(request.content)
            return
        }

        let info = request.content.userInfo
        guard let twpushObj = info["twpush"] as? [String: Any],
            let envelope = TWPushSeal.parse(twpushObj),
            let pairId = info["pairID"] as? String,
            let seed = TWPushKeyAccess.deviceSeed()
        else {
            contentHandler(best)
            return
        }
        let failed = (info["reason"] as? String) == "runFailed"

        // pairID is phone-scoped (it identifies this phone, not which Mac), so
        // try each paired host's agreement key — only the real sender's key
        // produces a valid GCM tag, so the first that decrypts is authentic.
        for host in TWPushKeyAccess.pairedHostStore().list() {
            guard let agreePubB64 = host.macAgreePub,
                let agreePub = Data(base64Encoded: agreePubB64),
                let plaintext = try? TWPushSeal.open(
                    envelope: envelope, deviceSeed: seed, senderAgreePubRaw: agreePub,
                    pairId: pairId),
                let content = CompletionPushContent.decode(plaintext)
            else { continue }
            let rendered = CompletionBannerRenderer.render(content.bannerInput(failed: failed))
            best.title = rendered.title
            best.body = rendered.body
            contentHandler(best)
            return
        }

        // Nothing decrypted → ship the generic alert untouched.
        contentHandler(best)
    }

    override func serviceExtensionTimeWillExpire() {
        // Last chance before iOS would show the original content — ship our best.
        if let handler = contentHandler, let best = bestAttempt {
            handler(best)
        }
    }
}
