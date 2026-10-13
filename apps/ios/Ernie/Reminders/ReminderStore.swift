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
    /// Promemoria a cui l'utente ha acceso l'email senza un indirizzo nella scheda: la vista chiede l'indirizzo.
    private(set) var needsEmailFor: String? = nil
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
            try await api.deleteReminder(id: resolve(r.id))
            items.removeAll { $0.id == resolve(r.id) }
            lastError = nil
            sync()
        } catch {
            lastError = AppModel.describe(error)
        }
    }

    /// Id sostituiti dalle modifiche (un promemoria cambiato ha un id nuovo): le schede nella conversazione
    /// seguono la catena anche dopo un riavvio (la mappa resta in UserDefaults, al massimo 200 voci).
    private(set) var replaced: [String: String] = (UserDefaults.standard.dictionary(forKey: "reminders.replaced") as? [String: String]) ?? [:] {
        didSet {
            if replaced.count > 200 { replaced = Dictionary(uniqueKeysWithValues: Array(replaced.suffix(150))) }
            UserDefaults.standard.set(replaced, forKey: "reminders.replaced")
        }
    }

    func resolve(_ id: String) -> String {
        var cur = id
        var hops = 0
        while let next = replaced[cur], hops < 20 { cur = next; hops += 1 }
        return cur
    }

    func item(_ id: String) -> ReminderItem? {
        let r = resolve(id)
        return items.first { $0.id == r }
    }

    func isScheduled(_ id: String) -> Bool { item(id) != nil }

    /// Modifica dalla scheda: testo e/o ora; il server sostituisce il promemoria (id nuovo).
    func update(_ r: ReminderItem, text: String?, at: Date?) async -> Bool {
        guard let api else { return false }
        do {
            let updated = try await api.updateReminder(id: r.id, text: text, at: at)
            items.removeAll { $0.id == r.id }
            items.append(updated)
            if updated.id != r.id { replaced[r.id] = updated.id }
            lastError = nil
            sync()
            return true
        } catch {
            lastError = AppModel.describe(error)
            return false
        }
    }

    /// Canali di un promemoria (sveglia, email): si passa solo il valore cambiato; il server risponde con il promemoria.
    func setChannels(_ r: ReminderItem, email: Bool?, alarm: Bool?) async -> Bool {
        guard let api else { return false }
        do {
            let (updated, needsEmail) = try await api.updateReminderChannels(id: resolve(r.id), email: email, alarm: alarm)
            if let i = items.firstIndex(where: { $0.id == updated.id }) { items[i] = updated } else { items.append(updated) }
            needsEmailFor = needsEmail ? updated.id : nil
            lastError = nil
            sync()
            return true
        } catch {
            lastError = AppModel.describe(error)
            return false
        }
    }

    /// Chiude la richiesta dell'indirizzo email (annullata dall'utente).
    func dismissEmailPrompt() { needsEmailFor = nil }

    /// Salva l'email nelle impostazioni: il server la copia anche nella scheda anagrafica.
    func saveEmail(_ email: String) async -> Bool {
        guard let api else { return false }
        let clean = email.trimmingCharacters(in: .whitespaces)
        do {
            _ = try await api.updateSettings(["email": .string(clean)])
            needsEmailFor = nil
            lastError = nil
            return true
        } catch {
            lastError = AppModel.describe(error)
            return false
        }
    }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    // MARK: - notifiche locali e widget

    /// Riallinea notifiche, sveglie e widget (anche dopo il cambio dell'opzione «come sveglia»).
    func sync() {
        let future = items.compactMap { r -> ReminderSnapshot.Item? in
            guard let at = Self.date(r.at), at > .now else { return nil }
            // Ricorrenti settimanali e giornalieri: giorni, ora e minuti per la sveglia e la notifica ripetute.
            let rep = r.repeatInfo
            let days: [Int]? = switch rep?.kind {
            case "weekly": rep?.weekdays
            case "daily": Array(0...6)
            default: nil
            }
            return ReminderSnapshot.Item(
                id: r.id, text: r.text, at: at, from: r.fromLabel,
                alarm: r.channels?.alarm,
                weekdays: days, hour: days == nil ? nil : rep?.hour, minute: days == nil ? nil : rep?.minute
            )
        }
        .sorted { $0.at < $1.at }
        ReminderSnapshot(items: future, updatedAt: .now).save()
        WidgetCenter.shared.reloadAllTimelines()
        // Suonano solo i miei: quelli messi a un familiare suonano sul suo telefono.
        let mine = Set(items.filter { $0.forLabel == nil }.map(\.id))
        let own = future.filter { mine.contains($0.id) }
        // In fila: all'avvio arrivano insieme la rilettura e i blocchi della chat; in parallelo chiederebbero
        // il permesso più volte e potrebbero programmare due volte la stessa sveglia.
        let previous = pendingSync
        pendingSync = Task {
            await previous?.value
            // Le sveglie scelgono da sole: canale del promemoria, altrimenti l'opzione generale.
            let alarmed = await ReminderAlarms.sync(own)
            await Self.scheduleLocalNotifications(own.filter { !alarmed.contains($0.id) })
        }
    }

    private var pendingSync: Task<Void, Never>?

    private static func scheduleLocalNotifications(_ items: [ReminderSnapshot.Item]) async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix("reminder-") }
        // Una richiesta per le una tantum; per i ricorrenti una richiesta ripetuta per ogni giorno della settimana.
        var requests: [(id: String, item: ReminderSnapshot.Item, comps: DateComponents, repeats: Bool)] = []
        for item in items {
            if let days = item.weekdays, let hour = item.hour, let minute = item.minute {
                for d in days {
                    var c = DateComponents()
                    c.weekday = d + 1 // Calendar: 1 = domenica
                    c.hour = hour
                    c.minute = minute
                    requests.append(("reminder-\(item.id)-w\(d)", item, c, true))
                }
            } else {
                let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: item.at)
                requests.append(("reminder-\(item.id)", item, c, false))
            }
        }
        let wanted = Set(requests.map(\.id))
        let stale = pending.filter { !wanted.contains($0) }
        if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: stale) }
        for r in requests where !pending.contains(r.id) {
            let content = UNMutableNotificationContent()
            content.title = r.item.from.map { "Promemoria da \($0)" } ?? "Promemoria"
            content.body = r.item.text
            content.sound = .default
            content.threadIdentifier = "reminders"
            content.interruptionLevel = .timeSensitive
            let trigger = UNCalendarNotificationTrigger(dateMatching: r.comps, repeats: r.repeats)
            try? await center.add(UNNotificationRequest(identifier: r.id, content: content, trigger: trigger))
        }
    }
}
