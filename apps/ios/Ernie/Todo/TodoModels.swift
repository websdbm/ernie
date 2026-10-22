import Foundation

struct TodoSlot: Codable, Sendable, Equatable, Identifiable {
    var id = UUID().uuidString.lowercased()
    var startAt: String
    var endAt: String
    var fixed = false
    var reminderMinutes: Int? = 30
    var start: Date? { TodoTime.date(startAt) }
    var end: Date? { TodoTime.date(endAt) }
}

struct TodoItem: Codable, Sendable, Equatable, Identifiable {
    enum Kind: String, Codable, Sendable { case group, task }
    enum Status: String, Codable, Sendable { case pending, done, cancelled }
    struct Dependency: Codable, Sendable, Equatable {
        var taskId: String
        var lagMinutes = 0
    }
    var id = UUID().uuidString.lowercased()
    var parentId: String? = nil
    var title: String
    var notes = ""
    var kind: Kind = .task
    var status: Status = .pending
    var position = 0
    var estimatedMinutes: Int? = nil
    var minimumMinutes: Int? = nil
    var splittable = false
    var dependsOn: [Dependency] = []
    var slots: [TodoSlot] = []
}

struct TodoList: Codable, Sendable, Equatable, Identifiable {
    enum Mode: String, Codable, Sendable { case simple, scheduled }
    var id = UUID().uuidString.lowercased()
    var name: String
    var mode: Mode = .simple
    var day: String? = nil
    var timezone = TimeZone.current.identifier
    var revision = 1
    var items: [TodoItem] = []
    var updatedAt = TodoTime.iso(Date())

    var tasks: [TodoItem] { items.filter { $0.kind == .task } }
    var orderedItems: [TodoItem] {
        items.sorted { $0.position == $1.position ? $0.id < $1.id : $0.position < $1.position }
    }
    func groupPath(for item: TodoItem) -> String? {
        var parent = item.parentId
        var titles: [String] = []
        var seen: Set<String> = [item.id]
        while let id = parent, seen.insert(id).inserted, let group = items.first(where: { $0.id == id }) {
            titles.insert(group.title, at: 0)
            parent = group.parentId
        }
        return titles.isEmpty ? nil : titles.joined(separator: " › ")
    }
    /// Conversion is an explicit mutation; the list/timeline picker never calls this.
    func clearingSchedule() -> TodoList {
        var copy = self
        copy.mode = .simple
        copy.day = nil
        for index in copy.items.indices { copy.items[index].slots = [] }
        return copy
    }
}

struct TodoListBlock: Codable, Sendable, Equatable {
    var kind = "todo_list"
    var list: TodoList
}

enum TodoTime {
    enum Phase: Equatable { case past, current, future, invalid }
    static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func iso(_ value: Date) -> String { ISO8601DateFormatter().string(from: value) }
    static func phase(_ slot: TodoSlot, now: Date) -> Phase {
        guard let start = slot.start, let end = slot.end, end > start else { return .invalid }
        if now < start { return .future }
        return now < end ? .current : .past
    }
    static func status(_ item: TodoItem, slot: TodoSlot?, now: Date) -> String? {
        if item.status == .done { return "Completata" }
        if item.status == .cancelled { return "Annullata" }
        guard let slot else { return nil }
        switch phase(slot, now: now) {
        case .past: return "Orario passato · da aggiornare"
        case .current: return "Previsto in questa fascia"
        case .invalid: return "Orario da verificare"
        case .future: return nil
        }
    }
    static func dayLabel(_ list: TodoList) -> String? {
        guard let date = dayStart(list) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "it_IT")
        formatter.timeZone = TimeZone(identifier: list.timezone)
        formatter.dateFormat = "EEEE d MMMM yyyy"
        return formatter.string(from: date).capitalized
    }
    static func clock(_ value: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "it_IT")
        formatter.timeZone = TimeZone(identifier: timezone) ?? .current
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: value)
    }
    static func day(_ value: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timezone) ?? .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: value)
    }
    static func dayStart(_ list: TodoList) -> Date? {
        guard let day = list.day else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: list.timezone)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: day)
    }
}

struct TodoTimelineEntry: Identifiable {
    let item: TodoItem
    let slot: TodoSlot
    var id: String { item.id + ":" + slot.id }
    static func entries(_ list: TodoList) -> [Self] {
        list.tasks.filter { $0.status != .cancelled }.flatMap { item in
            item.slots.map { Self(item: item, slot: $0) }
        }.sorted {
            if $0.slot.start == $1.slot.start { return $0.id < $1.id }
            return ($0.slot.start ?? .distantFuture) < ($1.slot.start ?? .distantFuture)
        }
    }
}
