import Foundation

enum Ids {
    /// UUID minuscolo, come li emette il server.
    static func new() -> String { UUID().uuidString.lowercased() }

    static let iso8601 = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    static func timestamp(_ date: Date = .now) -> String { date.formatted(iso8601) }
}
