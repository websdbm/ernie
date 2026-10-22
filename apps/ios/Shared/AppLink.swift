import Foundation

/// Contratto condiviso fra widget e app. Ogni area apre una sola funzione.
enum AppLink: String, CaseIterable, Equatable, Sendable {
    case voice, chat, family, reminders, automations

    var url: URL { URL(string: "ernie://\(rawValue)")! }

    init?(url: URL) {
        guard url.scheme?.lowercased() == "ernie", url.user == nil, url.password == nil,
              url.port == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let host = url.host()?.lowercased(), let value = Self(rawValue: host) else { return nil }
        self = value
    }
}
