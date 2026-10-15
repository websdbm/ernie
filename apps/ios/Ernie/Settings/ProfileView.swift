import SwiftUI

// MARK: - modelli (REST /v1/profile)

struct ProfileSource: Codable, Sendable, Equatable {
    var source: String
    var at: String
    var quote: String?
}

struct ProfileFamilyMember: Codable, Sendable, Equatable, Identifiable {
    var id: String?
    var name: String?
    var relation: String
    var birthDate: String?
    var notes: String?
    var source: String?
    var at: String?
    /// Identità locale per le liste (i familiari nuovi non hanno ancora un id del server).
    var localId = UUID().uuidString

    enum CodingKeys: String, CodingKey { case id, name, relation, birthDate, notes, source, at }
    var listId: String { id ?? localId }
}

struct UserProfileData: Codable, Sendable, Equatable {
    var fullName: String?
    var preferredName: String?
    var birthDate: String?
    var gender: String?
    var city: String?
    var occupation: String?
    var email: String?
    var family: [ProfileFamilyMember] = []
    /// Luoghi (casa, lavoro…) per i promemoria «quando arrivo a …»; assenti sui server più vecchi.
    var places: [ProfilePlace] = []
    var sources: [String: ProfileSource] = [:]

    enum CodingKeys: String, CodingKey {
        case fullName, preferredName, birthDate, gender, city, occupation, email, family, places, sources
    }

    init() {}

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fullName = try c.decodeIfPresent(String.self, forKey: .fullName)
        preferredName = try c.decodeIfPresent(String.self, forKey: .preferredName)
        birthDate = try c.decodeIfPresent(String.self, forKey: .birthDate)
        gender = try c.decodeIfPresent(String.self, forKey: .gender)
        city = try c.decodeIfPresent(String.self, forKey: .city)
        occupation = try c.decodeIfPresent(String.self, forKey: .occupation)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        family = try c.decodeIfPresent([ProfileFamilyMember].self, forKey: .family) ?? []
        places = try c.decodeIfPresent([ProfilePlace].self, forKey: .places) ?? []
        sources = try c.decodeIfPresent([String: ProfileSource].self, forKey: .sources) ?? [:]
    }
}

struct LinkedPerson: Codable, Sendable, Equatable, Hashable {
    var label: String
    var relation: String
}

struct ProfileResponse: Decodable, Sendable {
    var profile: UserProfileData
    var linked: [LinkedPerson]?
    var changes: [String]?
}

/// Corpo del salvataggio: la scheda intera (i campi assenti si svuotano).
struct ProfilePutBody: Encodable, Sendable {
    struct Member: Encodable, Sendable {
        var id: String?
        var name: String?
        var relation: String
        var birthDate: String?
        var notes: String?
    }

    var fullName: String?
    var preferredName: String?
    var birthDate: String?
    var gender: String?
    var city: String?
    var occupation: String?
    var email: String?
    var family: [Member]
    var places: [Place]

    struct Place: Encodable, Sendable {
        var id: String?
        var label: String
        var address: String?
        var lat: Double?
        var lng: Double?
        var radius: Double?
    }
}

extension ApiClient {
    func profile() async throws -> ProfileResponse { try await request("GET", "/v1/profile") }

    /// Coordinate trovate dal telefono per un luogo della scheda (indirizzo detto in chat).
    func setPlaceCoordinates(id: String, lat: Double, lng: Double) async throws -> ProfileResponse {
        struct Body: Encodable { var lat: Double; var lng: Double }
        return try await request("PATCH", "/v1/profile/places/\(id)", body: Body(lat: lat, lng: lng))
    }

    func saveProfile(_ body: ProfilePutBody) async throws -> ProfileResponse {
        try await request("PUT", "/v1/profile", body: body)
    }
}

// MARK: - date di nascita («1975-05-03» o «--06-21» se manca l'anno)

enum BirthDate {
    static func parse(_ v: String?) -> (date: Date, hasYear: Bool)? {
        guard let v, !v.isEmpty else { return nil }
        var c = DateComponents()
        if v.hasPrefix("--") {
            let parts = v.dropFirst(2).split(separator: "-").compactMap { Int($0) }
            guard parts.count == 2 else { return nil }
            c.year = 2000; c.month = parts[0]; c.day = parts[1]
        } else {
            let parts = v.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return nil }
            c.year = parts[0]; c.month = parts[1]; c.day = parts[2]
        }
        guard let d = Calendar.current.date(from: c) else { return nil }
        return (d, !v.hasPrefix("--"))
    }

    static func format(_ date: Date, hasYear: Bool) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        let m = String(format: "%02d", c.month ?? 1), d = String(format: "%02d", c.day ?? 1)
        return hasYear ? "\(c.year ?? 2000)-\(m)-\(d)" : "--\(m)-\(d)"
    }

    /// «3 maggio 1975 · 51 anni» oppure «21 giugno».
    static func describe(_ v: String?) -> String? {
        guard let (date, hasYear) = parse(v) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "it_IT")
        f.setLocalizedDateFormatFromTemplate(hasYear ? "d MMMM y" : "d MMMM")
        let text = f.string(from: date)
        guard hasYear, let age = Calendar.current.dateComponents([.year], from: date, to: .now).year else { return text }
        return "\(text) · \(age) \(age == 1 ? "anno" : "anni")"
    }
}

// MARK: - schermata

/// Impostazioni › La tua scheda: dati anagrafici che Ernie raccoglie dalle conversazioni e che hanno la precedenza
/// sulle altre memorie. Tutto si può correggere; quello che scrivi qui non viene sovrascritto dalla chat.
struct ProfileView: View {
    @Environment(AppModel.self) private var model
    @State private var data = UserProfileData()
    @State private var saved = UserProfileData()
    @State private var linked: [LinkedPerson] = []
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var notice: String?
    @State private var editing: ProfileFamilyMember?
    @State private var editingPlace: ProfilePlace?
    /// Luoghi trovati nelle note del second brain (cartella Luoghi) e non ancora nella scheda.
    @State private var suggestions: [PlaceSuggestion] = []

    private static let genders = ["uomo", "donna", "non binario", "preferisco non dirlo"]

    var body: some View {
        Form {
            Section {
                field("Nome e cognome", \.fullName, key: "fullName")
                field("Come vuoi essere chiamato", \.preferredName, key: "preferredName")
                birthDateRow
                genderRow
                field("Città dove vivi", \.city, key: "city")
                field("Lavoro", \.occupation, key: "occupation")
                emailRow
            } header: {
                Text("Chi sei")
            } footer: {
                Text("Ernie compila la scheda da solo quando ne parli, senza questionari. Questi dati hanno la precedenza sulle altre memorie; quello che scrivi qui non viene sovrascritto dalla chat.")
            }

            Section {
                if data.family.isEmpty {
                    Text("Nessun familiare ancora: Ernie li aggiunge quando ne parli, oppure aggiungili tu.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(data.family, id: \.listId) { m in
                    Button { editing = m } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.name.map { "\($0) · \(m.relation)" } ?? m.relation.capitalized)
                                .foregroundStyle(.primary)
                            let details = [BirthDate.describe(m.birthDate), m.notes, m.source == "conversation" ? "dalla chat" : nil]
                                .compactMap { $0 }.filter { !$0.isEmpty }
                            if !details.isEmpty {
                                Text(details.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .onDelete { data.family.remove(atOffsets: $0) }
                Button {
                    editing = ProfileFamilyMember(relation: "")
                } label: {
                    Label("Aggiungi familiare", systemImage: "person.badge.plus")
                }
            } header: {
                Text("Famiglia")
            } footer: {
                Text("Anche gli animali di casa. Scorri a sinistra per togliere.")
            }

            placesSection

            if !linked.isEmpty {
                Section {
                    ForEach(linked, id: \.self) { p in
                        LabeledContent(p.label, value: p.relation)
                    }
                    NavigationLink("Gestisci in Famiglia") { FamilyView() }
                } header: {
                    Text("Collegati in Ernie")
                }
            }

            if let notice { Section { Text(notice).font(.footnote).foregroundStyle(.secondary) } }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
        }
        .navigationTitle("La tua scheda")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(saving ? "Salvo…" : "Salva") { Task { await save() } }
                    .disabled(data == saved || saving || loading)
            }
        }
        .sheet(item: Binding(
            get: { editing.map { EditingMember(member: $0) } },
            set: { editing = $0?.member }
        )) { item in
            NavigationStack {
                FamilyMemberEditor(member: item.member) { updated in
                    if let i = data.family.firstIndex(where: { $0.listId == updated.listId }) {
                        data.family[i] = updated
                    } else {
                        data.family.append(updated)
                    }
                    editing = nil
                } onCancel: {
                    editing = nil
                }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(item: Binding(
            get: { editingPlace.map { EditingPlace(place: $0) } },
            set: { editingPlace = $0?.place }
        )) { item in
            NavigationStack {
                PlaceEditor(place: item.place) { updated in
                    if let i = data.places.firstIndex(where: { $0.listId == updated.listId }) {
                        data.places[i] = updated
                    } else {
                        data.places.append(updated)
                    }
                    editingPlace = nil
                } onCancel: {
                    editingPlace = nil
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    // MARK: luoghi

    private var visibleSuggestions: [PlaceSuggestion] {
        suggestions.filter { s in
            !data.places.contains { $0.label == s.label || ($0.address != nil && $0.address?.lowercased() == s.address?.lowercased()) }
        }
    }

    @ViewBuilder
    private var placesSection: some View {
        Section {
            if data.places.isEmpty {
                Text("Nessun luogo ancora: aggiungi casa o il lavoro, oppure di' a Ernie «casa mia è in via …».")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(data.places, id: \.listId) { p in
                Button { editingPlace = p } label: {
                    HStack(spacing: 12) {
                        Image(systemName: p.located ? "mappin.circle.fill" : "mappin.slash.circle")
                            .font(.title3)
                            .foregroundStyle(p.located ? Color.accentColor : Color.orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.label.capitalized).foregroundStyle(.primary)
                            let details = [p.address ?? (p.located ? "posizione sulla mappa" : nil),
                                           p.located ? nil : "posizione da confermare",
                                           p.source == "conversation" ? "dalla chat" : nil]
                                .compactMap { $0 }
                            if !details.isEmpty {
                                Text(details.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .onDelete { data.places.remove(atOffsets: $0) }
            if data.places.count < 10 {
                Button {
                    editingPlace = ProfilePlace(label: data.places.contains { $0.label == "casa" } ? "" : "casa")
                } label: {
                    Label("Aggiungi luogo", systemImage: "mappin.and.ellipse")
                }
            }
            ForEach(visibleSuggestions) { s in
                Button {
                    editingPlace = ProfilePlace(label: s.label, address: s.address, lat: s.lat, lng: s.lng)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "brain.head.profile")
                            .font(.title3)
                            .foregroundStyle(SkillTint.brain.color)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Dal second brain: \(s.title)").foregroundStyle(.primary)
                            if let a = s.address { Text(a).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Image(systemName: "plus.circle").foregroundStyle(Color.accentColor)
                    }
                }
            }
        } header: {
            Text("Luoghi")
        } footer: {
            Text("Servono ai promemoria «ricordami … quando arrivo a casa». Scorri a sinistra per togliere; tocca per spostare il punto sulla mappa.")
        }
    }

    // MARK: righe

    private func field(_ title: String, _ path: WritableKeyPath<UserProfileData, String?>, key: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField(title, text: Binding(
                get: { data[keyPath: path] ?? "" },
                set: { data[keyPath: path] = $0.isEmpty ? nil : $0 }
            ))
            sourceCaption(key)
        }
    }

    @ViewBuilder
    private func sourceCaption(_ key: String) -> some View {
        if let s = saved.sources[key], s.source == "conversation" {
            let when = Self.day(s.at)
            Text(s.quote.map { "Dalla chat del \(when): «\($0)»" } ?? "Dalla chat del \(when)")
                .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }
    }

    /// Email della scheda: la stessa delle impostazioni (Notifiche); serve ai promemoria via email.
    /// Il campo non passa dall'aiuto `field` perché ha bisogno dei modificatori di tastiera.
    private var emailRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            TextField("Email", text: Binding(
                get: { data.email ?? "" },
                set: { data.email = $0.isEmpty ? nil : $0 }
            ))
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textContentType(.emailAddress)
            Text("Serve per i promemoria via email; Ernie te la chiede quando manca.")
                .font(.caption).foregroundStyle(.secondary)
            sourceCaption("email")
        }
    }

    private var birthDateRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let parsed = BirthDate.parse(data.birthDate) {
                DatePicker(
                    parsed.hasYear ? "Data di nascita" : "Compleanno",
                    selection: Binding(
                        get: { parsed.date },
                        set: { data.birthDate = BirthDate.format($0, hasYear: parsed.hasYear) }
                    ),
                    in: ...Date.now,
                    displayedComponents: .date
                )
                HStack {
                    if let text = BirthDate.describe(data.birthDate) {
                        Text(text).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if !parsed.hasYear {
                        Button("Aggiungi l'anno") {
                            data.birthDate = BirthDate.format(parsed.date, hasYear: true)
                        }
                        .font(.caption).buttonStyle(.borderless)
                    }
                    Button("Togli", role: .destructive) { data.birthDate = nil }
                        .font(.caption).buttonStyle(.borderless)
                }
            } else {
                Button("Aggiungi la data di nascita") {
                    data.birthDate = BirthDate.format(Calendar.current.date(byAdding: .year, value: -30, to: .now) ?? .now, hasYear: true)
                }
            }
            sourceCaption("birthDate")
        }
    }

    private var genderRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            Picker("Genere", selection: Binding(
                get: { data.gender ?? "" },
                set: { data.gender = $0.isEmpty ? nil : $0 }
            )) {
                Text("Non indicato").tag("")
                ForEach(Self.genders, id: \.self) { Text($0).tag($0) }
                if let g = data.gender, !g.isEmpty, !Self.genders.contains(g) { Text(g).tag(g) }
            }
            sourceCaption("gender")
        }
    }

    // MARK: rete

    private func load() async {
        guard let api = model.api else { return }
        loading = true
        defer { loading = false }
        do {
            let out = try await api.profile()
            data = out.profile
            saved = out.profile
            linked = out.linked ?? []
            error = nil
            suggestions = (try? await api.placeSuggestions()) ?? []
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    private func save() async {
        guard let api = model.api else { return }
        saving = true
        defer { saving = false }
        let body = ProfilePutBody(
            fullName: data.fullName, preferredName: data.preferredName, birthDate: data.birthDate,
            gender: data.gender, city: data.city, occupation: data.occupation, email: data.email,
            family: data.family.map { .init(id: $0.id, name: $0.name, relation: $0.relation, birthDate: $0.birthDate, notes: $0.notes) },
            places: data.places.map { .init(id: $0.id, label: $0.label, address: $0.address, lat: $0.lat, lng: $0.lng, radius: $0.radius) }
        )
        do {
            let out = try await api.saveProfile(body)
            data = out.profile
            saved = out.profile
            error = nil
            let changes = out.changes ?? []
            notice = changes.isEmpty ? "Nessuna modifica." : "Salvato. Ernie ne terrà conto da subito."
            // I promemoria legati ai luoghi prendono subito la posizione nuova.
            await model.reminders.refresh()
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    static func day(_ iso: String) -> String { DocumentsCard.day(iso) }
}

/// Wrapper identificabile per il foglio di modifica di un luogo.
private struct EditingPlace: Identifiable {
    var place: ProfilePlace
    var id: String { place.listId }
}

/// Wrapper identificabile per il foglio di modifica di un familiare.
private struct EditingMember: Identifiable {
    var member: ProfileFamilyMember
    var id: String { member.listId }
}

/// Modifica di un familiare: nome, relazione, data di nascita facoltativa, una nota breve.
private struct FamilyMemberEditor: View {
    @State var member: ProfileFamilyMember
    let onSave: (ProfileFamilyMember) -> Void
    let onCancel: () -> Void

    private static let relations = ["moglie", "marito", "compagna", "compagno", "figlio", "figlia", "madre", "padre", "fratello", "sorella", "nonno", "nonna", "cane", "gatto"]

    var body: some View {
        Form {
            TextField("Nome (facoltativo)", text: Binding(
                get: { member.name ?? "" },
                set: { member.name = $0.isEmpty ? nil : $0 }
            ))
            TextField("Relazione (es. figlio, moglie, cane)", text: $member.relation)
                .textInputAutocapitalization(.never)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(Self.relations, id: \.self) { r in
                        Button(r) { member.relation = r }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
            }
            if let parsed = BirthDate.parse(member.birthDate) {
                DatePicker("Nato/a il", selection: Binding(
                    get: { parsed.date },
                    set: { member.birthDate = BirthDate.format($0, hasYear: parsed.hasYear) }
                ), in: ...Date.now, displayedComponents: .date)
                Button("Togli la data", role: .destructive) { member.birthDate = nil }
            } else {
                Button("Aggiungi la data di nascita") {
                    member.birthDate = BirthDate.format(Calendar.current.date(byAdding: .year, value: -10, to: .now) ?? .now, hasYear: true)
                }
            }
            TextField("Nota (facoltativa)", text: Binding(
                get: { member.notes ?? "" },
                set: { member.notes = $0.isEmpty ? nil : $0 }
            ))
        }
        .navigationTitle(member.name ?? "Familiare")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Annulla", action: onCancel) }
            ToolbarItem(placement: .confirmationAction) {
                Button("Fatto") { onSave(member) }
                    .disabled(member.relation.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}
