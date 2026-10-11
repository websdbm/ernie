import SwiftUI
import WidgetKit

/// Widget dei promemoria (richiesta dell'utente): sulla schermata di blocco (rettangolare, in linea, circolare)
/// e in Home (piccolo, medio). Legge l'istantanea scritta dall'app nel gruppo app; la timeline cambia voce
/// quando un promemoria scatta, così resta aggiornato anche a telefono bloccato.
struct ReminderEntry: TimelineEntry {
    let date: Date
    let items: [ReminderSnapshot.Item]
}

struct ReminderProvider: TimelineProvider {
    func placeholder(in context: Context) -> ReminderEntry {
        ReminderEntry(date: .now, items: [ReminderSnapshot.Item(id: "x", text: "Uscire dal lavoro", at: .now.addingTimeInterval(3600))])
    }

    func getSnapshot(in context: Context, completion: @escaping (ReminderEntry) -> Void) {
        completion(ReminderEntry(date: .now, items: ReminderSnapshot.load().items))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ReminderEntry>) -> Void) {
        let now = Date.now
        let items = ReminderSnapshot.load(now: now).items
        // Una voce adesso e una subito dopo ogni scatto: il widget passa al promemoria successivo da solo.
        var entries: [ReminderEntry] = [ReminderEntry(date: now, items: items)]
        for item in items.prefix(8) {
            let after = item.at.addingTimeInterval(60)
            entries.append(ReminderEntry(date: after, items: items.filter { $0.at > after.addingTimeInterval(-60) }))
        }
        let refresh = items.first.map { min($0.at.addingTimeInterval(120), now.addingTimeInterval(6 * 3600)) } ?? now.addingTimeInterval(6 * 3600)
        completion(Timeline(entries: entries, policy: .after(refresh)))
    }
}

struct ReminderWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ReminderEntry

    private var upcoming: [ReminderSnapshot.Item] { entry.items.filter { $0.at > entry.date.addingTimeInterval(-60) } }

    var body: some View {
        switch family {
        case .accessoryInline:
            if let n = upcoming.first {
                Label("\(n.text) · \(time(n.at))", systemImage: "bell.fill")
            } else {
                Label("Nessun promemoria", systemImage: "bell")
            }
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Image(systemName: upcoming.isEmpty ? "bell" : "bell.fill").font(.title3)
                    if let n = upcoming.first { Text(time(n.at)).font(.caption2).monospacedDigit() }
                }
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 2) {
                if let n = upcoming.first {
                    Label(time(n.at) + (Calendar.current.isDateInToday(n.at) ? "" : " · \(day(n.at))"), systemImage: "bell.fill")
                        .font(.caption.weight(.semibold))
                    Text(n.text).font(.caption).lineLimit(2)
                    if upcoming.count > 1 { Text("+\(upcoming.count - 1) altri").font(.caption2).foregroundStyle(.secondary) }
                } else {
                    Label("Ernie", systemImage: "bell").font(.caption.weight(.semibold))
                    Text("Nessun promemoria").font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        default:
            homeView
        }
    }

    private var homeView: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label("Promemoria", systemImage: "bell.fill").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if !upcoming.isEmpty { Text("\(upcoming.count)").font(.caption2).foregroundStyle(.secondary) }
            }
            if upcoming.isEmpty {
                Text("Nessun promemoria").font(.callout).foregroundStyle(.secondary)
                Text("Di' a Ernie «ricordami di …»").font(.caption2).foregroundStyle(.tertiary)
            } else {
                ForEach(upcoming.prefix(family == .systemSmall ? 2 : 4)) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(time(item.at)).font(.caption.weight(.bold)).monospacedDigit()
                        VStack(alignment: .leading, spacing: 0) {
                            Text(item.text).font(.caption).lineLimit(family == .systemSmall ? 1 : 2)
                            if !Calendar.current.isDateInToday(item.at) { Text(day(item.at)).font(.caption2).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    private func time(_ d: Date) -> String { d.formatted(date: .omitted, time: .shortened) }
    private func day(_ d: Date) -> String {
        if Calendar.current.isDateInTomorrow(d) { return "domani" }
        return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }
}

struct ErnieReminderWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ErnieReminders", provider: ReminderProvider()) { entry in
            ReminderWidgetView(entry: entry)
        }
        .configurationDisplayName("Promemoria di Ernie")
        .description("I prossimi promemoria, anche sulla schermata di blocco.")
        .supportedFamilies([.accessoryInline, .accessoryCircular, .accessoryRectangular, .systemSmall, .systemMedium])
    }
}

@main
struct ErnieWidgetsBundle: WidgetBundle {
    var body: some Widget {
        ErnieReminderWidget()
    }
}
