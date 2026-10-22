import Foundation

enum UsageScope: Hashable, Sendable {
    case personal
    case all
    case account(id: String, name: String)

    var requiresAdmin: Bool { self != .personal }
    var title: String {
        switch self {
        case .personal: "I miei consumi"
        case .all: "Tutte le installazioni"
        case .account(_, let name): name
        }
    }
}

enum UsagePeriod: String, Codable, CaseIterable, Sendable, Identifiable {
    case day, week, month, year
    var id: String { rawValue }
    var label: String {
        switch self { case .day: "Giorno"; case .week: "Settimana"; case .month: "Mese"; case .year: "Anno" }
    }
    var component: Calendar.Component {
        switch self { case .day: .day; case .week: .weekOfYear; case .month: .month; case .year: .year }
    }
}

struct UsageQuery: Hashable, Sendable {
    var scope: UsageScope = .personal
    var period: UsagePeriod = .month
    var date: String
    var timezone: String

    init(scope: UsageScope = .personal, period: UsagePeriod = .month, date: Date = .now, timezone: TimeZone = .current) {
        self.scope = scope; self.period = period; self.timezone = timezone.identifier
        self.date = Self.dateString(date, timezone: timezone)
    }

    var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timezone) ?? .gmt
        calendar.firstWeekday = 2; calendar.minimumDaysInFirstWeek = 4
        return calendar
    }
    var anchor: Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = calendar.timeZone
        formatter.calendar = calendar; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        guard let result = formatter.date(from: date), formatter.string(from: result) == date else { return nil }
        return result
    }
    var interval: DateInterval? { anchor.flatMap { calendar.dateInterval(of: period.component, for: $0) } }

    func shifted(_ direction: Int) -> UsageQuery {
        guard let start = interval?.start, let next = calendar.date(byAdding: period.component, value: direction, to: start) else { return self }
        var result = self
        result.date = Self.dateString(next, timezone: calendar.timeZone)
        return result
    }
    func canAdvance(now: Date = .now) -> Bool {
        guard let next = shifted(1).interval?.start else { return false }
        return next <= now
    }
    static func dateString(_ date: Date, timezone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timezone; formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    func path() -> String {
        var url = URLComponents()
        url.path = scope.requiresAdmin ? "/v1/usage/admin" : "/v1/usage"
        url.queryItems = [.init(name: "period", value: period.rawValue), .init(name: "date", value: date), .init(name: "timezone", value: timezone)]
        if case .account(let id, _) = scope { url.queryItems?.append(.init(name: "accountId", value: id)) }
        url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return url.string ?? "/v1/usage"
    }
}

struct UsageReport: Codable, Sendable, Equatable {
    struct ProviderAccount: Codable, Sendable, Equatable {
        var provider: String
        var status: String
        var balanceUsd: Double?
        var totalCreditsUsd: Double?
        var totalUsageUsd: Double?
        var checkedAt: String
    }
    struct Totals: Codable, Sendable, Equatable {
        var amountUsd: Double
        var reportedUsd: Double
        var estimatedUsd: Double
        var calls: Int
        var inputTokens: Int
        var outputTokens: Int
    }
    struct Bucket: Codable, Sendable, Equatable, Identifiable {
        var date: String
        var amountUsd: Double
        var calls: Int
        var id: String { date }
    }
    struct Breakdown: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var label: String
        var amountUsd: Double
        var calls: Int
    }
    struct Coverage: Codable, Sendable, Equatable {
        var since: String?
        var historicalMayBeIncomplete: Bool
        var note: String
    }
    struct Account: Codable, Sendable, Equatable, Identifiable {
        var id: String
        var name: String
        var companionName: String
        var deleted: Bool
        var amountUsd: Double?
        var calls: Int?
        var displayName: String { name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Account senza nome" : name }
    }
    var currency: String
    var timezone: String
    var period: String
    var from: String
    var to: String
    var generatedAt: String
    var scope: String
    var totals: Totals
    var series: [Bucket]
    var byModel: [Breakdown]
    var byActivity: [Breakdown]
    var byProvider: [Breakdown]
    var coverage: Coverage
    var adminAvailable: Bool
    var accounts: [Account]?
    var account: Account?
    var providerAccount: ProviderAccount? = nil
}

enum UsagePresentation {
    static func navigationTitle(scope: UsageScope, report: UsageReport?, authorized: Bool) -> String {
        guard authorized else { return "Consumi" }
        if case .account = scope { return report?.account?.displayName ?? "Consumi account" }
        return scope.title
    }

    static func amount(_ amount: Double) -> String {
        guard amount.isFinite else { return "— USD" }
        if amount > 0 && amount < 0.001 { return "<0,001 USD" }
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "it_IT"); formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 3; formatter.maximumFractionDigits = 3
        return "\(formatter.string(from: NSNumber(value: amount)) ?? "—") USD"
    }
    /// Asse numerico: poche posizioni esplicite, indipendenti dalle categorie di Swift Charts.
    static func chartTicks(count: Int, maximum: Int = 5) -> [Double] {
        guard count > 0 else { return [] }
        let labels = min(count, max(2, maximum))
        guard labels > 1 else { return [0] }
        return (0..<labels).map { Double(Int((Double($0 * (count - 1)) / Double(labels - 1)).rounded())) }
    }
    static func chartCeiling(_ amounts: [Double]) -> Double {
        let peak = amounts.filter(\.isFinite).max() ?? 0
        // Tre intervalli di almeno un millesimo: niente tacche diverse etichettate tutte zero.
        let rawStep = max(0.001, peak * 1.1 / 3)
        let scale = pow(10, floor(log10(rawStep)))
        let multiple = [1.0, 2, 5, 10].first { $0 >= rawStep / scale } ?? 10
        let step = max(0.001, multiple * scale)
        return step * 3
    }
    static func date(_ raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: raw) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }
    static func formatted(_ date: Date, format: String, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "it_IT"); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: timezone) ?? .gmt; formatter.dateFormat = format
        return formatter.string(from: date)
    }
    static func periodTitle(_ query: UsageQuery) -> String {
        guard let interval = query.interval else { return query.date }
        let start = interval.start, end = interval.end.addingTimeInterval(-1)
        switch query.period {
        case .day: return formatted(start, format: "d MMMM yyyy", timezone: query.timezone)
        case .week: return "\(formatted(start, format: "d MMM", timezone: query.timezone)) – \(formatted(end, format: "d MMM yyyy", timezone: query.timezone))"
        case .month: return formatted(start, format: "MMMM yyyy", timezone: query.timezone).capitalized
        case .year: return formatted(start, format: "yyyy", timezone: query.timezone)
        }
    }
    static func bucketLabel(_ raw: String, period: UsagePeriod, timezone: String, detailed: Bool = false) -> String {
        guard let date = date(raw) else { return raw }
        let format: String
        switch period {
        case .day: format = detailed ? "HH:mm zzz" : "HH:mm"
        case .week: format = detailed ? "EEEE d MMMM" : "d MMM"
        case .month: format = detailed ? "EEEE d MMMM" : "d"
        case .year: format = detailed ? "MMMM yyyy" : "MMM"
        }
        return formatted(date, format: format, timezone: timezone)
    }
    static func error(_ error: Error) -> String {
        if let error = error as? ApiError {
            switch error.status {
            case 401: return "La sessione non è più valida. Accedi di nuovo per vedere i consumi."
            case 403: return "Questo account non può visualizzare questi consumi."
            case 400: return "Il periodo richiesto non è valido. Scegli un’altra data."
            default: break
            }
        }
        return "Non riesco a caricare i consumi. Controlla la connessione e riprova."
    }
}

extension ApiClient {
    func usage(_ query: UsageQuery) async throws -> UsageReport { try await request("GET", query.path()) }
}
