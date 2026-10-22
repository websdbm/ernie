import Foundation
import Observation

struct BrainKnowledge: Codable, Sendable, Equatable {
    var version: Int
    var facts: [BrainFact]
    var routines: [BrainRoutine]
}
struct BrainFact: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var label: String
    var value: String
    var updatedAt: String
}
struct BrainRoutine: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String
    var days: [Int]
    var timeZone: String
    var startTime: String?
    var endTime: String?
    var dropOffTime: String?
    var pickupTime: String?
    var homeTime: String?
    var place: String?
    var validFrom: String?
    var validUntil: String?
    var notes: String?
    var updatedAt: String
    var exceptions: [BrainRoutineException]
}
struct BrainRoutineException: Codable, Sendable, Equatable, Identifiable {
    var date: String
    var status: String
    var startTime: String?
    var endTime: String?
    var dropOffTime: String?
    var pickupTime: String?
    var homeTime: String?
    var place: String?
    var notes: String?
    var id: String { date }
    var clearedFields: [String] = []
    enum CodingKeys: String, CodingKey, CaseIterable {
        case date, status, startTime, endTime, dropOffTime, pickupTime, homeTime, place, notes
    }
    // These are read models only. Occurrences/partial-update semantics are computed by the server.
}
extension BrainRoutineException {
    init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        date = try values.decode(String.self, forKey: .date)
        status = try values.decode(String.self, forKey: .status)
        startTime = try values.decodeIfPresent(String.self, forKey: .startTime)
        endTime = try values.decodeIfPresent(String.self, forKey: .endTime)
        dropOffTime = try values.decodeIfPresent(String.self, forKey: .dropOffTime)
        pickupTime = try values.decodeIfPresent(String.self, forKey: .pickupTime)
        homeTime = try values.decodeIfPresent(String.self, forKey: .homeTime)
        place = try values.decodeIfPresent(String.self, forKey: .place)
        notes = try values.decodeIfPresent(String.self, forKey: .notes)
        clearedFields = try CodingKeys.allCases.filter { key in
            guard key != .date, key != .status, values.contains(key) else { return false }
            return try values.decodeNil(forKey: key)
        }.map(\.rawValue)
    }
}
struct BrainAgenda: Codable, Sendable, Equatable {
    struct Subject: Codable, Sendable, Equatable, Identifiable {
        var path: String
        var title: String
        var id: String { path }
    }
    var date: String
    var timeZone: String
    var entries: [BrainAgendaEntry]
    var subjects: [Subject]
}
struct BrainAgendaEntry: Codable, Sendable, Equatable, Identifiable {
    var notePath: String
    var noteTitle: String
    var routineId: String
    var title: String
    var timeZone: String
    var status: String
    var startTime: String?
    var endTime: String?
    var dropOffTime: String?
    var pickupTime: String?
    var homeTime: String?
    var place: String?
    var notes: String?
    var id: String { notePath + "\u{1f}" + routineId }
}
struct BrainDirectory: Codable, Sendable {
    struct Group: Codable, Sendable, Identifiable {
        var type: String
        var count: Int
        var notes: [BrainNoteSummary]
        var id: String { type }
        var label: String { BrainType(rawValue: type)?.label ?? (type == "chi-sono" ? "Profilo" : type.capitalized) }
        var alphabeticalNotes: [BrainNoteSummary] {
            notes.sorted {
                let order = $0.title.localizedStandardCompare($1.title)
                return order == .orderedSame ? $0.path < $1.path : order == .orderedAscending
            }
        }
    }
    var total: Int
    var groups: [Group]
    var truncated: Bool
    var alphabeticalGroups: [Group] { groups.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending } }
    static func searchResults(_ notes: [BrainNoteSummary]) -> Self {
        .init(total: notes.count, groups: Dictionary(grouping: notes, by: \.type).map {
            Group(type: $0.key, count: $0.value.count, notes: $0.value)
        }, truncated: notes.count >= 200)
    }
}

struct BrainAgendaQuery: Equatable, Sendable {
    var date: String
    var timeZone: String
    var ref: String?
    var requestPath: String {
        var url = URLComponents()
        url.queryItems = [URLQueryItem(name: "date", value: date), URLQueryItem(name: "timeZone", value: timeZone)]
        if let ref { url.queryItems?.append(.init(name: "ref", value: ref)) }
        return "/v1/brain/agenda?" + (url.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
    }
    static func day(_ date: Date, timeZone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: timeZone) ?? .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
extension ApiClient {
    func brainDirectory() async throws -> BrainDirectory {
        try await request("GET", "/v1/brain/directory")
    }
    func brainAgenda(_ query: BrainAgendaQuery) async throws -> BrainAgenda {
        try await request("GET", query.requestPath)
    }
}

/// Date/ref/account identity is checked before exposing a result; no shared or disk cache.
@MainActor @Observable final class BrainAgendaStore {
    private(set) var result: BrainAgenda?
    private(set) var loading = false
    private(set) var error: String?
    private var generation = UUID()
    private var owner: Credentials?
    private var query: BrainAgendaQuery?
    private var task: Task<BrainAgenda, any Error>?
    func result(for query: BrainAgendaQuery, credentials: Credentials?) -> BrainAgenda? {
        credentials != nil && credentials == owner && query == self.query ? result : nil
    }
    func clear() {
        generation = UUID(); task?.cancel(); task = nil
        result = nil; error = nil; loading = false; owner = nil; query = nil
    }
    func load(_ query: BrainAgendaQuery, api: ApiClient) async {
        await load(query, credentials: api.credentials) { try await api.brainAgenda($0) }
    }
    func load(_ query: BrainAgendaQuery, credentials: Credentials,
              using loader: @escaping @MainActor (BrainAgendaQuery) async throws -> BrainAgenda) async {
        clear()
        owner = credentials; self.query = query; loading = true
        let token = generation
        let pending = Task { try await loader(query) }
        task = pending
        do {
            let result = try await withTaskCancellationHandler(operation: { try await pending.value }, onCancel: { pending.cancel() })
            guard generation == token, !Task.isCancelled else { return }
            self.result = result; loading = false; task = nil
        } catch {
            guard generation == token else { return }
            loading = false; task = nil
            guard !(error is CancellationError), !Task.isCancelled else { return }
            self.error = AppModel.describe(error)
        }
    }
}

enum BrainRoutinePresentation {
    static func fieldLabel(_ key: String) -> String {
        switch key {
        case "startTime": "Inizio"
        case "endTime": "Fine"
        case "dropOffTime": "Accompagnamento"
        case "pickupTime": "Ritiro"
        case "homeTime": "Rientro previsto"
        case "place": "Luogo"
        case "notes": "Note"
        default: key
        }
    }
    static func days(_ days: [Int]) -> String {
        let labels = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]
        let selected = Set(days).sorted().filter { (1...7).contains($0) }
        return selected.isEmpty ? "Nessun giorno abituale" : selected.map { labels[$0 - 1] }.joined(separator: ", ")
    }
    static func times(start: String?, end: String?, dropOff: String?, pickup: String?, home: String?) -> [(String, String)] {
        [("Accompagnamento", dropOff), ("Inizio", start), ("Fine", end), ("Ritiro", pickup), ("Rientro previsto", home)]
            .compactMap { label, value in value.flatMap { $0.isEmpty ? nil : (label, $0) } }
    }
}
