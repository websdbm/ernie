import SwiftUI

// MARK: - modelli (REST /v1/brain)

struct BrainNoteSummary: Codable, Sendable, Identifiable, Hashable {
    var path: String
    var title: String
    var type: String
    var created: String
    var refersFrom: String?
    var refersTo: String?
    var place: String?
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
    case nota, persona, luogo, progetto, argomento, documento
    var id: String { rawValue }

    var label: String {
        switch self {
        case .nota: "Note"
        case .persona: "Persone"
        case .luogo: "Luoghi"
        case .progetto: "Progetti"
        case .argomento: "Argomenti"
        case .documento: "Documenti"
        }
    }

    static func icon(_ type: String) -> String {
        switch type {
        case "persona": "person.fill"
        case "luogo": "mappin.and.ellipse"
        case "progetto": "hammer.fill"
        case "argomento": "tag.fill"
        case "documento": "doc.text.fill"
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

    var body: some View {
        NavigationStack(path: $path) {
            List {
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
                if notes.isEmpty, !loading {
                    Section {
                        Text(query.isEmpty
                             ? "Ancora vuoto. Di' a Ernie «annota che…» oppure mandagli una foto da salvare: le note compaiono qui e in Obsidian."
                             : "Nessuna nota trovata per «\(query)».")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                ForEach(notes) { n in
                    NavigationLink(value: n.title) { row(n) }
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
