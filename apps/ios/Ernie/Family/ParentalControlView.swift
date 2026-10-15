import SwiftUI

/// Formati di data in italiano per il controllo genitori: «oggi 15:30», «ieri 09:10», «12 ott 15:30».
/// Se la data non si legge, restituisce il testo originale.
@MainActor
enum ParentalFormat {
    private static let locale = Locale(identifier: "it_IT")

    /// Data con anno («12 ott 2026»).
    static func day(_ iso: String) -> String {
        guard let d = ReminderStore.date(iso) else { return iso }
        return d.formatted(.dateTime.day().month(.abbreviated).year().locale(locale))
    }

    /// Momento relativo con l'ora: «oggi 15:30», «ieri 15:30», altrimenti «12 ott 15:30».
    static func when(_ iso: String) -> String {
        guard let d = ReminderStore.date(iso) else { return iso }
        let time = d.formatted(.dateTime.hour().minute().locale(locale))
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "oggi \(time)" }
        if cal.isDateInYesterday(d) { return "ieri \(time)" }
        let date = d.formatted(.dateTime.day().month(.abbreviated).locale(locale))
        return "\(date) \(time)"
    }
}

/// Account seguito, lato di chi segue (genitore per un figlio, figlio o nipote per un nonno): skill concesse
/// persona per persona, conversazioni (registro) e fine della supervisione.
struct ParentalControlView: View {
    let child: SupervisedChild
    /// Chiamato dopo aver tolto il controllo, prima di tornare indietro (la lista della famiglia si ricarica).
    var onReleased: () -> Void

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var skills: [GuardianSkill]
    @State private var error: String?
    @State private var releasing = false
    @State private var confirmRelease = false

    init(child: SupervisedChild, onReleased: @escaping () -> Void = {}) {
        self.child = child
        self.onReleased = onReleased
        _skills = State(initialValue: child.skills)
    }

    var body: some View {
        List {
            Section {
                headerCard
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(skills) { skill in
                    Toggle(isOn: Binding(
                        get: { skills.first { $0.id == skill.id }?.allowed ?? false },
                        set: { setAllowed(skill.id, $0) }
                    )) {
                        HStack(spacing: 12) {
                            SkillIcon(systemName: skill.icon.isEmpty ? "sparkle" : skill.icon, tint: Self.tint(for: skill.id))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(skill.title).font(.body)
                                Text(skill.summary).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text("Skill che può usare")
            } footer: {
                Text("Le modifiche valgono subito sul suo telefono.")
            }
            if let error {
                Section { Text(error).font(.caption).foregroundStyle(.red) }
            }
            Section {
                NavigationLink {
                    ChildSessionsView(child: child)
                } label: {
                    Label("Leggi le conversazioni", systemImage: "text.bubble")
                }
            } header: {
                Text("Conversazioni")
            } footer: {
                Text("Aprirle lo registra: \(child.label) vede «ultima consultazione» nella sua app.")
            }
            Section {
                Button(role: .destructive) { confirmRelease = true } label: {
                    Label(releaseTitle, systemImage: "shield.slash")
                        .frame(maxWidth: .infinity)
                }
                .disabled(releasing)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .navigationTitle(child.label)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .confirmationDialog("\(releaseTitle)?", isPresented: $confirmRelease, titleVisibility: .visible) {
            Button(isChild ? "Togli il controllo" : "Smetti di seguirlo", role: .destructive) { Task { await release() } }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("\(child.label) potrà di nuovo usare tutte le skill e le sue conversazioni non saranno più visibili a te.")
        }
    }

    /// Figlio (controllo genitori) o nonno/nonna (account seguito): cambiano solo le parole.
    private var isChild: Bool { (child.relation ?? "figlio") == "figlio" }

    private var releaseTitle: String { isChild ? "Togli il controllo genitori" : "Smetti di seguire l'account" }

    private var headerCard: some View {
        ErnieCard(
            icon: "shield.lefthalf.filled",
            tint: .sentinels,
            eyebrow: "Account seguito",
            title: isChild
                ? "Controllo genitori attivo dal \(ParentalFormat.day(child.since))"
                : "Lo segui dal \(ParentalFormat.day(child.since))"
        ) {
            Text("\(child.label) vede che l'account è seguito e quando consulti le conversazioni.")
                .font(.subheadline)
                .foregroundStyle(Theme.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Colore dell'icona per skill, dalla sigla del server (sconosciute: neutro).
    static func tint(for id: String) -> SkillTint {
        switch id {
        case "ricordami": .reminders
        case "shopping_list": .shopping
        case "documenti": .documents
        case "ricette": .recipes
        case "salute": .health
        case "sentinelle": .sentinels
        case "memoria", "brain": .brain
        default: .neutral
        }
    }

    /// Cambia una skill: l'interruttore si muove subito, poi si salva; in caso di errore torna com'era.
    private func setAllowed(_ id: String, _ on: Bool) {
        skills = skills.map { s in
            var s = s
            if s.id == id { s.allowed = on }
            return s
        }
        error = nil
        let allowed = skills.filter(\.allowed).map(\.id)
        Task { await saveSkills(changed: id, on: on, allowed: allowed) }
    }

    private func saveSkills(changed id: String, on: Bool, allowed: [String]) async {
        guard let api = model.api else { revert(id, to: !on); return }
        do {
            _ = try await api.setChildSkills(childId: child.childId, allowed: allowed)
        } catch {
            revert(id, to: !on)
            self.error = "Non sono riuscito a salvare: \(AppModel.describe(error))"
        }
    }

    /// Riporta una sola skill allo stato precedente (senza toccare le altre modifiche nel frattempo).
    private func revert(_ id: String, to allowed: Bool) {
        skills = skills.map { s in
            var s = s
            if s.id == id { s.allowed = allowed }
            return s
        }
    }

    /// Ricarica le skill (tirando giù la lista): il figlio può averle cambiate altrove.
    private func reload() async {
        guard let api = model.api else { return }
        do {
            if let fresh = try await api.supervisedChildren().first(where: { $0.childId == child.childId }) {
                skills = fresh.skills
            }
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    private func release() async {
        guard let api = model.api else { return }
        releasing = true
        defer { releasing = false }
        do {
            try await api.releaseChild(childId: child.childId)
            onReleased()
            dismiss()
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

/// Elenco delle conversazioni del figlio. Aprirlo (come aprire una conversazione) lo registra per il figlio.
struct ChildSessionsView: View {
    let child: SupervisedChild
    @Environment(AppModel.self) private var model
    @State private var sessions: [ChildSession] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        List {
            if loading && sessions.isEmpty {
                Section {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            } else if sessions.isEmpty {
                Section {
                    Text("Nessuna conversazione").foregroundStyle(.secondary)
                }
            }
            ForEach(sessions) { s in
                NavigationLink {
                    ChildTranscriptView(child: child, session: s)
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(s.title.isEmpty ? "Conversazione" : s.title)
                            .font(.body)
                            .lineLimit(2)
                        Text("\(ParentalFormat.when(s.lastAt)) · \(Self.countText(s.userMessages))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if let error {
                Section { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Conversazioni")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    static func countText(_ n: Int) -> String {
        n == 1 ? "1 messaggio" : "\(n) messaggi"
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            sessions = try await api.childSessions(childId: child.childId)
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
        loading = false
    }
}

/// Trascrizione di una conversazione del figlio: i suoi messaggi a destra, le risposte di Ernie a sinistra
/// con le skill usate. In sola lettura.
struct ChildTranscriptView: View {
    let child: SupervisedChild
    let session: ChildSession
    @Environment(AppModel.self) private var model
    @State private var messages: [ChildMessage] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if loading && messages.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                } else if messages.isEmpty {
                    Text("Nessun messaggio")
                        .font(.subheadline)
                        .foregroundStyle(Theme.inkSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                }
                ForEach(messages.indices, id: \.self) { i in
                    messageView(messages[i])
                }
                if let error {
                    Text(error).font(.caption).foregroundStyle(.red).frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Theme.ground)
        .navigationTitle(session.title.isEmpty ? "Conversazione" : session.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder
    private func messageView(_ m: ChildMessage) -> some View {
        if m.role == "user" {
            HStack(alignment: .bottom) {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(m.text)
                        .font(.body)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    meta(m)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !m.text.isEmpty {
                    Text(m.text)
                        .font(.body)
                        .foregroundStyle(Theme.ink)
                        .textSelection(.enabled)
                }
                let chips = Self.toolChips(m.tools)
                if !chips.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
                        ForEach(chips, id: \.self) { name in
                            ErnieChip(text: name, systemImage: "wrench.and.screwdriver")
                        }
                    }
                }
                meta(m)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Ora e, per i messaggi detti a voce, la scritta «a voce».
    private func meta(_ m: ChildMessage) -> some View {
        HStack(spacing: 4) {
            if m.voice {
                Image(systemName: "mic.fill")
                    .accessibilityHidden(true)
                Text("a voce")
            }
            Text(ParentalFormat.when(m.at))
        }
        .font(.caption2)
        .foregroundStyle(Theme.inkSecondary)
    }

    /// Nomi leggibili delle skill usate, senza doppioni («second brain» una volta sola).
    static func toolChips(_ tools: [String]) -> [String] {
        var seen = Set<String>()
        return tools.map(toolName).filter { seen.insert($0).inserted }
    }

    static func toolName(_ id: String) -> String {
        switch id {
        case "web_search": return "ricerca web"
        case "web_fetch": return "pagina web"
        case "memory_search": return "memoria"
        case "get_time": return "ora"
        default: break
        }
        if id.hasPrefix("brain_") { return "second brain" }
        if id.hasPrefix("document_") { return "documenti" }
        if id.hasPrefix("recipe_") { return "ricette" }
        if id.hasPrefix("health_") { return "salute" }
        if id.hasPrefix("sentinel_") { return "sentinelle" }
        return id
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            messages = try await api.childSession(childId: child.childId, sessionId: session.id)
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
        loading = false
    }
}
