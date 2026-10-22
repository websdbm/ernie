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
    var resource: BrainResource? = nil
    var id: String { path }
}

struct BrainOverview: Codable, Sendable {
    struct Fact: Codable, Sendable {
        var text: String
        var sourcePath: String
        var sourceTitle: String
        var date: String?
    }
    struct Place: Codable, Sendable, Identifiable {
        var path: String
        var title: String
        var address: String?
        var coords: [Double]?
        var id: String { path }
        var mapsURL: URL? { BrainLocation.mapsURL(coords: coords, title: title) }
    }
    var facts: [Fact]
    var places: [Place]
}

/// Valida dati esterni prima di passare una posizione a MapKit o Mappe.
enum BrainLocation {
    static func coordinate(_ coords: [Double]?) -> CLLocationCoordinate2D? {
        guard let coords, coords.count == 2,
              coords.allSatisfy(\.isFinite), (-90...90).contains(coords[0]), (-180...180).contains(coords[1]) else { return nil }
        return CLLocationCoordinate2D(latitude: coords[0], longitude: coords[1])
    }

    static func mapsURL(coords: [Double]?, title: String) -> URL? {
        guard let coordinate = coordinate(coords) else { return nil }
        var url = URLComponents()
        url.scheme = "https"
        url.host = "maps.apple.com"
        url.queryItems = [URLQueryItem(name: "ll", value: "\(coordinate.latitude),\(coordinate.longitude)"),
                          URLQueryItem(name: "q", value: title)]
        return url.url
    }

    static func noteURL(path: String) -> URL? {
        var url = URLComponents()
        url.scheme = "ernie-brain"
        url.host = "note"
        url.queryItems = [BrainDestination.reference(path).queryItem]
        return url.url
    }
}

struct BrainNoteDetail: Codable, Sendable {
    var path: String
    var title: String
    var type: String
    var created: String
    var refersFrom: String?
    var refersTo: String?
    var place: String?
    var coords: [Double]?
    var links: [String]
    var `private`: Bool
    var source: String?
    var body: String
    var overview: BrainOverview?
    var resource: BrainResource? = nil
    var resourceLinks: [String]? = nil
    var knowledge: BrainKnowledge? = nil
    var hasKnowledge: Bool { knowledge?.version == 1 && (!(knowledge?.facts.isEmpty ?? true) || !(knowledge?.routines.isEmpty ?? true)) }

    /// Un server precedente può non inviare il riepilogo: il corpo resta allora interamente visibile.
    var hasOverview: Bool {
        guard type == "persona" || type == "luogo", let overview else { return false }
        return !overview.facts.isEmpty || !overview.places.isEmpty
    }

    var visiblePlaces: [BrainOverview.Place] {
        var places = hasOverview ? overview?.places ?? [] : []
        if BrainLocation.coordinate(coords) != nil {
            if let index = places.firstIndex(where: { $0.path == path }) {
                if BrainLocation.coordinate(places[index].coords) == nil { places[index].coords = coords }
            } else {
                let linkedPlace = place?.trimmingCharacters(in: .whitespacesAndNewlines)
                let positionTitle = type == "immagine"
                    ? (linkedPlace?.isEmpty == false ? linkedPlace! : "Posizione dello scatto")
                    : (type == "luogo" ? title : "Posizione citata")
                places.insert(.init(path: path, title: positionTitle, coords: coords), at: 0)
            }
        }
        func rank(_ place: BrainOverview.Place) -> Int {
            if place.path == path { return 0 }
            if BrainLocation.coordinate(place.coords) != nil { return 1 }
            if let address = place.address, !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return 2 }
            return 3
        }
        return places.enumerated().sorted { lhs, rhs in
            let left = rank(lhs.element), right = rank(rhs.element)
            return left == right ? lhs.offset < rhs.offset : left < right
        }.map(\.element)
    }
}

struct BrainNoteResponse: Decodable, Sendable {
    var note: BrainNoteDetail
    var backlinks: [String]
    var related: [BrainRelatedNote]? = nil
}

extension ApiClient {
    func brainNotes(query: String?, type: String?, limit: Int? = nil) async throws -> [BrainNoteSummary] {
        struct Out: Decodable { var notes: [BrainNoteSummary] }
        var items: [URLQueryItem] = []
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let type { items.append(URLQueryItem(name: "type", value: type)) }
        if let limit { items.append(URLQueryItem(name: "limit", value: String(min(200, max(1, limit))))) }
        var c = URLComponents()
        c.queryItems = items.isEmpty ? nil : items
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        let out: Out = try await request("GET", "/v1/brain/notes\(c.percentEncodedQuery.map { "?\($0)" } ?? "")")
        return out.notes
    }

    func brainNote(title: String) async throws -> BrainNoteResponse {
        try await brainNote(destination: .title(title))
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
    case nota, persona, luogo, progetto, argomento, documento, salute, ricetta, immagine
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
        case .ricetta: "Ricette"
        case .immagine: "Immagini"
        }
    }

    static func icon(_ type: String) -> String {
        switch type {
        case "ricetta": "fork.knife"
        case "immagine": "photo.fill"
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

    /// I marcatori gestiscono la sincronizzazione sul server: non sono contenuto della scheda.
    /// Vale anche per anteprime troncate nel mezzo di un commento; il testo originale resta nell'editor.
    static func visibleText(_ body: String) -> String {
        body.replacingOccurrences(of: #"<!--\s*/?ernie:[\s\S]*?(?:-->|$)"#, with: "", options: .regularExpression)
    }

    static func displayBody(_ body: String, title: String) -> String {
        var text = visibleText(body).trimmingCharacters(in: .whitespacesAndNewlines)
        // Il titolo è già nell'intestazione: togli solo la prima intestazione identica, non le altre sezioni.
        if let first = text.components(separatedBy: "\n").first,
           first.replacingOccurrences(of: #"^#{1,6}\s+"#, with: "", options: .regularExpression) == title,
           first.hasPrefix("#") {
            text = String(text.dropFirst(first.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text.components(separatedBy: "\n").map { line in
            if let m = line.firstMatch(of: /^Nascita: (\d{4}-\d{2}-\d{2})\.$/) {
                return "Nascita: \(when(created: String(m.1), from: nil, to: nil))."
            }
            if line.hasPrefix("### "), let m = line.firstMatch(of: /\s· (\d{4}-\d{2}-\d{2})$/) {
                return String(line[..<m.range.lowerBound]) + " · " + when(created: String(m.1), from: nil, to: nil)
            }
            return line
        }.joined(separator: "\n").replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
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
            c.queryItems = [BrainDestination.reference(title).queryItem]
            out += "[\(label)](\(c.url?.absoluteString ?? ""))"
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}

/// Suddivisione solo visiva: conserva ordine, testo e collegamenti del Markdown originale.
struct BrainPageSection: Equatable {
    var title: String?
    var date: String?
    var level: Int
    var body: String
}

enum BrainPageLayout {
    static func dateLabel(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespaces)
        let format: String
        if value.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil { format = "yyyy-MM-dd" }
        else if value.wholeMatch(of: /\d{1,2} [A-Za-z]+ \d{4}/) != nil { format = "d MMMM yyyy" }
        else { return nil }
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "it_IT")
        parser.calendar = Calendar(identifier: .gregorian)
        parser.timeZone = TimeZone(secondsFromGMT: 0)
        parser.isLenient = false
        parser.dateFormat = format
        guard let date = parser.date(from: value),
              parser.string(from: date).lowercased() == value.lowercased() else { return nil }
        parser.dateFormat = "d MMMM yyyy"
        return parser.string(from: date)
    }

    static func heading(_ text: String) -> (title: String?, date: String?) {
        if let date = dateLabel(text) { return (nil, date) }
        if let range = text.range(of: " · ", options: .backwards),
           let date = dateLabel(String(text[range.upperBound...])) {
            return (String(text[..<range.lowerBound]), date)
        }
        if let m = text.firstMatch(of: /^(.+) \(([^()]+)\)$/), let date = dateLabel(String(m.2)) {
            return (String(m.1), date)
        }
        return (text, nil)
    }

    static func sections(_ body: String, title: String) -> [BrainPageSection] {
        let visible = BrainFormat.displayBody(body, title: title)
        var result: [BrainPageSection] = []
        var current = BrainPageSection(title: nil, date: nil, level: 0, body: "")
        var lines: [String] = []
        var fence: String?
        func flush() {
            current.body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if current.title != nil || current.date != nil || !current.body.isEmpty { result.append(current) }
            lines = []
        }
        for line in visible.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let opening = fence {
                lines.append(line)
                if trimmed.hasPrefix(opening) { fence = nil }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                fence = String(trimmed.prefix(3)); lines.append(line); continue
            }
            if let m = trimmed.firstMatch(of: /^(#{1,6})\s+(.+)$/) {
                let level = m.1.count
                let h = heading(String(m.2))
                // I sottotitoli di una voce datata rimangono nel suo riquadro.
                if current.date != nil, h.date == nil, level > current.level { lines.append(line); continue }
                flush()
                current = BrainPageSection(title: h.title, date: h.date, level: level, body: "")
            } else { lines.append(line) }
        }
        flush()
        return result
    }
}

// MARK: - elenco

/// Modo di vista della schermata Second brain.
enum BrainViewMode: String, CaseIterable, Identifiable {
    case indice, elenco, tempo, mappa
    var id: String { rawValue }

    var label: String {
        switch self {
        case .indice: "Indice"
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
    @State private var loadGeneration = UUID()
    @State private var query = ""
    @State private var type: String?
    @State private var loading = true
    @State private var error: String?
    @State private var path: [BrainDestination] = []
    @State private var mode: BrainViewMode = .indice
    @State private var directory: BrainDirectory?
    @State private var showAgenda = false
    @State private var camera: MapCameraPosition = .automatic
    /// Foglio «Nuova nota» aperto.
    @State private var creating = false
    /// Foglio «Inoltra email al second brain» aperto.
    @State private var showInbox = false
    /// Titolo della nota appena creata: si apre quando il foglio «Nuova nota» si chiude.
    @State private var openAfterCreate: String?

    init(initialPath: String? = nil) {
        _path = State(initialValue: initialPath.map { [.path($0)] } ?? [])
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    BrainModePicker(mode: $mode)
                }
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            chip("Tutte", selected: type == nil) { type = nil }
                            ForEach(BrainType.allCases) { t in
                                chip(t.label, selected: type == t.rawValue) { type = (type == t.rawValue ? nil : t.rawValue) }
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                }
                if mode == .indice {
                    Section {
                        Button("Orari per data", systemImage: "calendar") { showAgenda = true }
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
                if loading { Section { ProgressView("Carico le schede…") } }
                if mode != .indice, notes.count >= 200 {
                    Section { Text("Prime 200 schede visualizzate. Restringi la ricerca per trovare le altre.").font(.footnote).foregroundStyle(.secondary) }
                }
                if mode != .mappa, notes.isEmpty, (directory?.total ?? 0) == 0, !loading, error == nil {
                    Section {
                        Text(query.isEmpty
                             ? "Ancora vuoto. Di' a Ernie «annota che…» oppure mandagli una foto da salvare: le note compaiono qui e in Obsidian."
                             : "Nessuna nota trovata per «\(query)».")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                switch mode {
                case .indice:
                    if let directory {
                        BrainDirectorySections(directory: directory, searching: !query.isEmpty || type != nil) { selected in
                            type = selected; mode = .elenco
                        }
                    }
                case .elenco:
                    ForEach(notes) { n in
                        NavigationLink(value: BrainDestination.path(n.path)) { row(n) }
                    }
                case .tempo:
                    ForEach(timeline) { m in
                        Section {
                            ForEach(m.notes) { n in
                                NavigationLink(value: BrainDestination.path(n.path)) { row(n) }
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
                                        Button { path.append(.path(p.note.path)) } label: {
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
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red); Button("Riprova") { Task { await load() } } } }
            }
            .navigationTitle("Second brain")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Cerca nelle note")
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
            .sheet(isPresented: $showAgenda) {
                NavigationStack {
                    BrainAgendaView { source in showAgenda = false; path.append(.reference(source)) }
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { showAgenda = false } } }
                }
            }
            .sheet(isPresented: $showInbox) {
                BrainInboxSheet()
            }
            .navigationDestination(for: BrainDestination.self) { target in
                BrainNoteView(target: target, path: $path)
            }
            .task(id: [query, type ?? "", mode.rawValue]) {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
                await load()
            }
            .onChange(of: model.credentials) { _, _ in
                loadGeneration = UUID(); notes = []; directory = nil; error = nil
                Task { await load() }
            }
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
            guard let coordinate = BrainLocation.coordinate(n.coords) else { return nil }
            return BrainPin(note: n, coordinate: coordinate)
        }
    }

    private func row(_ n: BrainNoteSummary) -> some View {
        BrainNoteRow(note: n)
    }

    /// Anteprima senza segni di markdown né parentesi dei collegamenti.
    static func plain(_ s: String) -> String {
        var t = BrainFormat.visibleText(s)
            .replacingOccurrences(of: #"\[\[[^\]|]+\|([^\]]+)\]\]"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[[", with: "").replacingOccurrences(of: "]]", with: "")
        for mark in ["**", "__", "`"] { t = t.replacingOccurrences(of: mark, with: "") }
        return t.replacingOccurrences(of: #"(^|\s)#{1,6}\s"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"(^|\s)[>*-]\s"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    }

    /// Dopo il foglio «Nuova nota»: apre la pagina appena creata (se il foglio ha salvato).
    private func openCreatedNote() {
        guard let title = openAfterCreate else { return }
        openAfterCreate = nil
        path.append(.path(title))
    }

    private func load() async {
        guard let api = model.api else { notes = []; directory = nil; loading = false; return }
        let token = UUID()
        loadGeneration = token
        let search = query
        let filter = type
        let viewMode = mode
        loading = true; notes = []; directory = nil; error = nil
        defer { if loadGeneration == token { loading = false } }
        do {
            let result: [BrainNoteSummary]
            let index: BrainDirectory?
            if viewMode == .indice, search.trimmingCharacters(in: .whitespaces).isEmpty, filter == nil {
                index = try await api.brainDirectory()
                result = []
            } else {
                result = try await api.brainNotes(query: search.trimmingCharacters(in: .whitespaces), type: filter, limit: 200)
                index = viewMode == .indice ? .searchResults(result) : nil
            }
            guard loadGeneration == token, query == search, type == filter, mode == viewMode, model.credentials == api.credentials, !Task.isCancelled else { return }
            notes = result; directory = index
            error = nil
        } catch {
            guard loadGeneration == token, query == search, type == filter, mode == viewMode, model.credentials == api.credentials, !Task.isCancelled else { return }
            self.error = AppModel.describe(error)
        }
    }
}

// MARK: - nota

extension BrainNoteDetail {
    /// Pagine che Ernie aggiorna da sola (anagrafica e saluto): non si modificano né si eliminano a mano.
    var isGenerated: Bool { type == "chi-sono" || type == "salute" || isResourceProjection }
    var isResourceProjection: Bool { resource != nil || type == "ricetta" || type == "immagine" }

    /// Si può modificare o eliminare: la pagina esiste sul disco (ha un percorso) e non è generata da Ernie.
    var isEditable: Bool { !path.isEmpty && !isGenerated }
}

/// Anteprima: titolo, data e riassunto hanno ruoli tipografici distinti.
struct BrainNoteRow: View {
    let note: BrainNoteSummary

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: BrainType.icon(note.type))
                .font(.body).foregroundStyle(Theme.accentText)
                .frame(width: 34, height: 34)
                .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(note.title).font(.headline).foregroundStyle(Theme.ink).lineLimit(2)
                    if note.private { Image(systemName: "lock.fill").font(.caption).foregroundStyle(Theme.inkSecondary).accessibilityLabel("Riservata") }
                }
                Label(BrainFormat.when(created: note.created, from: note.refersFrom, to: note.refersTo), systemImage: "calendar")
                    .font(.caption.weight(.medium)).foregroundStyle(Theme.accentText)
                if let place = note.place, !place.isEmpty {
                    Label(place, systemImage: "mappin.and.ellipse").font(.caption).foregroundStyle(Theme.inkSecondary)
                }
                if !note.excerpt.isEmpty {
                    Text(SecondBrainView.plain(note.excerpt))
                        .font(.subheadline).foregroundStyle(Theme.inkSecondary).lineSpacing(2).lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
    }
}

/// Contenuto di lettura condiviso dalla scheda e dalle verifiche visive; l'editor conserva il markdown originale.
struct BrainNoteContent: View {
    let note: BrainNoteDetail
    let backlinks: [String]
    var openAgenda: (() -> Void)?
    @State private var historyExpanded: Bool

    init(note: BrainNoteDetail, historyExpanded: Bool = false, backlinks: [String] = [], openAgenda: (() -> Void)? = nil) {
        self.openAgenda = openAgenda
        self.note = note
        self.backlinks = backlinks
        _historyExpanded = State(initialValue: historyExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            Divider()
            if note.hasKnowledge, let knowledge = note.knowledge {
                BrainKnowledgeContent(knowledge: knowledge, openAgenda: openAgenda)
            }
            if note.hasOverview || note.hasKnowledge {
                if !note.hasKnowledge, let overview = note.overview, !overview.facts.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Riepilogo").font(.headline).accessibilityAddTraits(.isHeader)
                        ForEach(Array(overview.facts.enumerated()), id: \.offset) { _, fact in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(Markdown.render(BrainFormat.linkify(BrainFormat.displayBody(fact.text, title: ""))))
                                    .font(.body).lineSpacing(2).foregroundStyle(Theme.ink)
                                    .fixedSize(horizontal: false, vertical: true)
                                if fact.sourcePath != note.path || fact.date != nil {
                                    VStack(alignment: .leading, spacing: 2) {
                                        if let date = fact.date {
                                            Text("Aggiornamento del \(BrainFormat.when(created: date, from: nil, to: nil))")
                                        }
                                        if fact.sourcePath != note.path, let url = BrainLocation.noteURL(path: fact.sourcePath) {
                                            Link("Fonte: \(fact.sourceTitle)", destination: url)
                                        }
                                    }
                                    .font(.caption).foregroundStyle(Theme.inkSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                }
                places
                Divider()
                DisclosureGroup(isExpanded: $historyExpanded) {
                    VStack(alignment: .leading, spacing: 20) {
                        if let source = note.source, !source.isEmpty {
                            Text("Origine della scheda: \(source)").font(.footnote).foregroundStyle(Theme.inkSecondary)
                        }
                        originalContent
                        if !backlinks.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Pagine che citano questa nota").font(.headline)
                                ForEach(backlinks, id: \.self) { title in
                                    if let url = BrainLocation.noteURL(path: title) {
                                        Link(title, destination: url).font(.callout)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.top, 12)
                } label: {
                    Label("Storico e fonti", systemImage: "clock.arrow.circlepath")
                        .font(.headline).foregroundStyle(Theme.ink)
                }
            } else {
                places
                originalContent
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .tint(Theme.accentText)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: BrainType.icon(note.type))
                    .font(.title3).foregroundStyle(Theme.accentText)
                    .frame(width: 32, height: 36).accessibilityHidden(true)
                Text(note.title).font(.title2.bold()).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("\(note.refersFrom == nil ? "Scheda del" : "Periodo") \(BrainFormat.when(created: note.created, from: note.refersFrom, to: note.refersTo))")
                if note.visiblePlaces.isEmpty, let place = note.place, !place.isEmpty {
                    Text("Luogo citato: \(place)")
                }
                if !note.hasOverview, let source = note.source, !source.isEmpty { Text("Fonte: \(source)") }
                if note.private { Label("Pagina riservata", systemImage: "lock.fill") }
            }
            .font(.caption).foregroundStyle(Theme.inkSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var places: some View {
        if !note.visiblePlaces.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(note.type == "luogo" ? "Posizione" : "Luoghi collegati")
                    .font(.headline).accessibilityAddTraits(.isHeader)
                ForEach(note.visiblePlaces) { place in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(place.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        if let address = place.address, !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text(address).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        } else if place.mapsURL != nil {
                            Text("Posizione salvata").font(.subheadline).foregroundStyle(Theme.inkSecondary)
                        }
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 20) { placeActions(place) }
                                .fixedSize(horizontal: true, vertical: false)
                            VStack(alignment: .leading, spacing: 2) { placeActions(place) }
                        }
                        .font(.subheadline.weight(.medium))
                    }
                }
            }
        }
    }

    @ViewBuilder private func placeActions(_ place: BrainOverview.Place) -> some View {
        if let mapsURL = place.mapsURL {
            Link(destination: mapsURL) { Label("Apri in Mappe", systemImage: "map") }
                .accessibilityLabel("Apri \(place.title) in Mappe")
                .frame(minHeight: 44, alignment: .leading)
        }
        if place.path != note.path, let url = BrainLocation.noteURL(path: place.path) {
            Link(destination: url) { Label("Apri la scheda", systemImage: "arrow.up.right.square") }
                .accessibilityLabel("Apri la scheda \(place.title)")
                .frame(minHeight: 44, alignment: .leading)
        }
    }

    private var originalContent: some View {
        ForEach(Array(BrainPageLayout.sections(note.body, title: note.title).enumerated()), id: \.offset) { _, section in
            BrainPageSectionView(section: section)
        }
    }
}

private struct BrainPageSectionView: View {
    let section: BrainPageSection

    var body: some View {
        if let date = section.date {
            VStack(alignment: .leading, spacing: 14) {
                Label(date, systemImage: "calendar")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accentText)
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 9))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let title = section.title {
                    Text(Markdown.render(BrainFormat.linkify(title)))
                        .font(.headline).foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                }
                if !section.body.isEmpty {
                    Divider()
                    content
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceMuted, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.hairline, lineWidth: 1))
        } else {
            VStack(alignment: .leading, spacing: 14) {
                if let title = section.title {
                    Text(Markdown.render(BrainFormat.linkify(title)))
                        .font(section.level <= 2 ? .title3.weight(.bold) : .headline)
                        .foregroundStyle(Theme.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                }
                if !section.body.isEmpty { content }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var content: some View {
        MarkdownText(text: BrainFormat.linkify(section.body), quoteColor: Theme.ink)
            .foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct BrainNoteView: View {
    let target: BrainDestination
    private var title: String { target.displayName }
    @Binding var path: [BrainDestination]
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var data: BrainNoteResponse?
    @State private var loadGeneration = UUID()
    @State private var error: String?
    @State private var editing = false
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var actionError: String?
    @State private var openedResource: BrainResource?
    @State private var linking = false
    @State private var showAgenda = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let n = data?.note {
                    BrainNoteContent(note: n, backlinks: data?.related == nil ? data?.backlinks ?? [] : [], openAgenda: { showAgenda = true })
                        .environment(\.openURL, OpenURLAction { url in
                            guard let destination = BrainDestination(url: url) else { return .systemAction }
                            path.append(destination)
                            return .handled
                        })
                    if n.isResourceProjection {
                        BrainResourceActions(resource: n.resource, type: n.type, open: { openedResource = $0 }, link: { linking = true })
                    } else if n.isGenerated {
                        Text("Pagina generata da Ernie: si aggiorna da sola.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let actionError {
                        Text(actionError).font(.footnote).foregroundStyle(.red)
                    }
                    if let related = data?.related, !related.isEmpty {
                        BrainRelatedNotes(notes: related, openMedia: { openedResource = $0 }) { path.append(.path($0)) }
                    }
                    if data?.related == nil, !n.hasOverview, !(data?.backlinks ?? []).isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Divider().padding(.bottom, 8)
                            Text("Pagine che citano questa nota").font(.headline).accessibilityAddTraits(.isHeader)
                            ForEach(data?.backlinks ?? [], id: \.self) { b in
                                Button { path.append(.reference(b)) } label: {
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
            .padding(.horizontal, 20).padding(.vertical, 24)
            .frame(maxWidth: 700, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.surface)
        .navigationTitle(data?.note.title ?? title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let n = data?.note, n.isEditable {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { editing = true } label: { Label(n.hasKnowledge ? "Modifica testo" : "Modifica", systemImage: "pencil") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label("Elimina", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(deleting)
                    .accessibilityLabel("Altre azioni sulla pagina")
                }
            }
        }
        .sheet(isPresented: $showAgenda) {
            NavigationStack {
                BrainAgendaView(ref: data?.note.path) { source in
                    showAgenda = false
                    if source != data?.note.path { path.append(.reference(source)) }
                }.toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { showAgenda = false } } }
            }
        }
        .sheet(isPresented: $editing) {
            if let n = data?.note {
                BrainNoteEditor(note: n) { updated in loadGeneration = UUID(); data = updated }
            }
        }
        .sheet(item: $openedResource, onDismiss: { Task { await load() } }) { resource in
            BrainOriginalResourceView(resource: resource)
        }
        .sheet(isPresented: $linking) {
            if let note = data?.note, let resource = note.resource {
                BrainResourceLinksSheet(resource: resource, initial: note.resourceLinks ?? []) { Task { await load() } }
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
        let token = UUID()
        loadGeneration = token
        do {
            let result = try await api.brainNote(destination: target)
            guard loadGeneration == token, model.credentials == api.credentials, !Task.isCancelled else { return }
            data = result
            error = nil
        } catch {
            guard loadGeneration == token, model.credentials == api.credentials, !Task.isCancelled else { return }
            self.error = BrainLoadingError.message(error, title: title)
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
                    if note.hasKnowledge {
                        Text("Fatti e orari si aggiornano tramite la chat con Ernie. Qui puoi modificare il testo della pagina.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
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
            onCreated(created.note.path)
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

/// Un problema di rete non equivale a una pagina inesistente.
enum BrainLoadingError {
    static func message(_ error: any Error, title: String) -> String {
        if let error = error as? ApiError, error.status == 404 {
            return "La pagina «\(title)» non esiste ancora: Ernie la crea quando ne parlate."
        }
        return "Non riesco a caricare la pagina: \(AppModel.describe(error))"
    }
}
