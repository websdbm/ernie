import Intents
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import WidgetKit

/// Estensione delle notifiche (richiesta dell'utente, 15 ott 2026: messaggi in famiglia «ben evidenti» sulla schermata
/// di blocco). La notifica di un messaggio diventa una notifica di comunicazione, come quelle di Messaggi: nome e
/// iniziali di chi scrive in grande, la foto in anteprima, in cima al blocco (urgente). L'ultimo messaggio va anche al
/// widget «Messaggi». Le altre notifiche passano invariate.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        guard let push = FamilyPush(request.content.userInfo) else {
            contentHandler(request.content)
            return
        }
        lock.withLock {
            handler = contentHandler
            original = request.content
        }
        // L'estensione non ha il gruppo app (il portale non lo assegna con la chiave API): il widget «Messaggi»
        // rilegge l'ultimo messaggio dal server. Le ripetizioni di un urgente non lo ricaricano ogni volta.
        if !push.urgent || push.firstUrgent { WidgetCenter.shared.reloadTimelines(ofKind: FamilyLatest.widgetKind) }
        let task = Task { [weak self] in
            let photo = push.image ? await Self.downloadPhoto(id: push.id) : nil
            guard let self, !Task.isCancelled,
                  let content = self.lock.withLock({ self.original })?.mutableCopy() as? UNMutableNotificationContent
            else { return }
            self.deliver(await Self.decorate(content, push: push, photo: photo))
        }
        lock.withLock { work = task }
    }

    override func serviceExtensionTimeWillExpire() {
        let (task, content) = lock.withLock { (work, original) }
        task?.cancel()
        if let content { deliver(content) }
    }

    /// Consegna una volta sola (il tempo può scadere mentre la foto arriva).
    private func deliver(_ content: UNNotificationContent) {
        let h = lock.withLock {
            let h = handler
            handler = nil
            return h
        }
        h?(content)
    }

    // MARK: - notifica di comunicazione

    private static func decorate(
        _ content: UNMutableNotificationContent,
        push: FamilyPush,
        photo: URL?
    ) async -> UNNotificationContent {
        if let photo,
           let attachment = try? UNNotificationAttachment(
               identifier: "foto",
               url: photo,
               options: [UNNotificationAttachmentOptionsTypeHintKey: UTType.jpeg.identifier]
           ) {
            content.attachments = [attachment]
        }
        content.interruptionLevel = .timeSensitive
        content.relevanceScore = 1
        // Urgente («super snooze»): resta la notifica con «🚨 Urgente da …» e il suo suono, più riconoscibile del
        // nome solo; si ripete finché non arriva la conferma.
        if push.urgent { return content }
        let avatar = INImage(imageData: Monogram.png(for: push.label))
        let sender = INPerson(
            personHandle: INPersonHandle(value: push.from, type: .unknown),
            nameComponents: nil,
            displayName: push.label,
            image: avatar,
            contactIdentifier: nil,
            customIdentifier: push.from
        )
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: content.body,
            speakableGroupName: nil,
            conversationIdentifier: "family-\(push.from)",
            serviceName: "Ernie",
            sender: sender,
            attachments: nil
        )
        intent.setImage(avatar, forParameterNamed: \.sender)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        try? await interaction.donate()
        // Senza l'entitlement delle notifiche di comunicazione (build senza firma) resta la notifica normale.
        guard let updated = try? content.updating(from: intent) else { return content }
        if !content.attachments.isEmpty, updated.attachments.isEmpty,
           let copy = updated.mutableCopy() as? UNMutableNotificationContent {
            copy.attachments = content.attachments
            return copy
        }
        return updated
    }

    // MARK: - foto

    /// Scarica la foto del messaggio con le credenziali del Keychain condiviso; nil se non riesce in tempo.
    private static func downloadPhoto(id: String) async -> URL? {
        guard let credentials = Credentials.load(),
              let url = URL(string: "/v1/family/messages/\(id)/image", relativeTo: credentials.serverURL) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return nil }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).jpg")
        do {
            try data.write(to: file)
            return file
        } catch {
            return nil
        }
    }
}

/// Dati della notifica di un messaggio (chiave `ernie` del payload, server ≥ build 59).
struct FamilyPush: Sendable {
    let id: String
    let from: String
    let label: String
    let image: Bool
    let urgent: Bool
    /// Prima notifica di un urgente (le ripetizioni hanno `nag`).
    let firstUrgent: Bool

    init?(_ userInfo: [AnyHashable: Any]) {
        guard let data = userInfo["ernie"] as? [String: Any],
              data["kind"] as? String == "family_message",
              let id = data["id"] as? String, let from = data["from"] as? String else { return nil }
        let label = (data["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Famiglia"
        let image = data["image"] as? Bool ?? false
        let urgent = data["urgent"] as? Bool ?? false
        self.id = id
        self.from = from
        self.label = label
        self.image = image
        self.urgent = urgent
        self.firstUrgent = urgent && data["nag"] == nil
    }
}

/// Iniziali di chi scrive su un cerchio color sabbia (il colore dei messaggi ricevuti nella chat).
enum Monogram {
    static func png(for label: String) -> Data {
        let size = CGSize(width: 180, height: 180)
        let initials = label
            .split(separator: " ")
            .prefix(2)
            .compactMap { $0.first.map { String($0).uppercased() } }
            .joined()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            let rect = CGRect(origin: .zero, size: size)
            let colors = [UIColor(red: 0.93, green: 0.76, blue: 0.36, alpha: 1).cgColor,
                          UIColor(red: 0.76, green: 0.52, blue: 0.16, alpha: 1).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                ctx.cgContext.addEllipse(in: rect)
                ctx.cgContext.clip()
                ctx.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
            }
            let text = (initials.isEmpty ? "✉︎" : initials) as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: initials.count > 1 ? 70 : 84, weight: .semibold),
                .foregroundColor: UIColor.white,
            ]
            let textSize = text.size(withAttributes: attributes)
            text.draw(at: CGPoint(x: (size.width - textSize.width) / 2, y: (size.height - textSize.height) / 2), withAttributes: attributes)
        }
        return image.pngData() ?? Data()
    }
}
