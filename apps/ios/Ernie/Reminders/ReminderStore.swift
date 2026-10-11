import Foundation
import Observation
import UserNotifications
import WidgetKit

/// Promemoria nell'app: copia locale dei prossimi, notifiche locali programmate (schermata di blocco anche senza
/// push), istantanea per il widget. Il server resta la fonte: all'ora stabilita il worker manda la notifica
/// (scheda in chat, push se configurato, email se richiesta); la notifica locale è la rete di sicurezza.
@MainActor
@Observable
final class ReminderStore {
    private(set) var items: [ReminderItem] = []
    private(set) var lastError: String?
    private var api: ApiClient?

    func configure(api: ApiClient?) { self.api = api }

    /// Blocchi `reminders` in arrivo: aggiorna la copia, le notifiche locali e il widget.
    func apply(_ block: ContentBlock) {
        guard case .reminders(let b) = block else { return }
        for r in b.reminders {
            if r.status == "scheduled" {
                if let i = items.firstIndex(where: { $0.id == r.id }) { items[i] = r } else { items.append(r) }
            } else {
                items.removeAll { $0.id == r.id }
            }
        }
        sync()
    }

    /// Rilegge dal server (all'avvio e al ritorno in primo piano).
    func refresh() async {
        guard let api else { return }
        do {
            items = try await api.reminders()
            lastError = nil
            sync()
        } catch {
            lastError = AppModel.describe(error)
        }
    }

    func cancel(_ r: ReminderItem) async {
        guard let api else { return }
        do {
            try await api.deleteReminder(id: r.id)
            items.removeAll { $0.id == r.id }
            lastError = nil
            sync()
        } catch {
            lastError = AppModel.describe(error)
        }
    }

    func isScheduled(_ id: String) -> Bool { items.contains { $0.id == id } }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    // MARK: - notifiche locali e widget

    private func sync() {
        let future = items.compactMap { r -> ReminderSnapshot.Item? in
            guard let at = Self.date(r.at), at > .now else { return nil }
            return ReminderSnapshot.Item(id: r.id, text: r.text, at: at)
        }
        .sorted { $0.at < $1.at }
        ReminderSnapshot(items: future, updatedAt: .now).save()
        WidgetCenter.shared.reloadAllTimelines()
        Task { await Self.scheduleLocalNotifications(future) }
    }

    private static func scheduleLocalNotifications(_ items: [ReminderSnapshot.Item]) async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix("reminder-") }
        let wanted = Set(items.map { "reminder-\($0.id)" })
        let stale = pending.filter { !wanted.contains($0) }
        if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: stale) }
        for item in items where !pending.contains("reminder-\(item.id)") {
            let content = UNMutableNotificationContent()
            content.title = "Promemoria"
            content.body = item.text
            content.sound = .default
            content.threadIdentifier = "reminders"
            content.interruptionLevel = .timeSensitive
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: item.at)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            try? await center.add(UNNotificationRequest(identifier: "reminder-\(item.id)", content: content, trigger: trigger))
        }
    }
}
