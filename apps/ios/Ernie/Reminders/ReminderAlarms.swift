import AlarmKit
import SwiftUI

/// Promemoria come sveglia (richiesta dell'utente: «troppo silenziosi»): AlarmKit suona anche con il telefono
/// in silenzioso e con la Full Immersion, a schermo intero, con «Posticipa» (di nuovo tra 10 minuti) e «Stop».
/// Se l'utente non concede il permesso o spegne l'opzione, resta la notifica locale urgente.
@MainActor
enum ReminderAlarms {
    static let defaultsKey = "reminders.alarm"

    /// Preferenza dell'utente (predefinita: attiva).
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }

    static var authorization: AlarmManager.AuthorizationState { AlarmManager.shared.authorizationState }

    /// Uscita dall'account: tutte le sveglie di Ernie, in qualsiasi stato.
    static func cancelAll() {
        let manager = AlarmManager.shared
        for alarm in (try? manager.alarms) ?? [] { try? manager.cancel(id: alarm.id) }
    }

    /// Allinea le sveglie ai promemoria futuri; restituisce gli id coperti da una sveglia (niente notifica doppia).
    /// Ogni promemoria può scegliere (v1.11): `alarm == true` suona anche con l'opzione generale spenta,
    /// `alarm == false` resta una notifica anche con l'opzione accesa.
    static func sync(_ items: [ReminderSnapshot.Item]) async -> Set<String> {
        guard !Task.isCancelled else { return [] }
        let manager = AlarmManager.shared
        let existing = (try? manager.alarms) ?? []
        let ringing = items.filter { $0.alarm ?? enabled }
        if ringing.isEmpty {
            for alarm in existing where alarm.state == .scheduled { try? manager.cancel(id: alarm.id) }
            return []
        }
        var state = manager.authorizationState
        if state == .notDetermined {
            state = (try? await manager.requestAuthorization()) ?? .denied
        }
        guard !Task.isCancelled, state == .authorized else { return [] }

        var wanted: [UUID: ReminderSnapshot.Item] = [:]
        for item in ringing { if let id = UUID(uuidString: item.id) { wanted[id] = item } }
        // Solo quelle ancora in attesa: una sveglia che sta suonando o è posticipata non si tocca.
        for alarm in existing where alarm.state == .scheduled && wanted[alarm.id] == nil {
            try? manager.cancel(id: alarm.id)
        }
        let placed = Set(existing.map(\.id))
        var covered: Set<String> = []
        for (id, item) in wanted {
            guard !Task.isCancelled else { return covered }
            if placed.contains(id) { covered.insert(item.id); continue }
            do {
                _ = try await manager.schedule(id: id, configuration: configuration(item))
                guard !Task.isCancelled else { try? manager.cancel(id: id); return covered }
                covered.insert(item.id)
            } catch {
                continue // limite raggiunto o errore: resta la notifica locale
            }
        }
        return covered
    }

    nonisolated private static func configuration(_ item: ReminderSnapshot.Item) -> AlarmManager.AlarmConfiguration<ReminderAlarmMetadata> {
        let title = item.from.map { "\(item.text) · da \($0)" } ?? item.text
        let snooze = AlarmButton(text: "Posticipa", textColor: .white, systemImageName: "zzz")
        let alert: AlarmPresentation.Alert
        if #available(iOS 26.1, *) {
            alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title), secondaryButton: snooze, secondaryButtonBehavior: .countdown)
        } else {
            alert = AlarmPresentation.Alert(
                title: LocalizedStringResource(stringLiteral: title),
                stopButton: AlarmButton(text: "Stop", textColor: .white, systemImageName: "stop.circle"),
                secondaryButton: snooze,
                secondaryButtonBehavior: .countdown
            )
        }
        let presentation = AlarmPresentation(
            alert: alert,
            countdown: AlarmPresentation.Countdown(title: "Posticipato"),
            paused: nil
        )
        let attributes = AlarmAttributes(
            presentation: presentation,
            metadata: ReminderAlarmMetadata(reminderId: item.id, text: item.text, from: item.from),
            tintColor: .orange
        )
        return AlarmManager.AlarmConfiguration(
            countdownDuration: Alarm.CountdownDuration(preAlert: nil, postAlert: TimeInterval(ReminderAlarmConfig.snoozeMinutes * 60)),
            schedule: schedule(for: item),
            attributes: attributes
        )
    }

    /// Ricorrenti settimanali e giornalieri: sveglia ricorrente di sistema (suona ogni settimana anche senza
    /// aprire l'app); gli altri: l'istante preciso.
    nonisolated static func schedule(for item: ReminderSnapshot.Item) -> Alarm.Schedule {
        guard let days = item.weekdays, !days.isEmpty, let hour = item.hour, let minute = item.minute else {
            return .fixed(item.at)
        }
        let names: [Locale.Weekday] = [.sunday, .monday, .tuesday, .wednesday, .thursday, .friday, .saturday]
        let weekdays = days.compactMap { $0 >= 0 && $0 < names.count ? names[$0] : nil }
        return .relative(.init(time: .init(hour: hour, minute: minute), repeats: .weekly(weekdays)))
    }
}
