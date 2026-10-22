import SwiftUI

struct BrainModePicker: View {
    @Binding var mode: BrainViewMode
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var body: some View {
        if dynamicTypeSize >= .xxLarge {
            Picker("Vista", selection: $mode) {
                ForEach(BrainViewMode.allCases) { Text($0.label).tag($0) }
            }.pickerStyle(.menu)
        } else {
            Picker("Vista", selection: $mode) {
                ForEach(BrainViewMode.allCases) { Text($0.label).tag($0) }
            }.pickerStyle(.segmented).labelsHidden()
        }
    }
}

struct BrainDirectorySections: View {
    let directory: BrainDirectory
    var searching = false
    var category: (String) -> Void
    var body: some View {
        Section {
            Text(searching ? "\(directory.total) risultati visualizzati" : "\(directory.total) schede nel Second brain")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
            if directory.truncated {
                Text(searching
                     ? "Sono visibili al massimo 200 risultati. Restringi la ricerca per trovare le altre schede."
                     : "L’indice mostra fino a 100 schede per categoria. Apri una categoria o cerca per trovare le altre.")
                    .font(.footnote).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        ForEach(directory.alphabeticalGroups) { group in
            Section {
                ForEach(group.alphabeticalNotes) { note in
                    NavigationLink(value: BrainDestination.path(note.path)) {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: BrainType.icon(note.type)).foregroundStyle(Theme.accentText)
                                .frame(width: 24).accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(note.title).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                if note.private { Label("Riservata", systemImage: "lock").font(.caption).foregroundStyle(Theme.inkSecondary) }
                            }
                        }.padding(.vertical, 3)
                    }
                }
                if group.count > group.notes.count {
                    Button("Apri tutte le \(group.count) schede") { category(group.type) }
                        .frame(minHeight: 44, alignment: .leading)
                }
            } header: {
                Button { category(group.type) } label: {
                    HStack {
                        Text(group.label).textCase(nil)
                        Spacer()
                        Text("\(group.count)")
                        Image(systemName: "chevron.right").font(.caption)
                    }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                }.buttonStyle(.plain).accessibilityLabel("\(group.label), \(group.count) schede. Apri categoria")
            }
        }
    }
}

struct BrainKnowledgeContent: View {
    let knowledge: BrainKnowledge
    var openAgenda: (() -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if !knowledge.facts.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Informazioni raccolte").font(.headline).accessibilityAddTraits(.isHeader)
                    ForEach(knowledge.facts) { fact in
                        BrainFactCard(fact: fact)
                    }
                }
            }
            if !knowledge.routines.isEmpty {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Orari abituali").font(.headline).accessibilityAddTraits(.isHeader)
                    Text("Orari consultabili, senza notifiche. Il rientro è previsto, non una posizione verificata.")
                        .font(.footnote).foregroundStyle(Theme.inkSecondary).fixedSize(horizontal: false, vertical: true)
                    if let openAgenda {
                        Button("Consulta per data", systemImage: "calendar") { openAgenda() }
                            .frame(minHeight: 44, alignment: .leading).buttonStyle(.bordered)
                    }
                    ForEach(knowledge.routines) { routine in
                        BrainRoutineCard(routine: routine)
                        if routine.id != knowledge.routines.last?.id { Divider() }
                    }
                }
            }
            Text("Per aggiornare fatti e orari, chiedilo a Ernie in chat.")
                .font(.footnote).foregroundStyle(Theme.inkSecondary)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct BrainFactCard: View {
    let fact: BrainFact
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(fact.label).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
            Text(Markdown.render(BrainFormat.linkify(fact.value))).font(.body).foregroundStyle(Theme.ink)
            Label(fact.statusLabel, systemImage: fact.status == "confirmed" ? "checkmark.seal" : "questionmark.circle")
                .font(.caption.weight(.medium)).foregroundStyle(Theme.inkSecondary)
            if let validity = fact.validityLabel(on: BrainAgendaQuery.day(Date(), timeZone: TimeZone.current.identifier)) {
                Label(validity, systemImage: "calendar.badge.exclamationmark").font(.caption.weight(.semibold))
            }
            BrainFactValidity(from: fact.validFrom, until: fact.validUntil)
            if let evidence = fact.evidence { BrainFactSource(evidence: evidence) }
            else { Text("Fonte non registrata").font(.caption).foregroundStyle(Theme.inkSecondary) }
            Text("Aggiornato \(BrainFormat.when(created: fact.updatedAt, from: nil, to: nil))")
                .font(.caption).foregroundStyle(Theme.inkSecondary)
            if let history = fact.history, !history.isEmpty {
                DisclosureGroup("Versioni precedenti (\(history.count))") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(history.enumerated().reversed()), id: \.offset) { _, revision in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(revision.label): \(revision.value)").font(.subheadline)
                                Text("Versione precedente · \(BrainFactPresentation.status(revision.status))")
                                    .font(.caption).foregroundStyle(Theme.inkSecondary)
                                BrainFactValidity(from: revision.validFrom, until: revision.validUntil)
                                if let evidence = revision.evidence { BrainFactSource(evidence: evidence) }
                                Text(BrainFormat.when(created: revision.updatedAt, from: nil, to: nil)).font(.caption)
                            }
                        }
                    }.padding(.top, 6)
                }.font(.caption)
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
}

private struct BrainFactValidity: View {
    let from: String?
    let until: String?
    var body: some View {
        if from != nil || until != nil {
            Text("Validità: \(from.map { BrainFormat.when(created: $0, from: nil, to: nil) } ?? "inizio non indicato") → \(until.map { BrainFormat.when(created: $0, from: nil, to: nil) } ?? "fine non indicata")")
                .font(.caption).foregroundStyle(Theme.inkSecondary)
        }
    }
}
private struct BrainFactSource: View {
    let evidence: BrainFactEvidence
    var body: some View {
        DisclosureGroup(evidence.kindLabel) {
            VStack(alignment: .leading, spacing: 4) {
                Text(evidence.quote).font(.subheadline).textSelection(.enabled)
                if let url = URL(string: evidence.ref), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    Link("Apri fonte", destination: url)
                } else if evidence.ref.hasSuffix(".md") && !evidence.ref.contains(":") && !evidence.ref.contains("..") {
                    NavigationLink(value: BrainDestination.path(evidence.ref)) { Text("Apri scheda fonte") }
                } else {
                    Text(evidence.ref.hasPrefix("chat:") ? "Conversazione con Ernie" : evidence.ref)
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
        }.font(.caption)
    }
}

struct BrainTimes: View {
    var start: String?
    var end: String?
    var dropOff: String?
    var pickup: String?
    var home: String?
    var body: some View {
        let rows = BrainRoutinePresentation.times(start: start, end: end, dropOff: dropOff, pickup: pickup, home: home)
        ViewThatFits(in: .horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                ForEach(rows, id: \.0) { label, value in
                    GridRow {
                        Text(label).foregroundStyle(Theme.inkSecondary)
                        Text(value).fontWeight(.semibold).monospacedDigit().gridColumnAlignment(.trailing)
                    }.accessibilityElement(children: .combine)
                }
            }.fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(rows, id: \.0) { label, value in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(label).foregroundStyle(Theme.inkSecondary)
                        Text(value).fontWeight(.semibold).monospacedDigit()
                    }.accessibilityElement(children: .combine)
                }
            }
        }.font(.subheadline).fixedSize(horizontal: false, vertical: true)
        if rows.isEmpty { Text("Orari non indicati").font(.subheadline).foregroundStyle(Theme.inkSecondary) }
    }
}

struct BrainRoutineCard: View {
    let routine: BrainRoutine
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(routine.title).font(.headline)
            Text(BrainRoutinePresentation.days(routine.days)).font(.subheadline).foregroundStyle(Theme.inkSecondary)
            Text("Fuso: \(routine.timeZone)").font(.caption).foregroundStyle(Theme.inkSecondary)
            BrainTimes(start: routine.startTime, end: routine.endTime, dropOff: routine.dropOffTime, pickup: routine.pickupTime, home: routine.homeTime)
            if let place = routine.place, !place.isEmpty { Label(place, systemImage: "mappin").font(.subheadline) }
            if routine.validFrom != nil || routine.validUntil != nil {
                Text("Validità: \(routine.validFrom.map { "dal \(BrainFormat.when(created: $0, from: nil, to: nil))" } ?? "inizio non indicato")\(routine.validUntil.map { " fino al \(BrainFormat.when(created: $0, from: nil, to: nil))" } ?? " · senza scadenza indicata")")
                    .font(.caption).foregroundStyle(Theme.inkSecondary)
            }
            if let notes = routine.notes, !notes.isEmpty { Text(Markdown.render(BrainFormat.linkify(notes))).font(.subheadline) }
            if !routine.exceptions.isEmpty {
                DisclosureGroup("Variazioni per data (\(routine.exceptions.count))") {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(routine.exceptions.sorted { $0.date < $1.date }) { exception in
                            VStack(alignment: .leading, spacing: 5) {
                                Text("\(BrainFormat.when(created: exception.date, from: nil, to: nil)) · \(exception.status == "cancelled" ? "Annullato" : "Orario modificato")")
                                    .font(.subheadline.weight(.semibold))
                                if exception.status != "cancelled" {
                                    if !BrainRoutinePresentation.times(start: exception.startTime, end: exception.endTime, dropOff: exception.dropOffTime,
                                                                       pickup: exception.pickupTime, home: exception.homeTime).isEmpty {
                                        BrainTimes(start: exception.startTime, end: exception.endTime, dropOff: exception.dropOffTime,
                                                   pickup: exception.pickupTime, home: exception.homeTime)
                                    }
                                    ForEach(exception.clearedFields, id: \.self) { key in
                                        Text("\(BrainRoutinePresentation.fieldLabel(key)): non indicato per questa data").font(.subheadline)
                                    }
                                    Text("I campi non modificati restano quelli abituali. Consulta la data per l’orario completo.")
                                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                                }
                                if let place = exception.place { Text(place).font(.subheadline) }
                                if let notes = exception.notes { Text(Markdown.render(BrainFormat.linkify(notes))).font(.subheadline) }
                            }
                        }
                    }.padding(.top, 8)
                }.font(.subheadline)
            }
            Text("Aggiornato \(BrainFormat.when(created: routine.updatedAt, from: nil, to: nil))")
                .font(.caption).foregroundStyle(Theme.inkSecondary)
        }.frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
    }
}

struct BrainAgendaContent: View {
    let agenda: BrainAgenda
    var openSource: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("\(BrainFormat.when(created: agenda.date, from: nil, to: nil)) · \(agenda.timeZone)").font(.subheadline.weight(.medium)).foregroundStyle(Theme.inkSecondary)
            Text(agenda.entries.isEmpty ? "Nessuna notifica. Un’agenda vuota non indica disponibilità o presenza a casa." : "Nessuna notifica. I rientri sono previsti, non verificati.")
                .font(.footnote).foregroundStyle(Theme.inkSecondary)
            if agenda.entries.isEmpty {
                Label("Nessuna attività prevista registrata per questa data", systemImage: "calendar")
                    .font(.headline)
            }
            ForEach(agenda.entries) { entry in
                VStack(alignment: .leading, spacing: 8) {
                    Text(entry.noteTitle).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    Text(entry.title).font(.headline)
                    if entry.status == "cancelled" {
                        Label("Annullato", systemImage: "xmark.circle.fill")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(.red)
                    } else {
                        BrainTimes(start: entry.startTime, end: entry.endTime, dropOff: entry.dropOffTime, pickup: entry.pickupTime, home: entry.homeTime)
                    }
                    if entry.timeZone != agenda.timeZone {
                        Text("Ore locali del \(BrainFormat.when(created: agenda.date, from: nil, to: nil)) nel fuso \(entry.timeZone); non convertite in \(agenda.timeZone).")
                            .font(.caption.weight(.medium)).foregroundStyle(Theme.inkSecondary)
                    } else { Text("Fuso: \(entry.timeZone)").font(.caption).foregroundStyle(Theme.inkSecondary) }
                    if let place = entry.place, !place.isEmpty { Label(place, systemImage: "mappin").font(.subheadline) }
                    if let notes = entry.notes, !notes.isEmpty { Text(Markdown.render(BrainFormat.linkify(notes))).font(.subheadline) }
                    Button("Fonte: \(entry.noteTitle)", systemImage: "arrow.up.right.square") { openSource(entry.notePath) }
                        .font(.subheadline).frame(minHeight: 44, alignment: .leading)
                }.frame(maxWidth: .infinity, alignment: .leading)
                Divider()
            }
            if !agenda.subjects.isEmpty {
                DisclosureGroup("Schede consultate (\(agenda.subjects.count))") {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(agenda.subjects) { subject in
                            Button(subject.title) { openSource(subject.path) }.frame(minHeight: 44, alignment: .leading)
                        }
                    }
                }.font(.subheadline)
            }
        }.fixedSize(horizontal: false, vertical: true).tint(Theme.accentText)
            .environment(\.openURL, OpenURLAction { url in
                guard let destination = BrainDestination(url: url) else { return .systemAction }
                switch destination { case .path(let ref), .title(let ref): openSource(ref) }
                return .handled
            })
    }
}

struct BrainAgendaView: View {
    var ref: String? = nil
    var openSource: (String) -> Void
    @Environment(AppModel.self) private var model
    @State private var date = Date()
    @State private var store = BrainAgendaStore()
    private var query: BrainAgendaQuery {
        .init(date: BrainAgendaQuery.day(date, timeZone: TimeZone.current.identifier), timeZone: TimeZone.current.identifier, ref: ref)
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    DatePicker("Data", selection: $date, displayedComponents: .date).datePickerStyle(.compact)
                    Button("Oggi") { date = .now }.frame(minHeight: 44, alignment: .leading)
                }
                if let result = store.result(for: query, credentials: model.credentials) {
                    BrainAgendaContent(agenda: result, openSource: openSource)
                } else if store.loading {
                    ProgressView("Consulto gli orari…").frame(maxWidth: .infinity)
                } else if let error = store.error {
                    Text(error).foregroundStyle(.secondary)
                    Button("Riprova") { Task { await load() } }.frame(minHeight: 44)
                } else if model.api == nil {
                    Text("Accedi per consultare gli orari.").foregroundStyle(.secondary)
                }
            }.padding(20).frame(maxWidth: 700, alignment: .leading).frame(maxWidth: .infinity)
        }.background(Theme.surface).navigationTitle("Orari per data").navigationBarTitleDisplayMode(.inline)
            .task(id: query) { await load() }
            .onChange(of: model.credentials) { _, _ in store.clear(); Task { await load() } }
            .onDisappear { store.clear() }
            .refreshable { await load() }
    }
    private func load() async {
        guard let api = model.api else { store.clear(); return }
        await store.load(query, api: api)
    }
}
