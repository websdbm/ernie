import AlarmKit
import Foundation

/// Metadati delle sveglie dei promemoria (AlarmKit): condivisi tra app e widget, che mostra la Live Activity
/// durante il posticipo («Posticipa» → di nuovo tra qualche minuto).
struct ReminderAlarmMetadata: AlarmMetadata {
    var reminderId: String
    var text: String
    var from: String?
}

enum ReminderAlarmConfig {
    /// Durata del posticipo.
    static let snoozeMinutes = 10
}
