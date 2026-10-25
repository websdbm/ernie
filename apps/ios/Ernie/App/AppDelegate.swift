import UIKit
import UserNotifications

/// Registrazione APNs e consegna delle notifiche: il contenuto arriva comunque dal server (`/v1/notifications`).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor var model: AppModel?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories([Self.familyCategory, Self.urgentCategory])
        // Rapporti di iOS su blocchi e chiusure per errore: al server, per la diagnosi.
        DiagnosticsReporter.shared.start()
        if let credentials = Credentials.load() { MediaUploadQueue.shared.configure(credentials) }
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        MediaUploadQueue.shared.handleBackgroundEvents(identifier, completion: completionHandler)
    }

    // MARK: - messaggi in famiglia: «Rispondi» dalla notifica, anche a telefono bloccato

    nonisolated static let familyCategoryId = "FAMILY_MESSAGE"
    nonisolated static let familyReplyAction = "FAMILY_REPLY"

    /// Categoria delle notifiche dei messaggi (la manda il server): risposta scritta senza aprire l'app.
    static let familyCategory = UNNotificationCategory(
        identifier: familyCategoryId,
        actions: [
            UNTextInputNotificationAction(
                identifier: familyReplyAction,
                title: "Rispondi",
                options: [.authenticationRequired],
                icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left.fill"),
                textInputButtonTitle: "Invia",
                textInputPlaceholder: "Scrivi la risposta"
            ),
        ],
        intentIdentifiers: [],
        hiddenPreviewsBodyPlaceholder: "Messaggio in famiglia",
        options: []
    )

    /// Messaggio urgente: la notifica apre l'app sul messaggio a tutto schermo, dove si conferma di averlo letto.
    static let urgentCategory = UNNotificationCategory(
        identifier: "FAMILY_URGENT",
        actions: [
            UNNotificationAction(
                identifier: "FAMILY_URGENT_OPEN",
                title: "Apri e conferma",
                options: [.foreground, .authenticationRequired],
                icon: UNNotificationActionIcon(systemImageName: "checkmark.seal.fill")
            ),
        ],
        intentIdentifiers: [],
        hiddenPreviewsBodyPlaceholder: "Messaggio urgente in famiglia",
        options: []
    )

    /// Id del messaggio urgente di una notifica (nil per le altre).
    nonisolated static func urgentId(_ info: [AnyHashable: Any]) -> String? {
        guard let data = info["ernie"] as? [String: Any], data["urgent"] as? Bool == true else { return nil }
        return data["id"] as? String
    }

    /// Manda la risposta scritta nella notifica a chi ha scritto, come risposta al suo messaggio. Usa le credenziali
    /// del Keychain: l'app può essere stata avviata in background solo per questo.
    nonisolated static func sendReply(_ text: String, to: String, replyTo id: String) async -> FamilyMessageBlock? {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, let credentials = Credentials.load() else { return nil }
        let api = ApiClient(credentials: credentials)
        let sent = try? await api.sendFamilyMessage(to: to, text: String(body.prefix(2000)), image: nil, replyTo: id)
        _ = try? await api.markFamilyMessagesRead(ids: [id])
        return sent
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await model?.registerDevice(token: hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Log.push.warning("registrazione APNs fallita: \(error.localizedDescription, privacy: .public)")
    }

    /// Dati della notifica che servono dopo, estratti subito: oggetti e dizionari di UserNotifications non sono Sendable.
    private struct PushInfo: Sendable {
        let family: Bool
        let urgentId: String?
        let from: String?
        let messageId: String?

        init(_ info: [AnyHashable: Any]) {
            let data = info["ernie"] as? [String: Any]
            family = AppDelegate.isFamilyMessage(info)
            urgentId = AppDelegate.urgentId(info)
            from = data?["from"] as? String
            messageId = data?["id"] as? String
        }
    }

    // Versioni con il completamento esplicito, chiamato sul thread principale. Con le varianti `async` nonisolated
    // iOS chiudeva la consegna su un thread di Swift Concurrency e UIKit aggiornava l'istantanea dell'app fuori dal
    // main: l'app si chiudeva al tocco su «… ha letto» (crash 16 ott 2026, NSAssertion in
    // `_updateSnapshotAndStateRestorationWithAction`).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let push = PushInfo(notification.request.content.userInfo)
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in
            model?.inbox.scheduleRefresh()
            done([.banner, .sound, .list])
            if push.family { await model?.syncFamilyMessages(urgentId: push.urgentId) }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let push = PushInfo(response.notification.request.content.userInfo)
        let reply = response.actionIdentifier == Self.familyReplyAction
            ? (response as? UNTextInputNotificationResponse)?.userText : nil
        nonisolated(unsafe) let done = completionHandler
        Task { @MainActor in
            if push.family, let reply, let from = push.from, let id = push.messageId,
               let sent = await Self.sendReply(reply, to: from, replyTo: id) {
                FamilyLatest(block: sent)?.saveAndReload()
            }
            model?.inbox.scheduleRefresh()
            if push.family { await model?.syncFamilyMessages(urgentId: push.urgentId) }
            done()
        }
    }

    /// Notifica di un messaggio in famiglia (dati sotto la chiave `ernie`).
    nonisolated static func isFamilyMessage(_ info: [AnyHashable: Any]) -> Bool {
        (info["ernie"] as? [String: Any])?["kind"] as? String == "family_message"
    }
}
