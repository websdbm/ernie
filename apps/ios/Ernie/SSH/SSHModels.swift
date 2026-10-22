import Foundation

enum SshProvider: String, Codable, Sendable, CaseIterable, Identifiable {
    case vultr, contabo
    var id: String { rawValue }
    var title: String { self == .vultr ? "Vultr" : "Contabo" }
}

struct SshServerInput: Codable, Sendable, Equatable {
    var id: String? = nil
    var name: String
    var host: String
    var port = 22
    var username = "root"
    var provider: SshProvider? = nil
    var providerInstanceId: String? = nil
}

struct SshServer: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var host: String
    var port: Int
    var username: String
    var provider: SshProvider?
    var providerInstanceId: String?
    var fingerprint: String?
    var revision: Int
    var lastCheckedAt: String?
    var lastStatus: String?
    var displayLastStatus: String? {
        guard let lastStatus else { return nil }
        switch lastStatus {
        case "key_install_required": return "Installa la chiave pubblica sul server"
        case "key_revoked": return "Chiave SSH revocata"
        case "host_key_changed": return "L’impronta del server è cambiata: accesso bloccato"
        case "host_probed": return "Impronta letta: verifica richiesta"
        case "host_trusted": return "Impronta verificata"
        default:
            let parts = lastStatus.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2, let check = SshDiagnosticInput.Check(rawValue: parts[0]),
                  ["ok", "failed"].contains(parts[1]) else { return "Stato da verificare" }
            return "\(check.title): \(parts[1] == "ok" ? "controllo riuscito" : "controllo non riuscito")"
        }
    }
    var input: SshServerInput {
        .init(id: id, name: name, host: host, port: port, username: username, provider: provider, providerInstanceId: providerInstanceId)
    }
}

struct SshSiteInput: Codable, Sendable, Equatable {
    var id: String? = nil
    var serverId: String
    var name: String
    var url: String
    var path = ""
    var container = ""
}
struct SshSite: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var serverId: String
    var name: String
    var url: String
    var path: String
    var container: String
    var input: SshSiteInput { .init(id: id, serverId: serverId, name: name, url: url, path: path, container: container) }
}
struct SshKeyInfo: Codable, Sendable, Equatable {
    var publicKey: String
    var fingerprint: String
    var createdAt: String
}
struct SshProviderInfo: Codable, Sendable, Equatable, Identifiable {
    var provider: SshProvider
    var connected: Bool
    var lastCheckedAt: String?
    var id: String { provider.rawValue }
}

/// Only the protected credential form creates this value. No client storage or logging.
enum SshProviderCredentials: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    case vultr(apiKey: String)
    case contabo(clientId: String, clientSecret: String, username: String, password: String)
    var provider: SshProvider { if case .vultr = self { return .vultr }; return .contabo }
    var description: String { "Credenziali \(provider.title) [redatte]" }
    var debugDescription: String { description }
    enum CodingKeys: CodingKey { case provider, apiKey, clientId, clientSecret, username, password }
    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(SshProvider.self, forKey: .provider) {
        case .vultr: self = .vultr(apiKey: try c.decode(String.self, forKey: .apiKey))
        case .contabo:
            self = .contabo(clientId: try c.decode(String.self, forKey: .clientId), clientSecret: try c.decode(String.self, forKey: .clientSecret), username: try c.decode(String.self, forKey: .username), password: try c.decode(String.self, forKey: .password))
        }
    }
    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(provider, forKey: .provider)
        switch self {
        case .vultr(let key): try c.encode(key, forKey: .apiKey)
        case .contabo(let id, let secret, let username, let password):
            try c.encode(id, forKey: .clientId); try c.encode(secret, forKey: .clientSecret)
            try c.encode(username, forKey: .username); try c.encode(password, forKey: .password)
        }
    }
}

struct SshProviderInstance: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var ip: String
    var status: String
    var displayStatus: String {
        switch status.lowercased() {
        case "running", "active": "Acceso"
        case "stopped", "shutoff", "powered_off": "Spento"
        case "pending", "provisioning", "installing": "In preparazione"
        case "restarting", "rebooting": "Riavvio in corso"
        case "suspended": "Sospeso"
        case "error", "failed": "Errore"
        default: "Stato da verificare"
        }
    }
}
struct SshDiagnosticInput: Codable, Sendable, Equatable {
    enum Check: String, Codable, Sendable, CaseIterable, Identifiable {
        case overview, disk, services, logs, docker, wordpress
        var id: String { rawValue }
        var title: String {
            switch self {
            case .overview: "Panoramica e connessione"
            case .disk: "Spazio disco"
            case .services: "Servizi"
            case .logs: "Log recenti"
            case .docker: "Docker"
            case .wordpress: "WordPress / WP-CLI"
            }
        }
    }
    var serverId: String
    var check: Check
    var siteId: String? = nil
}
struct SshPlanInput: Codable, Sendable, Equatable {
    enum Kind: String, Codable, Sendable, CaseIterable, Identifiable {
        case ssh, wpCli = "wp_cli", providerReboot = "provider_reboot"
        var id: String { rawValue }
        var title: String {
            switch self { case .ssh: "SSH"; case .wpCli: "WP-CLI"; case .providerReboot: "Riavvio tramite provider" }
        }
    }
    var serverId: String
    var kind: Kind
    var title: String
    var reason: String
    var command = ""
    var verificationCommand = ""
    var backup: String
    var rollback: String
    var siteId: String? = nil
}
struct SshOperation: Codable, Sendable, Equatable, Identifiable {
    enum Status: String, Codable, Sendable {
        case pending, running, succeeded, failed, uncertain, rejected, expired
        var title: String {
            switch self {
            case .pending: "Da approvare"; case .running: "In esecuzione"; case .succeeded: "Riuscita"
            case .failed: "Non riuscita"; case .uncertain: "Esito incerto"; case .rejected: "Rifiutata"; case .expired: "Scaduta"
            }
        }
    }
    var serverId: String
    var kind: SshPlanInput.Kind
    var title: String
    var reason: String
    var command: String
    var verificationCommand: String
    var backup: String
    var rollback: String
    var siteId: String?
    var id: String
    var serverName: String
    var host: String
    var status: Status
    var createdAt: String
    var expiresAt: String
    var output: String?
    func canDecide(now: Date = .now) -> Bool {
        guard status == .pending, let expiry = SSHFormatting.date(expiresAt) else { return false }
        return now < expiry
    }
}
struct SshSnapshot: Codable, Sendable, Equatable {
    var configured: Bool
    var key: SshKeyInfo?
    var servers: [SshServer]
    var sites: [SshSite]
    var providers: [SshProviderInfo]
    var operations: [SshOperation]
    static let empty = SshSnapshot(configured: false, key: nil, servers: [], sites: [], providers: [], operations: [])
}
struct SshImportInput: Codable, Sendable, Equatable {
    struct Server: Codable, Sendable, Equatable, Identifiable {
        var name: String
        var host: String
        var port: Int
        var username: String
        var provider: SshProvider?
        var providerInstanceId: String?
        var sourceId: String
        var id: String { sourceId }
        enum CodingKeys: CodingKey { case name, host, port, username, provider, providerInstanceId, sourceId }
        init(name: String, host: String, port: Int = 22, username: String = "root", provider: SshProvider? = nil, providerInstanceId: String? = nil, sourceId: String) {
            self.name = name; self.host = host; self.port = port; self.username = username
            self.provider = provider; self.providerInstanceId = providerInstanceId; self.sourceId = sourceId
        }
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name); host = try c.decode(String.self, forKey: .host)
            port = try c.decodeIfPresent(Int.self, forKey: .port) ?? 22
            username = try c.decodeIfPresent(String.self, forKey: .username) ?? "root"
            provider = try c.decodeIfPresent(SshProvider.self, forKey: .provider)
            providerInstanceId = try c.decodeIfPresent(String.self, forKey: .providerInstanceId)
            sourceId = try c.decode(String.self, forKey: .sourceId)
        }
    }
    struct Site: Codable, Sendable, Equatable, Identifiable {
        var name: String
        var url: String
        var path: String
        var container: String
        var sourceId: String
        var serverSourceId: String
        var id: String { sourceId }
        enum CodingKeys: CodingKey { case name, url, path, container, sourceId, serverSourceId }
        init(name: String, url: String, path: String = "", container: String = "", sourceId: String, serverSourceId: String) {
            self.name = name; self.url = url; self.path = path; self.container = container
            self.sourceId = sourceId; self.serverSourceId = serverSourceId
        }
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name); url = try c.decode(String.self, forKey: .url)
            path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
            container = try c.decodeIfPresent(String.self, forKey: .container) ?? ""
            sourceId = try c.decode(String.self, forKey: .sourceId)
            serverSourceId = try c.decode(String.self, forKey: .serverSourceId)
        }
    }
    var source: String
    var servers: [Server]
    var sites: [Site]
    func selecting(servers selectedServers: Set<String>, sites selectedSites: Set<String>) -> Self {
        let sites = sites.filter { selectedSites.contains($0.sourceId) }
        let required = selectedServers.union(sites.map(\.serverSourceId))
        return .init(source: source, servers: servers.filter { required.contains($0.sourceId) }, sites: sites)
    }
}
struct SshImportPreview: Codable, Sendable, Equatable {
    var serversNew: Int
    var serversUpdated: Int
    var sitesNew: Int
    var sitesUpdated: Int
    var missing: [String]
}

enum SSHFormatting {
    static func date(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
    static func timestamp(_ string: String) -> String {
        guard let date = date(string) else { return string }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    static let uncertain = "Esito incerto: non ripetere l’operazione. Verifica lo stato del provider e del server prima di qualsiasi nuovo intervento."
}

enum SSHInventoryFilter {
    static func servers(_ servers: [SshServer], query: String) -> [SshServer] {
        let terms = tokens(query)
        return servers.filter { server in
            matches(terms, fields: [server.name, server.host, server.username, server.provider?.title ?? "", server.providerInstanceId ?? ""])
        }
    }
    static func sites(_ sites: [SshSite], servers: [SshServer], query: String, serverId: String?) -> [SshSite] {
        let terms = tokens(query)
        let lookup = Dictionary(servers.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return sites.filter { site in
            guard serverId == nil || site.serverId == serverId else { return false }
            let server = lookup[site.serverId]
            return matches(terms, fields: [site.name, site.url, site.path, site.container, server?.name ?? "", server?.host ?? ""])
        }
    }
    private static func normalized(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "it_IT"))
    }
    private static func tokens(_ query: String) -> [String] {
        normalized(query).split(whereSeparator: \.isWhitespace).map(String.init)
    }
    private static func matches(_ terms: [String], fields: [String]) -> Bool {
        let searchable = fields.map(normalized).joined(separator: " ")
        return terms.allSatisfy { searchable.contains($0) }
    }
}
