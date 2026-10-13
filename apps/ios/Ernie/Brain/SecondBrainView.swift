import SwiftUI
import MapKit

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
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } }
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

struct BrainNoteView: View {
    let title: String
    @Binding var path: [String]
    @Environment(AppModel.self) private var model
    @State private var data: BrainNoteResponse?
    @State private var error: String?

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
}
