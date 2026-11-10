import SwiftUI

/// Solo presentazione: la timeline usa due istanti espliciti, mai date ricavate dal titolo.
@MainActor enum ReminderCardPresentation {
    static func eventDate(_ item: ReminderItem) -> Date? {
        guard item.place == nil, let at = ReminderStore.date(item.at),
              let event = ReminderStore.date(item.eventAt), event > at else { return nil }
        return event
    }

    static func status(_ item: ReminderItem) -> (title: String, symbol: String) {
        switch item.status {
        case "scheduled": ("Attivo", "checkmark")
        case "done": ("Scattato", "bell.badge")
        case "cancelled": ("Annullato", "xmark")
        default: ("Da verificare", "questionmark")
        }
    }

    static func day(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Oggi" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now),
           calendar.isDate(date, inSameDayAs: tomorrow) { return "Domani" }
        return date.formatted(.dateTime.weekday(.wide).locale(Locale(identifier: "it_IT"))).capitalized
    }

    static func fullDate(_ date: Date) -> String {
        let text = date.formatted(.dateTime.weekday(.wide).day().month(.wide).year().locale(Locale(identifier: "it_IT")))
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    static func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Locale(identifier: "it_IT")))
    }
}

/// Superficie condivisa da chat e raccolta. I canali sono stato; l'editor contiene i comandi.
struct ReminderCardView: View {
    let item: ReminderItem
    var defaultAlarm = true
    var onEdit: () -> Void = {}
    var onCancel: () -> Void = {}
    @Environment(\.chatPalette) private var palette
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorSchemeContrast) private var contrast
    @ScaledMetric(relativeTo: .title2) private var titleSize = 22
    @ScaledMetric(relativeTo: .largeTitle) private var timeSize = 30
    @State private var confirmingCancel = false

    private var scheduled: Bool { item.status == "scheduled" }
    private var status: (title: String, symbol: String) { ReminderCardPresentation.status(item) }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: 22, style: .continuous) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            Text(item.text)
                .font(.system(size: titleSize, weight: .semibold, design: palette.terminal ? .monospaced : .default))
                .foregroundStyle(scheduled ? palette.ink : palette.inkSecondary)
                .strikethrough(item.status == "cancelled")
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            timing
            if let recipient = item.forLabel {
                Label("Per \(recipient) · sul suo telefono", systemImage: "person")
                    .font(.subheadline).foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let sender = item.fromLabel {
                Label("Da \(sender)", systemImage: "person")
                    .font(.subheadline).foregroundStyle(palette.inkSecondary)
            }
            if let repeatInfo = item.repeatInfo {
                Label(repeatInfo.label, systemImage: "repeat")
                    .font(.subheadline).foregroundStyle(palette.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if item.location != nil || item.meetingURL != nil || item.notes != nil {
                ReminderDetailsView(item: item)
            }
            if scheduled {
                Rectangle().fill(palette.hairline).frame(height: 1).accessibilityHidden(true)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { channels; Spacer(minLength: 0); editButton }
                    VStack(alignment: .leading, spacing: 14) { channels; editButton }
                }
            }
        }
        .fontDesign(palette.terminal ? .monospaced : .default)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: shape)
        .overlay(shape.strokeBorder(palette.hairline, lineWidth: contrast == .increased ? 2 : 1))
        .confirmationDialog("Annullare il promemoria?", isPresented: $confirmingCancel, titleVisibility: .visible) {
            Button("Annulla promemoria", role: .destructive, action: onCancel)
            Button("Mantieni", role: .cancel) {}
        } message: {
            Text(item.repeatInfo != nil || item.place?.repeats == true
                 ? "Non riceverai più gli avvisi di questo promemoria ricorrente."
                 : "Non riceverai più l’avviso per «\(item.text)».")
        }
    }

    @ViewBuilder private var header: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
                kind
                HStack { stateBadge; Spacer(minLength: 0); if scheduled { moreMenu } }
            }
        } else {
            HStack(alignment: .top, spacing: 6) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { kind; Spacer(minLength: 4); stateBadge }
                    VStack(alignment: .leading, spacing: 8) { kind; stateBadge }
                }
                if scheduled { moreMenu.padding(.trailing, -10).padding(.vertical, -10) }
            }
        }
    }

    private var moreMenu: some View {
        Menu {
            Button("Modifica dettagli", systemImage: "pencil", action: onEdit)
            Button("Annulla promemoria", systemImage: "xmark.circle", role: .destructive) { confirmingCancel = true }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
                .foregroundStyle(palette.inkSecondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Altre azioni del promemoria")
    }

    private var kind: some View {
        Label(typeSize.isAccessibilitySize ? "Promemoria" : "PROMEMORIA", systemImage: "bell")
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.inkSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var stateBadge: some View {
        Label(status.title, systemImage: status.symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(scheduled ? palette.accentText : palette.inkSecondary)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(scheduled ? palette.accentSoft : palette.surfaceMuted,
                        in: RoundedRectangle(cornerRadius: 7))
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private var timing: some View {
        if let place = item.place {
            VStack(alignment: .leading, spacing: 10) {
                Label(place.phrase.prefix(1).uppercased() + place.phrase.dropFirst(),
                      systemImage: place.leaving ? "figure.walk.departure" : "mappin.and.ellipse")
                    .font(.headline).foregroundStyle(palette.accentText)
                    .fixedSize(horizontal: false, vertical: true)
                if scheduled, let line = RemindersCard.placeLine(place) {
                    Label(line.text, systemImage: line.symbol)
                        .font(.caption).foregroundStyle(palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if let at = ReminderStore.date(item.at) {
            if let event = ReminderCardPresentation.eventDate(item) {
                VStack(alignment: .leading, spacing: 0) {
                    timelineStep(at, label: "Avviso", filled: true, continues: true)
                    timelineStep(event, label: "Appuntamento", filled: false, continues: false)
                }
                .accessibilityIdentifier("reminder.two-moments")
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 14) { hour(at); date(at) }
                    VStack(alignment: .leading, spacing: 8) { hour(at); date(at) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Avviso: \(ReminderCardPresentation.fullDate(at)), ore \(ReminderCardPresentation.time(at))")
            }
        } else {
            Label("Orario non disponibile", systemImage: "clock.badge.questionmark")
                .font(.subheadline).foregroundStyle(palette.inkSecondary)
        }
    }

    private func hour(_ value: Date) -> some View {
        Text(ReminderCardPresentation.time(value))
            .font(.system(size: timeSize, weight: .semibold, design: palette.terminal ? .monospaced : .default))
            .monospacedDigit().foregroundStyle(palette.accentText)
            .fixedSize()
    }

    private func date(_ value: Date) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ReminderCardPresentation.day(value)).font(.subheadline.weight(.semibold))
            Text(ReminderCardPresentation.fullDate(value)).font(.caption)
        }
        .foregroundStyle(palette.accentText)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func timelineStep(_ value: Date, label: String, filled: Bool, continues: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 4) {
                Circle().fill(filled ? palette.accentText : palette.surface)
                    .frame(width: 10, height: 10)
                    .overlay(Circle().strokeBorder(palette.accentText, lineWidth: 1))
                if continues { Rectangle().fill(palette.hairline).frame(width: 1) }
            }
            .frame(width: 12).padding(.top, 5).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(ReminderCardPresentation.fullDate(value)) · \(ReminderCardPresentation.time(value))")
                    .font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                Text(label).font(.caption).foregroundStyle(palette.inkSecondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, continues ? 18 : 0)
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(ReminderCardPresentation.fullDate(value)), ore \(ReminderCardPresentation.time(value))")
    }

    private var channels: some View {
        VStack(alignment: .leading, spacing: 5) {
            if item.place != nil {
                Label("Notifica sul telefono", systemImage: "location")
            } else {
                if item.forLabel == nil {
                    Label((item.channels?.alarm ?? defaultAlarm) ? "Sveglia attiva" : "Sveglia disattivata", systemImage: "alarm")
                }
                Label(item.channels?.email == true ? "Email attiva" : "Email disattivata", systemImage: "envelope")
            }
        }
        .font(.caption).foregroundStyle(palette.inkSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var editButton: some View {
        Button("Modifica", systemImage: "pencil", action: onEdit)
            .buttonStyle(ReminderEditButtonStyle())
            .accessibilityHint("Modifica testo, orario, dettagli e modalità di avviso")
    }
}

private struct ReminderEditButtonStyle: ButtonStyle {
    @Environment(\.chatPalette) private var palette
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.subheadline.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(minWidth: 44, minHeight: 44)
            .foregroundStyle(palette.accentText)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(palette.hairline))
            .contentShape(RoundedRectangle(cornerRadius: 11))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// Un editor per chat e raccolta: i canali restano collegati allo store anche se cambia l'id.
struct ReminderEditorSheet: View {
    let item: ReminderItem
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatPalette) private var palette
    private var current: ReminderItem { model.reminders.item(item.id) ?? item }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if current.place == nil {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Modalità di avviso").font(.headline)
                            ReminderChannelSettings(item: current)
                            Text("Le modalità di avviso si aggiornano subito.")
                                .font(.caption).foregroundStyle(palette.inkSecondary)
                        }
                    }
                    ReminderEditForm(item: current) { dismiss() }
                    if let error = model.reminders.lastError {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
                .foregroundStyle(palette.ink)
                .fontDesign(palette.terminal ? .monospaced : .default)
                .padding(20)
            }
            .background(palette.ground)
            .navigationTitle("Modifica promemoria")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
        }
        .tint(palette.accentText)
        .preferredColorScheme(palette.terminal ? .dark : nil)
        .presentationDetents([.large])
    }
}
