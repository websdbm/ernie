import Foundation

struct HabitVisit: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var latitude: Double
    var longitude: Double
    var accuracyM: Double
    var arrival: String?
    var departure: String?
    var observedAt: String
    var timezone: String
    var placeId: String?
    static func date(_ string: String?) -> Date? {
        guard let string else { return nil }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso.date(from: string) ?? ISO8601DateFormatter().date(from: string)
    }
}
struct HabitPlace: Codable, Sendable, Identifiable, Equatable {
    var id: String; var latitude: Double; var longitude: Double; var label: String; var purpose: String
    var frequency: String; var confirmedAt: String?; var linkedPlaceId: String?; var excluded: Bool
    var askedAt: String?; var snoozeUntil: String?
}
struct HabitPattern: Codable, Sendable, Identifiable {
    var placeId: String; var weekday: Int; var arrivalStart: String; var arrivalEnd: String
    var days: Int; var spanDays: Int; var updatedAt: String
    var id: String { "\(placeId)-\(weekday)" }
}
struct HabitsSnapshot: Codable, Sendable {
    var revision: Int; var epoch: String; var skillEnabled: Bool; var collecting: Bool; var aiAllowed: Bool
    var enabledAt: String?; var retentionDays: Int; var policyVersion: Int; var policy: String
    var visits: [HabitVisit]; var places: [HabitPlace]; var patterns: [HabitPattern]; var lastReviewDay: String?
}
struct HabitQuestion: Decodable, Sendable, Identifiable {
    var placeId: String; var title: String; var question: String
    var id: String { placeId }
}
struct HabitsConfiguration: Encodable {
    var expectedRevision: Int; var collecting: Bool; var aiAllowed: Bool; var retentionDays: Int; var policyVersion = 1
}
struct HabitsFailure: LocalizedError {
    var code: String
    var errorDescription: String? {
        switch code {
        case "habits_disabled": "Attiva la skill Abitudini per iniziare."
        case "habits_paused": "La raccolta è in pausa. Le visite in attesa non verranno inviate."
        case "habits_changed": "Le impostazioni sono cambiate su un altro dispositivo. Ricarica la sezione."
        case "habits_capacity": "L’archivio è pieno. Riduci il periodo dello storico o elimina alcune visite."
        case "invalid_visits": "Alcune visite hanno dati incoerenti: non sono state salvate."
        default: "Abitudini non è disponibile. Riprova più tardi."
        }
    }
}

final class HabitsClient: @unchecked Sendable {
    let credentials: Credentials
    private struct Failure: Decodable { var error: String }
    private let transport: (@Sendable (URLRequest) async throws -> (Data, URLResponse))?
    private let session: URLSession
    init(credentials: Credentials, transport: (@Sendable (URLRequest) async throws -> (Data, URLResponse))? = nil) {
        self.credentials = credentials
        self.transport = transport
        session = URLSession(configuration: HealthVaultClient.configuration(), delegate: HabitsNoRedirect(), delegateQueue: nil)
    }
    func close() { session.invalidateAndCancel() }
    deinit { session.invalidateAndCancel() }
    func get() async throws -> HabitsSnapshot { try await request("GET", "") }
    func configure(_ body: HabitsConfiguration) async throws -> HabitsSnapshot { try await request("PUT", "/config", body: body) }
    func upload(epoch: String, visits: [HabitVisit]) async throws {
        struct Input: Encodable { var epoch: String; var visits: [HabitVisit] }
        struct Result: Decodable { var accepted: Int }
        // placeId is server-owned; outbound records only contain the device observation.
        let _: Result = try await request("POST", "/visits", body: Input(epoch: epoch, visits: visits.map { visit in var observation = visit; observation.placeId = nil; return observation }))
    }
    func update(_ place: HabitPlace) async throws -> HabitsSnapshot {
        struct Input: Encodable { var label: String; var purpose: String; var frequency: String; var linkedPlaceId: String? }
        return try await request("PATCH", "/places/\(place.id)", body: Input(label: place.label, purpose: place.purpose, frequency: place.frequency, linkedPlaceId: place.linkedPlaceId))
    }
    func action(_ action: String, id: String? = nil) async throws -> HabitsSnapshot {
        struct Input: Encodable { var action: String; var id: String? }
        return try await request("POST", "/actions", body: Input(action: action, id: id))
    }
    func question() async throws -> HabitQuestion? {
        struct Result: Decodable { var question: HabitQuestion? }
        let result: Result = try await request("POST", "/question", body: ["timezone": TimeZone.current.identifier]); return result.question
    }
    private func request<T: Decodable>(_ method: String, _ path: String, body: (some Encodable)? = nil as String?) async throws -> T {
        guard let url = URL(string: "/v1/habits\(path)", relativeTo: credentials.serverURL) else { throw HabitsFailure(code: "invalid_url") }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let body { request.httpBody = try JSONEncoder().encode(body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let data: Data, response: URLResponse
        if let transport { (data, response) = try await transport(request) }
        else { (data, response) = try await session.data(for: request) }
        guard let http = response as? HTTPURLResponse else { throw HabitsFailure(code: "invalid_response") }
        guard (200..<300).contains(http.statusCode) else {
            throw HabitsFailure(code: (try? JSONDecoder().decode(Failure.self, from: data).error) ?? "unavailable")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
private final class HabitsNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
