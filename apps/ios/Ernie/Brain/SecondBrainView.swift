import SwiftUI
import MapKit
import UIKit

// MARK: - modelli (REST /v1/brain)

struct BrainNoteSummary: Codable, Sendable, Identifiable, Hashable {
    var path: String
    var title: String
    var type: String
    var created: String
    var refersFrom: String?
    var refersTo: String?
    var place: String?
    /// Posizione come `[lat, lon]`, oppure `nil` se la nota non ha un luogo.
    var coords: [Double]?
    var links: [String]
    var `private`: Bool
    var excerpt: String
    var id: String { path }
}

struct BrainNoteDetail: Codable, Sendable {
    var path: String
    var title: String
    var type: String
    var created: String
    var refersFrom: String?
    var refersTo: String?
    var place: String?
    var links: [String]
    var `private`: Bool
    var source: String?
    var body: String
}

struct BrainNoteResponse: Decodable, Sendable {
    var note: BrainNoteDetail
    var backlinks: [String]
}

extension ApiClient {
    func brainNotes(query: String?, type: String?) async throws -> [BrainNoteSummary] {
        struct Out: Decodable { var notes: [BrainNoteSummary] }
        var items: [URLQueryItem] = []
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let type { items.append(URLQueryItem(name: "type", value: type)) }
        var c = URLComponents()
        c.queryItems = items.isEmpty ? nil : items
        let out: Out = try await request("GET", "/v1/brain/notes\(c.percentEncodedQuery.map { "?\($0)" } ?? "")")
        return out.notes
    }

    func brainNote(title: String) async throws -> BrainNoteResponse {
        var c = URLComponents()
        c.queryItems = [URLQueryItem(name: "title", value: title)]
        return try await request("GET", "/v1/brain/note?\(c.percentEncodedQuery ?? "")")
    }

    /// Crea una pagina (POST /v1/brain/notes): il server risponde 201 con la nota e i backlink.
    func brainCreateNote(title: String, body: String, type: String? = nil, isPrivate: Bool? = nil) async throws -> BrainNoteResponse {
        struct Body: Encodable, Sendable {
            var title: String
            var body: String
            var type: String?
            var isPrivate: Bool?
            enum CodingKeys: String, CodingKey { case title, body, type, isPrivate = "private" }
        }
        return try await request("POST", "/v1/brain/notes", body: Body(title: title, body: body, type: type, isPrivate: isPrivate))
    }

    /// Modifica il testo e/o la riservatezza di una pagina (PATCH /v1/brain/note): il percorso va nel corpo.
    func brainUpdateNote(path: String, body: String? = nil, isPrivate: Bool? = nil) async throws -> BrainNoteResponse {
        struct Body: Encodable, Sendable {
            var path: String
            var body: String?
            var isPrivate: Bool?
            enum CodingKeys: String, CodingKey { case path, body, isPrivate = "private" }
        }
        return try await request("PATCH", "/v1/brain/note", body: Body(path: path, body: body, isPrivate: isPrivate))
    }

    /// Elimina una pagina (DELETE /v1/brain/note?path=…): risponde 204 e la nota resta nella cronologia di Ernie.
    func brainDeleteNote(path: String) async throws {
        let _: EmptyResponse = try await request("DELETE", "/v1/brain/note?path=\(Self.encodeQueryValue(path))")
    }

    /// Indirizzo al quale inoltrare le email (`address` nil se il server non ha la posta in arrivo configurata),
    /// con l'email della scheda e gli altri indirizzi da cui si accettano gli inoltri.
    func brainInboxAddress() async throws -> BrainInbox {
        try await request("GET", "/v1/brain/inbox-address")
    }

    /// Sostituisce l'elenco degli altri indirizzi (PATCH /v1/me/settings { extraEmails }); torna le impostazioni aggiornate.
    func setExtraEmails(_ emails: [String]) async throws -> [String: JSONValue] {
        try await updateSettings(["extraEmails": .array(emails.map { .string($0) })])
    }

    /// Codifica un valore da mettere nella query: anche `/`, `+`, `&` e `=` diventano sequenze di escape.
    private static func encodeQueryValue(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

// MARK: - aspetto per tipo

enum BrainType: String, CaseIterable, Identifiable {
    case nota, persona, luogo, progetto, argomento, documento, salute
    var id: String { rawValue }

    var label: String {
        switch self {
        case .nota: "Note"
        case .persona: "Persone"
        case .luogo: "Luoghi"
        case .progetto: "Progetti"
        case .argomento: "Argomenti"
        case .documento: "Documenti"
        case .salute: "Salute"
        }
    }

    static func icon(_ type: String) -> String {
        switch type {
        case "persona": "person.fill"
        case "luogo": "mappin.and.ellipse"
        case "progetto": "hammer.fill"
        case "argomento": "tag.fill"
        case "documento": "doc.text.fill"
        case "salute": "heart.text.square.fill"
        case "chi-sono": "person.text.rectangle.fill"
        default: "note.text"
        }
    }
}

enum BrainFormat {
    /** «14 ottobre 2026», oppure «dal 14 al 16 ottobre». */
    static func when(created: String, from: String?, to: String?) -> String {
        let day: (String) -> String = { iso in
            let f = DateFormatter()
            f.locale = Locale(identifier: "it_IT")
            f.dateFormat = "yyyy-MM-dd"
            guard let d = f.date(from: String(iso.prefix(10))) else { return iso }
            return d.formatted(.dateTime.day().month(.wide).year().locale(Locale(identifier: "it_IT")))
        }
        if let from, let to, to != from { return "\(day(from)) – \(day(to))" }
        return day(from ?? created)
    }

    /// `[[Titolo|alias]]` → link toccabile `ernie-brain://note?title=…` che la vista intercetta.
    static func linkify(_ body: String) -> String {
        let regex = try? NSRegularExpression(pattern: #"\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]"#)
        guard let regex else { return body }
        let ns = body as NSString
        var out = ""
        var last = 0
        for m in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let title = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let label = m.range(at: 2).location != NSNotFound ? ns.substring(with: m.range(at: 2)) : title
            var c = URLComponents()
            c.scheme = "ernie-brain"
            c.host = "note"
            c.queryItems = [URLQueryItem(name: "title", value: title)]
            out += "[\(label)](\(c.url?.absoluteString ?? ""))"
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}

// MARK: - elenco

/// Modo di vista della schermata Second brain.
enum BrainViewMode: String, CaseIterable, Identifiable {
    case elenco, tempo, mappa
    var id: String { rawValue }

    var label: String {
        switch self {
        case .elenco: "Elenco"
        case .tempo: "Tempo"
        case .mappa: "Mappa"
        }
    }
}

/// Un mese della vista «Tempo», con le sue note in ordine di data decrescente.
private struct BrainMonth: Identifiable {
    let key: String      // yyyy-MM
    let title: String    // es. «ottobre 2026»
    let notes: [BrainNoteSummary]
    var id: String { key }
}

/// Una nota con posizione, da mostrare come annotazione sulla mappa.
private struct BrainPin: Identifiable {
    let note: BrainNoteSummary
    let coordinate: CLLocationCoordinate2D
    var id: String { note.id }
}

/// Second brain: note, persone, luoghi, progetti e documenti che Ernie scrive e collega (sincronizzati con Obsidian).
/// In questa fase si sfoglia, si cerca e si legge; per annotare basta dirlo a Ernie.
struct SecondBrainView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var notes: [BrainNoteSummary] = []
    @State private var query = ""
    @State private var type: BrainType?
    @State private var loading = true
    @State private var error: String?
    @State private var path: [String] = []
    @State private var mode: BrainViewMode = .elenco
    @State private var camera: MapCameraPosition = .automatic
    /// Foglio «Nuova nota» aperto.
    @State private var creating = false
    /// Foglio «Inoltra email al second brain» aperto.
    @State private var showInbox = false
    /// Titolo della nota appena creata: si apre quando il foglio «Nuova nota» si chiude.
    @State private var openAfterCreate: String?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    Picker("Vista", selection: $mode) {
                        ForEach(BrainViewMode.allCases) { m in Text(m.label).tag(m) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            chip("Tutte", selected: type == nil) { type = nil }
                            ForEach(BrainType.allCases) { t in
                                chip(t.label, selected: type == t) { type = (type == t ? nil : t) }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                }
                if mode != .mappa, notes.isEmpty, !loading {
                    Section {
                        Text(query.isEmpty
                             ? "Ancora vuoto. Di' a Ernie «annota che…» oppure mandagli una foto da salvare: le note compaiono qui e in Obsidian."
                             : "Nessuna nota trovata per «\(query)».")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                switch mode {
                case .elenco:
                    ForEach(notes) { n in
                        NavigationLink(value: n.title) { row(n) }
                    }
                case .tempo:
                    ForEach(timeline) { m in
                        Section {
                            ForEach(m.notes) { n in
                                NavigationLink(value: n.title) { row(n) }
                            }
                        } header: {
                            Text(m.title)
                        }
                    }
                case .mappa:
                    Section {
                        if pins.isEmpty {
                            Text("Nessuna nota con un luogo: quelle annotate con la posizione del telefono compaiono qui.")
                                .font(.callout).foregroundStyle(.secondary)
                        } else {
                            Map(position: $camera) {
                                ForEach(pins) { p in
                                    Annotation(p.note.title, coordinate: p.coordinate) {
                                        Button { path.append(p.note.title) } label: {
                                            Image(systemName: BrainType.icon(p.note.type))
                                                .font(.body.weight(.semibold))
                                                .foregroundStyle(.white)
                                                .frame(width: 36, height: 36)
                                                .background(Color.accentColor, in: Circle())
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                            .frame(height: 420)
                            .listRowInsets(EdgeInsets())
                        }
                    }
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Second brain")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Cerca nelle note")
            .onSubmit(of: .search) { Task { await load() } }
            .onChange(of: query) { if query.isEmpty { Task { await load() } } }
            .onChange(of: type) { Task { await load() } }
            .onChange(of: path) { _, newPath in if newPath.isEmpty { Task { await load() } } }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { creating = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Nuova nota")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showInbox = true } label: { Label("Inoltra email al second brain", systemImage: "envelope") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Altre azioni")
                }
                ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } }
            }
            .sheet(isPresented: $creating, onDismiss: { openCreatedNote() }) {
                BrainNewNoteSheet { title in
                    openAfterCreate = title
                    Task { await load() }
                }
            }
            .sheet(isPresented: $showInbox) {
                BrainInboxSheet()
            }
            .navigationDestination(for: String.self) { title in
                BrainNoteView(title: title, path: $path)
            }
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func chip(_ text: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text).font(.caption.weight(.medium))
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(selected ? Color.accentColor.opacity(0.2) : Color(.tertiarySystemFill), in: Capsule())
                .foregroundStyle(selected ? Color.accentColor : .primary)
        }
        .buttonStyle(.plain)
    }

    /// Data di riferimento (`yyyy-MM-dd`): inizio della tratta se c'è, altrimenti data di creazione.
    private static func refDate(_ n: BrainNoteSummary) -> String {
        if let r = n.refersFrom, !r.isEmpty { return String(r.prefix(10)) }
        return String(n.created.prefix(10))
    }

    /// Note raggruppate per mese, dal più recente; dentro ogni mese, dalla data più recente.
    private var timeline: [BrainMonth] {
        let groups = Dictionary(grouping: notes) { String(Self.refDate($0).prefix(7)) }
        return groups.keys.sorted(by: >).map { key in
            let items = (groups[key] ?? []).sorted { Self.refDate($0) > Self.refDate($1) }
            return BrainMonth(key: key, title: Self.monthTitle(key), notes: items)
        }
    }

    /// «2026-10» → «ottobre 2026».
    private static func monthTitle(_ key: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "it_IT")
        f.dateFormat = "yyyy-MM"
        guard let d = f.date(from: key) else { return key }
        return d.formatted(.dateTime.month(.wide).year().locale(Locale(identifier: "it_IT")))
    }

    /// Note con una posizione valida (`[lat, lon]`).
    private var pins: [BrainPin] {
        notes.compactMap { n in
            guard let c = n.coords, c.count == 2 else { return nil }
            return BrainPin(note: n, coordinate: CLLocationCoordinate2D(latitude: c[0], longitude: c[1]))
        }
    }

    private func row(_ n: BrainNoteSummary) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: BrainType.icon(n.type)).foregroundStyle(Color.accentColor).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(n.title).font(.body.weight(.medium)).lineLimit(1)
                    if n.private { Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary) }
                }
                Text([BrainFormat.when(created: n.created, from: n.refersFrom, to: n.refersTo), n.place].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
                if !n.excerpt.isEmpty {
                    Text(Self.plain(n.excerpt))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }

    /// Anteprima senza segni di markdown né parentesi dei collegamenti.
    static func plain(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "[[", with: "").replacingOccurrences(of: "]]", with: "")
        for mark in ["**", "__", "`"] { t = t.replacingOccurrences(of: mark, with: "") }
        return t.replacingOccurrences(of: #"(^|\s)#{1,6}\s"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"(^|\s)[-*]\s"#, with: "$1", options: .regularExpression)
    }

    /// Dopo il foglio «Nuova nota»: apre la pagina appena creata (se il foglio ha salvato).
    private func openCreatedNote() {
        guard let title = openAfterCreate else { return }
        openAfterCreate = nil
        path.append(title)
    }

    private func load() async {
        guard let api = model.api else { return }
        loading = true
        defer { loading = false }
        do {
            notes = try await api.brainNotes(query: query.trimmingCharacters(in: .whitespaces), type: type?.rawValue)
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

// MARK: - nota

extension BrainNoteDetail {
    /// Pagine che Ernie aggiorna da sola (anagrafica e saluto): non si modificano né si eliminano a mano.
    var isGenerated: Bool { type == "chi-sono" || type == "salute" }

    /// Si può modificare o eliminare: la pagina esiste sul disco (ha un percorso) e non è generata da Ernie.
    var isEditable: Bool { !path.isEmpty && !isGenerated }
}

struct BrainNoteView: View {
    let title: String
    @Binding var path: [String]
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var data: BrainNoteResponse?
    @State private var error: String?
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var actionError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let n = data?.note {
                    HStack(spacing: 8) {
                        Image(systemName: BrainType.icon(n.type)).foregroundStyle(Color.accentColor)
                        Text(n.title).font(.title2.weight(.semibold))
                        if n.private { Image(systemName: "lock.fill").foregroundStyle(.secondary) }
                    }
                    let meta = [
                        BrainFormat.when(created: n.created, from: n.refersFrom, to: n.refersTo),
                        n.place,
                        n.source.map { "da \($0)" },
                    ].compactMap { $0 }
                    Text(meta.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
                    MarkdownText(text: BrainFormat.linkify(n.body))
                        .environment(\.openURL, OpenURLAction { url in
                            guard url.scheme == "ernie-brain",
                                  let t = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "title" })?.value
                            else { return .systemAction }
                            path.append(t)
                            return .handled
                        })
                    if n.isGenerated {
                        Text("Pagina generata da Ernie: si aggiorna da sola.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let actionError {
                        Text(actionError).font(.footnote).foregroundStyle(.red)
                    }
                    if !(data?.backlinks ?? []).isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Citata da").font(.subheadline.weight(.semibold))
                            ForEach(data?.backlinks ?? [], id: \.self) { b in
                                Button { path.append(b) } label: {
                                    Label(b, systemImage: "arrow.turn.down.right").font(.callout)
                                }
                            }
                        }
                        .padding(.top, 6)
                    }
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(data?.note.title ?? title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let n = data?.note, n.isEditable {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { editing = true } label: { Label("Modifica", systemImage: "pencil") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Elimina", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(deleting)
                    .accessibilityLabel("Altre azioni sulla pagina")
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let n = data?.note {
                BrainNoteEditor(note: n) { updated in data = updated }
            }
        }
        .confirmationDialog("Eliminare «\(data?.note.title ?? title)»?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Elimina", role: .destructive) {
                if let n = data?.note { Task { await delete(n) } }
            }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("Resta nella cronologia di Ernie e si può recuperare.")
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            data = try await api.brainNote(title: title)
            error = nil
        } catch {
            self.error = "La pagina «\(title)» non esiste ancora: Ernie la crea quando ne parlate."
        }
    }

    /// Elimina la pagina (resta nella cronologia di Ernie) e torna alla lista.
    private func delete(_ n: BrainNoteDetail) async {
        guard let api = model.api else { return }
        deleting = true
        do {
            try await api.brainDeleteNote(path: n.path)
            dismiss()
        } catch {
            actionError = AppModel.describe(error)
        }
        deleting = false
    }
}

/// Foglio «Modifica»: testo markdown e riservatezza. Il titolo si mostra soltanto: rinominare le pagine non è ancora previsto.
struct BrainNoteEditor: View {
    let note: BrainNoteDetail
    /// Chiamato con la pagina aggiornata dal server, prima che il foglio si chiuda.
    let onSaved: (BrainNoteResponse) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var isPrivate: Bool
    @State private var saving = false
    @State private var error: String?

    init(note: BrainNoteDetail, onSaved: @escaping (BrainNoteResponse) -> Void) {
        self.note = note
        self.onSaved = onSaved
        _text = State(initialValue: note.body)
        _isPrivate = State(initialValue: note.private)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Titolo") {
                    Text(note.title).foregroundStyle(.secondary)
                }
                Section("Testo") {
                    TextEditor(text: $text)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 240)
                        .scrollContentBackground(.hidden)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityLabel("Testo della pagina")
                }
                Section {
                    Toggle("Riservata", isOn: $isPrivate)
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Modifica")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving {
                            ProgressView().accessibilityLabel("Salvataggio in corso")
                        } else {
                            Text("Salva")
                        }
                    }
                    .disabled(saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }

    /// Salva il testo e, se è cambiata, la riservatezza: il server risponde con la pagina aggiornata.
    private func save() async {
        guard let api = model.api else { return }
        saving = true
        do {
            let updated = try await api.brainUpdateNote(
                path: note.path,
                body: text,
                isPrivate: isPrivate == note.private ? nil : isPrivate
            )
            onSaved(updated)
            dismiss()
        } catch {
            self.error = AppModel.describe(error)
        }
        saving = false
    }
}

/// Tipi che si creano a mano (chi-sono e salute sono pagine che Ernie genera da sola).
private enum BrainNewType: String, CaseIterable, Identifiable {
    case nota, persona, luogo, progetto, argomento
    var id: String { rawValue }

    var label: String {
        switch self {
        case .nota: "Nota"
        case .persona: "Persona"
        case .luogo: "Luogo"
        case .progetto: "Progetto"
        case .argomento: "Argomento"
        }
    }
}

/// Foglio «Nuova nota»: titolo, tipo, testo e riservatezza. Dopo il salvataggio chiama `onCreated` con il titolo.
struct BrainNewNoteSheet: View {
    /// Chiamato con il titolo della nota creata, prima che il foglio si chiuda.
    let onCreated: (String) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var kind: BrainNewType = .nota
    @State private var text = ""
    @State private var isPrivate = false
    @State private var saving = false
    @State private var error: String?

    /// Titolo di almeno due caratteri e testo non vuoto.
    private var valid: Bool {
        title.trimmingCharacters(in: .whitespacesAndNewlines).count >= 2
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Titolo", text: $title)
                } footer: {
                    Text("Almeno due caratteri.")
                }
                Section {
                    Picker("Tipo", selection: $kind) {
                        ForEach(BrainNewType.allCases) { k in
                            Label(k.label, systemImage: BrainType.icon(k.rawValue)).tag(k)
                        }
                    }
                }
                Section("Testo") {
                    ZStack(alignment: .topLeading) {
                        if text.isEmpty {
                            Text(verbatim: "Scrivi qui. Collega altre pagine con [[Titolo]].")
                                .foregroundStyle(.tertiary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 8)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                        TextEditor(text: $text)
                            .font(.system(.body, design: .monospaced))
                            .frame(minHeight: 200)
                            .scrollContentBackground(.hidden)
                            .accessibilityLabel("Testo della nota")
                    }
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                Section {
                    Toggle("Riservata", isOn: $isPrivate)
                }
                if let error {
                    Section { Text(error).font(.footnote).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Nuova nota")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Annulla") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving {
                            ProgressView().accessibilityLabel("Salvataggio in corso")
                        } else {
                            Text("Salva")
                        }
                    }
                    .disabled(!valid || saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }

    /// Crea la pagina sul server, poi chiude il foglio: la schermata apre la nota nuova.
    private func save() async {
        guard let api = model.api else { return }
        saving = true
        do {
            let created = try await api.brainCreateNote(
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                body: text,
                type: kind.rawValue,
                isPrivate: isPrivate
            )
            onCreated(created.note.title)
            dismiss()
        } catch {
            self.error = AppModel.describe(error)
        }
        saving = false
    }
}

/// Foglio «Inoltra email al second brain»: l'indirizzo si legge dal server quando il foglio si apre.
/// Risposta di GET /v1/brain/inbox-address.
struct BrainInbox: Decodable, Sendable {
    var address: String?
    /// Email della scheda (mittente sempre accettato); nil se non è ancora stata detta a Ernie.
    var email: String?
    /// Altri indirizzi dell'utente da cui si accettano gli inoltri (es. quello di lavoro).
    var extraEmails: [String]
}

struct BrainInboxSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address: String?
    @State private var primaryEmail: String?
    @State private var extraEmails: [String] = []
    @State private var newEmail = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var copied = false
    @FocusState private var editing: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Inoltra un'email a questo indirizzo: diventa una nota nel second brain. Vale solo se la mandi da uno degli indirizzi accettati qui sotto.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Section("Indirizzo di Ernie") {
                    if loading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if let address, !address.isEmpty {
                        Text(address)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button {
                            UIPasteboard.general.string = address
                            copied = true
                        } label: {
                            Label(copied ? "Copiato" : "Copia", systemImage: copied ? "checkmark" : "doc.on.doc")
                        }
                    } else if error == nil {
                        Text("Non ancora configurato sul server.")
                            .foregroundStyle(.secondary)
                    }
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
                if !loading, address != nil {
                    Section {
                        if let primaryEmail, !primaryEmail.isEmpty {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(primaryEmail)
                                    Text("Email della scheda").font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: "person.crop.circle").foregroundStyle(Color.accentColor)
                            }
                        } else {
                            Text("Nessuna email nella scheda: dilla a Ernie o aggiungila qui sotto.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        ForEach(extraEmails, id: \.self) { email in
                            Label(email, systemImage: "envelope")
                        }
                        .onDelete { offsets in
                            var next = extraEmails
                            next.remove(atOffsets: offsets)
                            Task { await save(next) }
                        }
                        HStack {
                            TextField("Altro indirizzo (es. lavoro)", text: $newEmail)
                                .textContentType(.emailAddress)
                                .keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($editing)
                                .onSubmit { Task { await add() } }
                            if saving {
                                ProgressView()
                            } else {
                                Button("Aggiungi") { Task { await add() } }
                                    .disabled(!Self.looksLikeEmail(newEmail))
                            }
                        }
                    } header: {
                        Text("Mittenti accettati")
                    } footer: {
                        Text("Le email da altri mittenti vengono ignorate. Scorri a sinistra per togliere un indirizzo.")
                    }
                }
            }
            .navigationTitle("Inoltra email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } }
            }
            .task { await load() }
        }
    }

    /// Legge indirizzo e mittenti dal server (GET /v1/brain/inbox-address).
    private func load() async {
        guard let api = model.api else { loading = false; return }
        loading = true
        do {
            let inbox = try await api.brainInboxAddress()
            address = inbox.address
            primaryEmail = inbox.email
            extraEmails = inbox.extraEmails
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
        loading = false
    }

    private func add() async {
        let email = newEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard Self.looksLikeEmail(email) else { return }
        guard email != primaryEmail?.lowercased(), !extraEmails.contains(email) else { newEmail = ""; return }
        await save(extraEmails + [email])
        if error == nil { newEmail = ""; editing = false }
    }

    /// Salva l'elenco (PATCH /v1/me/settings) e lo rilegge dalla risposta.
    private func save(_ next: [String]) async {
        guard let api = model.api else { return }
        saving = true
        do {
            let settings = try await api.setExtraEmails(next)
            model.applySettings(settings)
            extraEmails = settings["extraEmails"]?.arrayValue?.compactMap(\.stringValue) ?? next
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
        saving = false
    }

    static func looksLikeEmail(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = t.firstIndex(of: "@"), at != t.startIndex else { return false }
        let domain = t[t.index(after: at)...]
        return domain.contains(".") && !domain.hasPrefix(".") && !domain.hasSuffix(".") && !t.contains(" ")
    }
}
