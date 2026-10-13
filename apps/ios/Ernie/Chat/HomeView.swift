import SwiftUI

/// Schermata «Oggi» (bozzetto 1, approvato dall'utente): quando la conversazione è vuota l'app accoglie invece di
/// aspettare. Orso grande con lo stato, saluto con il nome, i prossimi promemoria, scorciatoie alle sezioni e
/// suggerimenti toccabili. Al primo messaggio lascia il posto alla conversazione.
struct HomeView: View {
    let conversation: ConversationStore
    let onOpen: (PanelDestination) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                hero
                greeting
                todayCards
                shortcuts
                suggestions
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .task { await model.reminders.refresh() }
    }

    // MARK: orso e saluto

    private var hero: some View {
        VStack(spacing: 10) {
            AvatarBubble(
                state: conversation.agentState,
                emotion: conversation.lastAvatarEmotion,
                mouthOpen: model.speaker.mouthOpen,
                size: 112
            )
            HStack(spacing: 6) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                Text(statusText)
            }
            .font(.footnote)
            .foregroundStyle(Theme.inkSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.surface.opacity(0.85), in: Capsule())
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        AvatarCaption.text(connection: conversation.connection, state: conversation.agentState) ?? "Pronto ad ascoltarti"
    }

    private var statusColor: Color {
        switch conversation.connection {
        case .connected: conversation.agentState == .listening ? .red : Theme.positive
        case .connecting, .reconnecting: .orange
        case .disconnected: .gray
        }
    }

    private var greeting: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Self.salutation(for: .now, name: model.profile?.displayName))
                .font(Theme.title(30))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text("\(Self.dayLine(.now)) · ecco cosa ti aspetta")
                .font(.subheadline)
                .foregroundStyle(Theme.inkSecondary)
        }
        .padding(.horizontal, 4)
    }

    /// «Buongiorno» fino alle 13, «Buon pomeriggio» fino alle 18, poi «Buonasera»; con il nome se c'è.
    static func salutation(for date: Date, name: String?) -> String {
        let hour = Calendar.current.component(.hour, from: date)
        let word = hour < 5 ? "Buonasera" : hour < 13 ? "Buongiorno" : hour < 18 ? "Buon pomeriggio" : "Buonasera"
        let first = name?.split(separator: " ").first.map(String.init)
        return first.map { "\(word), \($0)" } ?? word
    }

    /// «Martedì 13 ottobre».
    static func dayLine(_ date: Date) -> String {
        let s = date.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(Locale(identifier: "it_IT")))
        return s.prefix(1).uppercased() + s.dropFirst()
    }

    // MARK: schede del giorno

    private var upcoming: [(item: ReminderItem, date: Date)] {
        model.reminders.items
            .filter { $0.status == "scheduled" }
            .compactMap { r in Self.parse(r.at).map { (r, $0) } }
            .sorted { $0.1 < $1.1 }
            .prefix(2)
            .map { (item: $0.0, date: $0.1) }
    }

    @ViewBuilder
    private var todayCards: some View {
        let list = upcoming
        VStack(spacing: 10) {
            if list.isEmpty {
                todayRow(
                    eyebrow: "Promemoria",
                    title: "Nessun promemoria in arrivo",
                    detail: "Di’ «ricordami di…» e ci penso io",
                    tint: .reminders,
                    icon: "bell.fill"
                )
            } else {
                ForEach(Array(list.enumerated()), id: \.element.item.id) { index, entry in
                    todayRow(
                        eyebrow: index == 0 ? "Prossimo promemoria" : "In programma",
                        title: entry.item.text,
                        detail: Self.when(entry.date, repeatLabel: entry.item.repeatInfo?.label),
                        tint: index == 0 ? .reminders : .brain,
                        icon: index == 0 ? "alarm.fill" : "calendar"
                    )
                }
            }
        }
    }

    private func todayRow(eyebrow: String, title: String, detail: String, tint: SkillTint, icon: String) -> some View {
        Button { onOpen(.reminders) } label: {
            HStack(spacing: 12) {
                SkillIcon(systemName: icon, tint: tint, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(eyebrow.uppercased())
                        .font(Theme.eyebrow)
                        .kerning(0.3)
                        .foregroundStyle(tint.color)
                    Text(title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(Theme.inkSecondary)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.inkSecondary.opacity(0.7))
            }
            .padding(14)
            .ernieSurface(radius: 20)
        }
        .buttonStyle(.plain)
        .accessibilityHint("Apre i promemoria")
    }

    static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// «Oggi alle 18:30», «Domani alle 9», «Venerdì alle 9 · ogni venerdì alle 9», «2 novembre alle 9».
    static func when(_ date: Date, repeatLabel: String?) -> String {
        let cal = Calendar.current
        let it = Locale(identifier: "it_IT")
        let minute = cal.component(.minute, from: date)
        let time = minute == 0 ? "\(cal.component(.hour, from: date))" : date.formatted(.dateTime.hour().minute().locale(it))
        let day: String
        if cal.isDateInToday(date) { day = "Oggi" }
        else if cal.isDateInTomorrow(date) { day = "Domani" }
        else if let days = cal.dateComponents([.day], from: cal.startOfDay(for: .now), to: cal.startOfDay(for: date)).day, days < 7 {
            let w = date.formatted(.dateTime.weekday(.wide).locale(it))
            day = w.prefix(1).uppercased() + w.dropFirst()
        } else {
            day = date.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(it)).capitalizedFirst
        }
        // Ricorrente: la frase della ricorrenza dice già giorno e ora («Ogni venerdì alle 9»).
        if let repeatLabel { return repeatLabel.capitalizedFirst }
        return "\(day) alle \(time)"
    }

    // MARK: scorciatoie e suggerimenti

    private var shortcuts: some View {
        HStack(spacing: 8) {
            shortcut("Second brain", icon: "brain.head.profile", tint: .brain, to: .brain)
            shortcut("Promemoria", icon: "bell.fill", tint: .reminders, to: .reminders)
            shortcut("Famiglia", icon: "person.2.fill", tint: .sentinels, to: .family)
            shortcut("Skill", icon: "sparkle", tint: .documents, to: .skills)
        }
    }

    private func shortcut(_ title: String, icon: String, tint: SkillTint, to destination: PanelDestination) -> some View {
        Button { onOpen(destination) } label: {
            VStack(spacing: 6) {
                SkillIcon(systemName: icon, tint: tint, size: 36)
                Text(title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(Theme.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    /// Suggerimenti: le domande complete partono subito, gli inizi di frase vanno nel campo da completare.
    private var suggestions: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                suggestion("Cosa ho in programma?", send: true)
                suggestion("Annota che ", label: "Annota un’idea", send: false)
                suggestion("Ricordami di ", label: "Ricordami di…", send: false)
                suggestion("Cosa sai di me?", send: true)
            }
            .padding(.horizontal, 16)
        }
        .scrollIndicators(.hidden)
        .padding(.horizontal, -16)
    }

    private func suggestion(_ text: String, label: String? = nil, send: Bool) -> some View {
        Button {
            if send { conversation.send(text, inputMode: "text") } else { conversation.composerSuggestion = text }
        } label: {
            ErnieChip(text: label ?? text, style: .suggestion)
        }
        .buttonStyle(.plain)
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
