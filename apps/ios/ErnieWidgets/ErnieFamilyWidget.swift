import SwiftUI
import WidgetKit

/// Widget «Messaggi» (richiesta dell'utente, 15 ott 2026: i messaggi in famiglia ben evidenti sulla schermata di
/// blocco): l'ultimo messaggio mandato o ricevuto, «da papà» / «a Giorgio», con l'ora. Lo aggiornano l'estensione
/// delle notifiche appena arriva un messaggio e l'app quando ne manda uno; ogni mezz'ora anche il server.
struct FamilyEntry: TimelineEntry {
    let date: Date
    let message: FamilyLatest?
    let signedIn: Bool
}

struct FamilyProvider: TimelineProvider {
    private static let sample = FamilyLatest(id: "x", direction: "in", label: "papà", text: "La cena è pronta, scendi!", image: false, at: .now)

    func placeholder(in context: Context) -> FamilyEntry {
        FamilyEntry(date: .now, message: Self.sample, signedIn: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (FamilyEntry) -> Void) {
        let message = FamilyLatest.load() ?? (context.isPreview ? Self.sample : nil)
        completion(FamilyEntry(date: .now, message: message, signedIn: context.isPreview || ErnieSummary.signedIn))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<FamilyEntry>) -> Void) {
        // WidgetKit chiama il completamento una volta sola, da qualsiasi thread.
        nonisolated(unsafe) let completion = completion
        Task {
            // Il server sa anche dei messaggi mandati da un altro telefono o letti altrove.
            if let f = await ErnieSummary.fetch()?.family, ErnieSummary.signedIn {
                FamilyLatest(id: f.id, direction: f.direction, label: f.label, text: f.text, image: f.image, at: f.at, urgent: f.urgent).saveIfNewer()
            }
            let entry = FamilyEntry(date: .now, message: FamilyLatest.load(), signedIn: ErnieSummary.signedIn)
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(30 * 60))))
        }
    }
}

/// Colori dei fumetti nella chat: sabbia per i ricevuti, verde acqua per i mandati.
private enum FamilyTint {
    static let received = Color(red: 0.63, green: 0.38, blue: 0.03)
    static let sent = Color(red: 0.06, green: 0.46, blue: 0.43)
    static let urgent = Color(red: 0.86, green: 0.15, blue: 0.15)
    static func of(_ m: FamilyLatest) -> Color { m.isUrgent ? urgent : m.incoming ? received : sent }
}

struct FamilyWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: FamilyEntry

    var body: some View {
        content
            .widgetURL(URL(string: "ernie://family"))
            .containerBackground(for: .widget) { background }
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryInline:
            if let m = entry.message {
                Label("\(m.label): \(m.preview)", systemImage: symbol(m))
            } else {
                Label("Nessun messaggio", systemImage: "envelope")
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                if let m = entry.message {
                    HStack(spacing: 4) {
                        Image(systemName: symbol(m))
                        Text(who(m)).lineLimit(1)
                        Spacer(minLength: 2)
                        Text(when(m.at)).foregroundStyle(.secondary)
                    }
                    .font(.caption.weight(.bold))
                    .widgetAccentable()
                    Text(m.preview)
                        .font(.caption)
                        .lineLimit(2)
                } else {
                    Label("Messaggi", systemImage: "envelope").font(.caption.weight(.bold)).widgetAccentable()
                    Text(entry.signedIn ? "Nessun messaggio dai familiari" : "Accedi a Ernie nell'app")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            homeView
        }
    }

    @ViewBuilder
    private var background: some View {
        if let m = entry.message, family == .systemSmall || family == .systemMedium {
            LinearGradient(colors: [FamilyTint.of(m).opacity(0.16), FamilyTint.of(m).opacity(0.05)], startPoint: .top, endPoint: .bottom)
                .background(Color(.systemBackground))
        } else {
            Color(.systemBackground)
        }
    }

    private var homeView: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let m = entry.message {
                HStack(spacing: 6) {
                    Image(systemName: symbol(m))
                    Text(who(m)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(.caption.weight(.bold))
                .foregroundStyle(FamilyTint.of(m))
                Text(m.preview)
                    .font(family == .systemSmall ? .subheadline.weight(.medium) : .body.weight(.medium))
                    .lineLimit(family == .systemSmall ? 4 : 3)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                HStack {
                    Text(when(m.at)).font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    if m.isUrgent {
                        Label(m.incoming ? "Conferma" : "In attesa", systemImage: m.incoming ? "checkmark.seal.fill" : "hourglass")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(FamilyTint.of(m))
                    } else if m.incoming {
                        Label("Rispondi", systemImage: "arrowshape.turn.up.left.fill")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(FamilyTint.of(m))
                    }
                }
            } else {
                Label("Messaggi", systemImage: "envelope").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                Text(entry.signedIn ? "Nessun messaggio dai familiari" : "Accedi a Ernie nell'app")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text("Di' a Ernie «scrivi a … che …»").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func who(_ m: FamilyLatest) -> String {
        let who = m.incoming ? "da \(m.label)" : "a \(m.label)"
        return m.isUrgent ? "Urgente \(who)" : who
    }

    private func symbol(_ m: FamilyLatest) -> String {
        if m.isUrgent { return "exclamationmark.triangle.fill" }
        return m.incoming ? "envelope.fill" : "paperplane.fill"
    }

    /// «21:04» oggi, «ieri», poi il giorno.
    private func when(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return d.formatted(date: .omitted, time: .shortened) }
        if cal.isDateInYesterday(d) { return "ieri" }
        return d.formatted(.dateTime.day().month(.abbreviated))
    }
}

struct ErnieFamilyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: FamilyLatest.widgetKind, provider: FamilyProvider()) { entry in
            FamilyWidgetView(entry: entry)
        }
        .configurationDisplayName("Messaggi in famiglia")
        .description("L'ultimo messaggio mandato o ricevuto, anche sulla schermata di blocco.")
        .supportedFamilies([.accessoryRectangular, .accessoryInline, .systemSmall, .systemMedium])
    }
}
