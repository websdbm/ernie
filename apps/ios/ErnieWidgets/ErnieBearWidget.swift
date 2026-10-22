import AppIntents
import SwiftUI
import WidgetKit

/// Widget dell'orso (richiesta dell'utente, 15 ott 2026). In Home: piccolo (solo l'orso), medio (orso con «Parla» e
/// «Scrivi»), grande (anche impegni, automazioni e attività). Sulla schermata di blocco: circolare (l'orso) e
/// rettangolare (orso e azione). I widget non possono riprodurre animazioni continue: l'orso cambia espressione nel
/// corso della giornata (voci della timeline con transizione), dorme di notte o quando Ernie è in pausa e si stupisce
/// prima di un promemoria. Le aree informative aprono la propria scheda; il tocco sull’orso mantiene la modalità configurata.

// MARK: - Configurazione e interazioni

/// Modalità in cui il tocco apre Ernie (decisione dell'utente, 15 ott 2026: «tap = apertura app nella modalità scelta
/// nelle configurazioni»; niente carezza all'orso).
enum ErnieTapAction: String, AppEnum {
    case voice, chat

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Al tocco"
    static let caseDisplayRepresentations: [ErnieTapAction: DisplayRepresentation] = [
        .voice: "Parla con Ernie",
        .chat: "Apri la chat",
    ]

    var url: URL { (self == .voice ? AppLink.voice : .chat).url }
}

struct ErnieWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Ernie"
    static let description = IntentDescription("Cosa fa il widget quando lo tocchi.")

    @Parameter(title: "Al tocco", default: .voice)
    var tap: ErnieTapAction

    init() {}
}

// MARK: - Timeline

struct ErnieEntry: TimelineEntry {
    let date: Date
    let frame: Int
    let badge: String?
    let summary: ErnieSummary?
    /// Prossimi promemoria: dal server, altrimenti dall'istantanea scritta dall'app.
    let reminders: [ErnieSummary.Reminder]
    let tap: ErnieTapAction
    let signedIn: Bool

    static let sample = ErnieEntry(
        date: .now,
        frame: 12,
        badge: nil,
        summary: ErnieSummary(
            generatedAt: .now,
            status: .init(paused: false, proactive: true, unread: 0),
            reminders: [],
            automations: [
                .init(id: "a", title: "Prezzo dei voli", kind: "sentinella", nextAt: .now.addingTimeInterval(5400), paused: false),
                .init(id: "b", title: "Lista della spesa del sabato", kind: "automazione", nextAt: .now.addingTimeInterval(86_400 * 2), paused: false),
            ],
            activity: .init(title: "Prezzo dei voli", status: "succeeded", at: .now.addingTimeInterval(-1800), quiet: true),
            counts: .init(reminders: 2, automations: 2)
        ),
        reminders: [
            .init(id: "1", text: "Chiamare il dentista", at: .now.addingTimeInterval(3600)),
            .init(id: "2", text: "Riunione", at: .now.addingTimeInterval(7200), eventAt: .now.addingTimeInterval(9000)),
        ],
        tap: .voice,
        signedIn: true
    )
}

enum BearFrames {
    /// Notte: dalle 23 alle 7 l'orso dorme.
    static func isNight(_ date: Date) -> Bool {
        let h = Calendar.current.component(.hour, from: date)
        return h >= 23 || h < 7
    }

    /// Espressione a un certo istante: dorme di notte o in pausa, si stupisce prima di un promemoria, altrimenti
    /// alterna neutro, respiro e inclinazioni ogni cinque minuti.
    static func frame(at date: Date, nextReminder: Date?, paused: Bool) -> (Int, String?) {
        if paused || isNight(date) {
            // Appena scesa la notte uno sbadiglio, poi occhi chiusi.
            let h = Calendar.current.component(.hour, from: date)
            let m = Calendar.current.component(.minute, from: date)
            return (h == 23 && m < 10 ? 28 : 3, "z")
        }
        if let next = nextReminder, next > date, next.timeIntervalSince(date) <= 15 * 60 { return (13, "!") }
        // Più varietà (15 ott 2026): fra neutro e inclinazioni anche occhiali da sole, aria fiera, entusiasmo.
        let cycle = [0, 1, 4, 16, 0, 5, 29, 1, 0, 6, 19, 0, 17, 1, 31, 0]
        let step = Int(date.timeIntervalSinceReferenceDate / 300) % cycle.count
        return (cycle[step], nil)
    }
}

struct ErnieProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ErnieEntry { .sample }

    func snapshot(for configuration: ErnieWidgetIntent, in context: Context) async -> ErnieEntry {
        if context.isPreview { return .sample }
        return entries(now: .now, summary: ErnieSummary.cached(), tap: configuration.tap).first ?? .sample
    }

    func timeline(for configuration: ErnieWidgetIntent, in context: Context) async -> Timeline<ErnieEntry> {
        let now = Date.now
        let cached = ErnieSummary.cached()
        let fresh = cached.map { now.timeIntervalSince($0.generatedAt) < 120 } ?? false
        let summary = fresh ? cached : (await ErnieSummary.fetch() ?? cached)
        let list = entries(now: now, summary: summary, tap: configuration.tap)
        return Timeline(entries: list, policy: .after(now.addingTimeInterval(30 * 60)))
    }

    /// Una voce adesso e una ogni cinque minuti per un'ora: l'orso cambia espressione anche senza ricaricare.
    private func entries(now: Date, summary: ErnieSummary?, tap: ErnieTapAction) -> [ErnieEntry] {
        let reminders = summary?.reminders ?? ReminderSnapshot.load(now: now).items.prefix(4).map {
            ErnieSummary.Reminder(id: $0.id, text: $0.text, at: $0.at, eventAt: nil, from: $0.from)
        }
        let signedIn = ErnieSummary.signedIn
        let start = Date(timeIntervalSinceReferenceDate: (now.timeIntervalSinceReferenceDate / 300).rounded(.down) * 300)
        return (0...12).map { i in
            let date = i == 0 ? now : start.addingTimeInterval(Double(i) * 300)
            let upcoming = reminders.filter { $0.at > date.addingTimeInterval(-60) }
            let (frame, badge) = BearFrames.frame(at: date, nextReminder: upcoming.first?.at, paused: summary?.status.paused ?? false)
            return ErnieEntry(date: date, frame: frame, badge: badge, summary: summary, reminders: upcoming, tap: tap, signedIn: signedIn)
        }
    }
}

// MARK: - Viste

/// Colori dei widget in Home: viola notte dell'app, testo chiaro.
enum ErnieWidgetStyle {
    static let top = Color(red: 0.16, green: 0.10, blue: 0.36)
    static let bottom = Color(red: 0.33, green: 0.22, blue: 0.75)
    static let ink = Color.white
    static let inkSecondary = Color.white.opacity(0.72)
    static let card = Color.white.opacity(0.12)

    static var background: some View {
        LinearGradient(colors: [top, bottom], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// L'orso in pixel art (stesso disegno dell'app), ritagliato nel cerchio, con il segno («z», «!», cuore).
struct WidgetBear: View {
    let frame: Int
    let badge: String?
    let size: CGFloat
    var ring = true
    /// Schermata di blocco: l'orso senza il fondo viola (iOS lo disegna in tinta unica, il fondo diventerebbe un disco).
    var mono = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            let selection = BearWidgetArtwork.selection(legacyFrame: frame)
            let monochrome = mono ? BearAtlas.cell(costume: "mono", index: selection.index) : nil
            let image = monochrome ?? BearAtlas.cell(costume: selection.costume, index: selection.index)
            if let monochrome {
                BearPortraitArtwork(image: monochrome,
                                    baseline: BearAtlas.portraitBaseline(costume: "mono", index: selection.index, image: monochrome),
                                    size: size, monochrome: true)
                    .widgetAccentable()
                    .id(frame)
                    .transition(.scale(scale: 0.92).combined(with: .opacity))
            } else if let image {
                BearPortraitArtwork(image: image,
                                    baseline: BearAtlas.portraitBaseline(costume: selection.costume, index: selection.index, image: image),
                                    size: size)
                    .overlay {
                        if ring && !mono { Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: max(1, size / 60)) }
                    }
                    .id(frame)
                    .transition(.scale(scale: 0.92).combined(with: .opacity))
            } else if let fallback = BearAtlas.fallback {
                Image(uiImage: fallback).resizable().interpolation(.none)
                    .widgetAccentedRenderingMode(.fullColor)
                    .scaledToFit().frame(width: size, height: size).clipShape(Circle())
            }
            if let badge {
                Text(badge)
                    .font(.system(size: max(10, size * 0.2), weight: .heavy, design: .rounded))
                    .foregroundStyle(badge == "!" ? Color.orange : Color.white)
                    .shadow(color: .black.opacity(0.35), radius: 1, y: 1)
                    .offset(x: -size * 0.04, y: size * 0.02)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Ernie, l'orso")
    }
}

struct ErnieBearWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ErnieEntry

    var body: some View {
        switch family {
        case .accessoryCircular: circular
        case .accessoryRectangular: rectangular
        case .systemMedium: medium
        case .systemLarge: large
        default: small
        }
    }

    // MARK: schermata di blocco

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            WidgetBear(frame: entry.frame, badge: nil, size: 54, ring: false, mono: true)
        }
        .widgetURL(entry.tap.url)
        .containerBackground(for: .widget) { Color.clear }
    }

    private var rectangular: some View {
        HStack(spacing: 6) {
            WidgetBear(frame: entry.frame, badge: nil, size: 40, ring: false, mono: true)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 4) {
                    Text("Ernie").font(.headline).widgetAccentable()
                    Image(systemName: entry.tap == .chat ? "text.bubble.fill" : "mic.fill").font(.caption)
                }
                if let next = entry.reminders.first {
                    Text(Fmt.when(next.at)).font(.caption.weight(.semibold)).lineLimit(1)
                    Text(next.text).font(.caption).lineLimit(1)
                } else {
                    Text(entry.tap == .chat ? "Tocca e scrivi" : "Tocca e parla").font(.caption).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .widgetURL(entry.tap.url)
        .containerBackground(for: .widget) { Color.clear }
    }

    // MARK: Home

    /// L'orso: nessun pulsante sopra, il tocco apre Ernie (widgetURL) nella modalità scelta.
    private func bear(size: CGFloat) -> some View {
        WidgetBear(frame: entry.frame, badge: entry.badge, size: size)
    }

    private var small: some View {
        bear(size: 118)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .widgetURL(entry.tap.url)
            .containerBackground(for: .widget) { ErnieWidgetStyle.background }
    }

    private var medium: some View {
        HStack(spacing: 14) {
            bear(size: 112)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Fmt.greeting(entry.date)).font(.headline).foregroundStyle(ErnieWidgetStyle.ink)
                    statusLink
                }
                Spacer(minLength: 0)
                actionButtons(compact: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .widgetURL(entry.tap.url)
        .containerBackground(for: .widget) { ErnieWidgetStyle.background }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                bear(size: 64)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Fmt.greeting(entry.date)).font(.headline).foregroundStyle(ErnieWidgetStyle.ink)
                    statusLink
                }
                Spacer(minLength: 0)
            }
            actionButtons(compact: false)
            linkedSection("Prossimi impegni", systemImage: "bell.fill", destination: .reminders) {
                if entry.reminders.isEmpty {
                    emptyLine("Nessun promemoria in arrivo")
                } else {
                    ForEach(entry.reminders.prefix(3)) { r in reminderRow(r) }
                }
            }
            linkedSection("Automazioni", systemImage: "gearshape.2.fill", destination: .automations) {
                if let list = entry.summary?.automations, !list.isEmpty {
                    ForEach(list.prefix(entry.reminders.count > 2 ? 2 : 3)) { a in automationRow(a) }
                } else {
                    emptyLine(entry.summary == nil ? "Apri Ernie per aggiornare" : "Nessuna automazione attiva")
                }
            }
            Spacer(minLength: 0)
            Text(activityLine)
                .font(.caption2)
                .foregroundStyle(ErnieWidgetStyle.inkSecondary)
                .lineLimit(1)
        }
        .widgetURL(entry.tap.url)
        .containerBackground(for: .widget) { ErnieWidgetStyle.background }
    }

    // MARK: pezzi

    private func actionButtons(compact: Bool) -> some View {
        HStack(spacing: 8) {
            Link(destination: ErnieTapAction.voice.url) {
                pill("Parla", systemImage: "mic.fill", prominent: true, compact: compact)
            }
            Link(destination: ErnieTapAction.chat.url) {
                pill("Scrivi", systemImage: "text.bubble.fill", prominent: false, compact: compact)
            }
        }
    }

    private func pill(_ title: String, systemImage: String, prominent: Bool, compact: Bool) -> some View {
        ViewThatFits(in: .horizontal) {
            Label(title, systemImage: systemImage).fixedSize(horizontal: true, vertical: false)
            Image(systemName: systemImage)
        }
            .font((compact ? Font.caption : Font.subheadline).weight(.semibold))
            .lineLimit(1)
            .accessibilityLabel(title)
            .foregroundStyle(prominent ? ErnieWidgetStyle.top : ErnieWidgetStyle.ink)
            .padding(.horizontal, compact ? 10 : 14)
            .padding(.vertical, compact ? 7 : 8)
            .frame(maxWidth: .infinity)
            .background(prominent ? AnyShapeStyle(Color.white) : AnyShapeStyle(ErnieWidgetStyle.card), in: Capsule())
    }

    @ViewBuilder private var statusLink: some View {
        if !entry.reminders.isEmpty {
            Link(destination: AppLink.reminders.url) {
                Text(statusLine).font(.caption).foregroundStyle(ErnieWidgetStyle.inkSecondary)
                    .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint("Apri gli impegni")
        } else {
            Text(statusLine).font(.caption).foregroundStyle(ErnieWidgetStyle.inkSecondary).lineLimit(2)
        }
    }

    private func linkedSection<Content: View>(_ title: String, systemImage: String,
                                              destination: AppLink, @ViewBuilder content: () -> Content) -> some View {
        Link(destination: destination.url) {
            section(title, systemImage: systemImage, content: content)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 3)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Apri \(title.lowercased()) nell’app")
    }

    private func section<Content: View>(_ title: String, systemImage: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ErnieWidgetStyle.inkSecondary)
            content()
        }
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(ErnieWidgetStyle.inkSecondary)
    }

    private func reminderRow(_ r: ErnieSummary.Reminder) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Fmt.when(r.at)).font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(ErnieWidgetStyle.ink)
            VStack(alignment: .leading, spacing: 0) {
                Text(r.text).font(.caption).foregroundStyle(ErnieWidgetStyle.ink).lineLimit(1)
                let extra = [r.eventAt.map { "appuntamento alle \(Fmt.time($0))" }, r.from.map { "da \($0)" }].compactMap { $0 }
                if !extra.isEmpty {
                    Text(extra.joined(separator: " · ")).font(.caption2).foregroundStyle(ErnieWidgetStyle.inkSecondary).lineLimit(1)
                }
            }
        }
    }

    private func automationRow(_ a: ErnieSummary.Automation) -> some View {
        HStack(spacing: 8) {
            Image(systemName: a.kind == "sentinella" ? "binoculars.fill" : "clock.arrow.circlepath")
                .font(.caption2)
                .foregroundStyle(ErnieWidgetStyle.inkSecondary)
                .frame(width: 14)
            Text(a.title).font(.caption).foregroundStyle(ErnieWidgetStyle.ink).lineLimit(1)
            Spacer(minLength: 4)
            Text(a.paused ? "in pausa" : a.nextAt.map { Fmt.when($0) } ?? "su evento")
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(a.paused ? Color.orange : ErnieWidgetStyle.inkSecondary)
        }
    }

    private var statusLine: String {
        guard entry.signedIn else { return "Apri Ernie per accedere" }
        if let s = entry.summary {
            if s.status.paused { return "In pausa: l'interruttore di emergenza è acceso" }
            if s.status.unread > 0 { return s.status.unread == 1 ? "1 notifica da leggere" : "\(s.status.unread) notifiche da leggere" }
        }
        if BearFrames.isNight(entry.date) { return "Sto dormendo, ma se mi chiami ci sono" }
        if let next = entry.reminders.first { return "Prossimo: \(next.text), \(Fmt.when(next.at))" }
        return "Tutto tranquillo"
    }

    private var activityLine: String {
        guard let s = entry.summary else { return "Non ancora aggiornato" }
        let updated = "aggiornato alle \(Fmt.time(s.generatedAt))"
        guard let a = s.activity else { return updated.prefix(1).uppercased() + updated.dropFirst() }
        let outcome: String
        switch a.status {
        case "succeeded": outcome = a.quiet ? "nessuna novità" : "fatto"
        case "failed", "budget_exceeded": outcome = "non riuscito"
        case "awaiting_approval": outcome = "aspetta la tua conferma"
        case "running", "claimed": outcome = "in corso"
        default: outcome = "saltato"
        }
        return "\(a.title): \(outcome) (\(Fmt.time(a.at))) · \(updated)"
    }
}

/// Formati in italiano per i widget (lingua esplicita: l'estensione non deve dipendere dalle localizzazioni del bundle).
enum Fmt {
    private static let locale = Locale(identifier: "it_IT")

    static func time(_ d: Date) -> String { d.formatted(.dateTime.hour().minute().locale(locale)) }

    /// «14:30», «domani 9:00», «sab 8:00».
    static func when(_ d: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(d) { return time(d) }
        if cal.isDateInTomorrow(d) { return "domani \(time(d))" }
        return "\(d.formatted(.dateTime.weekday(.abbreviated).locale(locale))) \(time(d))"
    }

    static func greeting(_ d: Date) -> String {
        switch Calendar.current.component(.hour, from: d) {
        case 5..<12: "Buongiorno"
        case 12..<18: "Buon pomeriggio"
        case 18..<23: "Buonasera"
        default: "Buonanotte"
        }
    }
}

struct ErnieBearWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ErnieBear", intent: ErnieWidgetIntent.self, provider: ErnieProvider()) { entry in
            ErnieBearWidgetView(entry: entry)
        }
        .configurationDisplayName("Ernie")
        .description("Tocca l'orso per aprire Ernie in ascolto o sulla chat. Nel formato grande anche impegni, automazioni e attività.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular])
    }
}
