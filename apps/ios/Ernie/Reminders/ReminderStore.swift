import CoreLocation
import Foundation
import MapKit
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
        for r in b.reminders where !firedPlaces.contains(r.id) {
            if r.status == "scheduled" {
                if let i = items.firstIndex(where: { $0.id == r.id }) { items[i] = r } else { items.append(r) }
            } else {
                items.removeAll { $0.id == r.id }
            }
        }
        scheduleSync()
    }

    /// Tante schede insieme (16 ott 2026: dieci promemoria creati in un solo turno, l'app di Giorgio si è bloccata):
    /// una sola sincronizzazione di notifiche, sveglie e widget dopo l'ultima.
    private var syncDebounce: Task<Void, Never>?
    private func scheduleSync() {
        syncDebounce?.cancel()
        syncDebounce = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.sync()
        }
    }

    /// Promemoria legati a un luogo già scattati su questo telefono (poi tolti dal server): la scheda li mostra «scattato».
    private(set) var firedPlaces: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "reminders.firedPlaces") ?? []) {
        didSet { UserDefaults.standard.set(Array(firedPlaces.suffix(200)), forKey: "reminders.firedPlaces") }
    }

    /// Notifiche di posizione programmate qui (identificativi con la zona): se una sparisce senza che l'abbiamo tolta
    /// noi, è scattata.
    private var armedPlaces: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "reminders.armedPlaces") ?? []) {
        didSet { UserDefaults.standard.set(Array(armedPlaces), forKey: "reminders.armedPlaces") }
    }

    /// Indirizzi già cercati in questa sessione: una ricerca per indirizzo, anche se non trovato.
    private var geocoded: Set<String> = []

    /// Permesso di posizione sufficiente per le notifiche all'arrivo (basta «mentre usi l'app»; se non è ancora stato
    /// chiesto lo chiede l'app al primo promemoria per luogo).
    static var locationAllowed: Bool {
        switch CLLocationManager().authorizationStatus {
        case .denied, .restricted: false
        default: true
        }
    }

    /// Rilegge dal server (all'avvio e al ritorno in primo piano).
    /// Uscita dall'account: niente promemoria in memoria né luoghi già scattati.
    func clear() {
        items = []
        firedPlaces = []
        armedPlaces = []
    }

    /// Le schede promemoria in chat chiedono la rilettura appena compaiono: all'apertura partivano decine di
    /// richieste insieme (revisione del 16 ott 2026). Una alla volta, e non più di una ogni 15 secondi se non serve.
    private var refreshing: Task<Void, Never>?
    private var lastRefreshAt = Date.distantPast

    func refreshIfStale() async {
        if Date().timeIntervalSince(lastRefreshAt) < 15 { return }
        await refresh()
    }

    func refresh() async {
        if let running = refreshing { return await running.value }
        let task = Task { await self.reload() }
        refreshing = task
        await task.value
        refreshing = nil
    }

    private func reload() async {
        guard let api else { return }
        lastRefreshAt = .now
        do {
            // Una rilettura partita prima della cancellazione di un promemoria per luogo appena scattato non lo
            // deve riportare in vita (né riprogrammarne la notifica).
            items = try await api.reminders().filter { !firedPlaces.contains($0.id) }
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

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return date(iso)
    }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    // MARK: - notifiche locali e widget

    /// Riallinea notifiche, sveglie e widget (anche dopo il cambio dell'opzione «come sveglia»).
    func sync() {
        // Solo i miei: quelli messi a un familiare suonano sul suo telefono e non vanno nel widget come se fossero
        // miei (segnalazione dell'utente, 15 ott 2026: «me lo segna come per me»).
        let future = items.filter { $0.forLabel == nil }.compactMap { r -> ReminderSnapshot.Item? in
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
        let own = future
        // In fila: all'avvio arrivano insieme la rilettura e i blocchi della chat; in parallelo chiederebbero
        // il permesso più volte e potrebbero programmare due volte la stessa sveglia.
        let previous = pendingSync
        pendingSync = Task {
            await previous?.value
            // Le sveglie scelgono da sole: canale del promemoria, altrimenti l'opzione generale.
            let alarmed = await ReminderAlarms.sync(own)
            await Self.scheduleLocalNotifications(own.filter { !alarmed.contains($0.id) })
            await self.syncPlaces()
        }
    }

    // MARK: - promemoria legati a un luogo

    /// Identificativo della notifica di posizione: cambia se cambia la zona (luogo spostato sulla mappa o raggio).
    private static func placeRequestId(_ r: ReminderItem) -> String? {
        guard let p = r.place, let lat = p.lat, let lng = p.lng else { return nil }
        return String(format: "place-%@-%.5f-%.5f-%.0f-%@", r.id, lat, lng, p.radius ?? 150, p.on)
    }

    /// Notifiche di posizione dei miei promemoria per luogo: cerca le coordinate che mancano (dall'indirizzo, sul
    /// telefono) e le salva nella scheda, toglie dal server quelli scattati, programma i nuovi.
    private func syncPlaces() async {
        let center = UNUserNotificationCenter.current()
        let mine = {
            self.items.filter {
                $0.place != nil && $0.forLabel == nil && $0.status == "scheduled" && !self.firedPlaces.contains($0.id)
            }
        }
        for r in mine() {
            guard let place = r.place, !place.located, let address = place.address, let placeId = place.placeId,
                  !geocoded.contains(address) else { continue }
            geocoded.insert(address)
            guard let coordinate = await Self.geocode(address) else { continue }
            setCoordinates(placeId: placeId, coordinate)
            _ = try? await api?.setPlaceCoordinates(id: placeId, lat: coordinate.latitude, lng: coordinate.longitude)
        }
        let current = mine()
        if current.contains(where: { $0.place?.located == true }) { PlacePermission.requestIfNeeded() }
        let pending = Set(await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix("place-") })
        var wanted: [String: ReminderItem] = [:]
        for r in current { if let id = Self.placeRequestId(r) { wanted[id] = r } }
        // Di troppo (annullati, luogo spostato): li togliamo noi, quindi non contano come scattati.
        let stale = pending.subtracting(wanted.keys)
        if !stale.isEmpty {
            center.removePendingNotificationRequests(withIdentifiers: Array(stale))
            armedPlaces.subtract(stale)
        }
        // Scattati: programmati qui, non più in attesa, stessa zona; i ripetuti restano.
        for id in armedPlaces where !pending.contains(id) {
            armedPlaces.remove(id)
            guard let r = wanted[id], r.place?.repeats != true else { continue }
            wanted[id] = nil
            firedPlaces.insert(r.id)
            items.removeAll { $0.id == r.id }
            try? await api?.deleteReminder(id: r.id)
        }
        for (id, r) in wanted where !pending.contains(id) {
            guard let place = r.place, let lat = place.lat, let lng = place.lng else { continue }
            let maxRadius = CLLocationManager().maximumRegionMonitoringDistance
            let radius = min(max(place.radius ?? 150, 100), maxRadius > 0 ? maxRadius : 1000)
            let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: lat, longitude: lng), radius: radius, identifier: id)
            region.notifyOnEntry = !place.leaving
            region.notifyOnExit = place.leaving
            let content = UNMutableNotificationContent()
            content.title = place.notificationTitle
            content.body = r.text
            content.sound = .default
            content.threadIdentifier = "reminders"
            content.interruptionLevel = .timeSensitive
            content.userInfo = ["reminderId": r.id]
            let trigger = UNLocationNotificationTrigger(region: region, repeats: place.repeats == true)
            do {
                try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
                armedPlaces.insert(id)
            } catch {
                // Senza permesso di posizione la richiesta non entra: riproviamo alla prossima sincronizzazione.
            }
        }
    }

    /// Coordinate trovate per un luogo: valgono per tutti i promemoria legati a quel luogo.
    private func setCoordinates(placeId: String, _ c: CLLocationCoordinate2D) {
        items = items.map { r in
            guard r.place?.placeId == placeId else { return r }
            var x = r
            x.place?.lat = c.latitude
            x.place?.lng = c.longitude
            return x
        }
    }

    /// Indirizzo → posizione, sul telefono (Mappe di Apple), senza servizi esterni né chiavi.
    static func geocode(_ address: String) async -> CLLocationCoordinate2D? {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = address
        request.resultTypes = [.address, .pointOfInterest]
        guard let response = try? await MKLocalSearch(request: request).start(),
              let item = response.mapItems.first else { return nil }
        return item.location.coordinate
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
