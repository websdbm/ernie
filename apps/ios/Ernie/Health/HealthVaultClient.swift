import Foundation

/// Trasporto dedicato: nessun URLCache, cookie, background transfer, log o archivio locale.
final class HealthVaultClient: @unchecked Sendable {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let credentials: Credentials
    private let session: URLSession?
    private let transport: Transport
    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 180
        return configuration
    }
    init(credentials: Credentials, transport: Transport? = nil) {
        self.credentials = credentials
        if let transport { self.transport = transport; session = nil }
        else {
            let session = URLSession(configuration: Self.configuration(), delegate: HealthNoRedirect(), delegateQueue: nil)
            self.session = session; self.transport = { try await session.data(for: $0) }
        }
    }
    func close() { session?.invalidateAndCancel() }
    deinit { session?.invalidateAndCancel() }
    func capabilities() async throws -> HealthCapabilities { try await request("GET", "/capabilities") }
    func consent(allowed: Bool, revision: Int? = nil, policyVersion: Int? = nil) async throws -> HealthConsentState {
        struct Body: Encodable { var allowed: Bool; var expectedRevision: Int?; var policyVersion: Int? }
        return try await request("POST", "/consent", body: Body(allowed: allowed, expectedRevision: revision, policyVersion: policyVersion))
    }
    func sources() async throws -> [HealthSourceSummary] {
        struct Result: Decodable { var sources: [HealthSourceSummary] }
        let result: Result = try await request("GET", "/sources"); return result.sources
    }
    func source(_ id: String) async throws -> HealthSourceDetail {
        struct Result: Decodable { var source: HealthSourceDetail }
        let result: Result = try await request("GET", "/sources/\(try uuid(id))"); return result.source
    }
    func attachment(source: String, id: String) async throws -> HealthAttachment {
        struct Result: Decodable { var attachment: HealthAttachment }
        let result: Result = try await request("GET", "/sources/\(try uuid(source))/attachments/\(try uuid(id))"); return result.attachment
    }
    func upload(_ draft: HealthVaultDraft) async throws -> HealthSourceSummary {
        try draft.validate()
        struct Result: Decodable { var source: HealthSourceSummary }
        let result: Result = try await request("POST", "/sources", body: draft); return result.source
    }
    func reports() async throws -> [HealthReportSummary] {
        struct Result: Decodable { var reports: [HealthReportSummary] }
        let result: Result = try await request("GET", "/reports"); return result.reports
    }
    func report(_ id: String) async throws -> HealthReportDetail {
        struct Result: Decodable { var report: HealthReportDetail }
        let result: Result = try await request("GET", "/reports/\(try uuid(id))"); return result.report
    }
    func parameter(_ name: String) async throws -> HealthParameterDetail? {
        struct Result: Decodable { var parameter: HealthParameterDetail? }
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 100 else { throw HealthVaultError.invalidImport }
        let result: Result = try await request("POST", "/parameters", body: ["name": name]); return result.parameter
    }
    func analyze(_ id: String) async throws -> HealthAnalysisResult { try await request("POST", "/sources/\(try uuid(id))/analyze", body: [String: String]()) }
    func remove(_ id: String) async throws { let _: Empty = try await request("DELETE", "/sources/\(try uuid(id))") }
    func export(sourceId: String? = nil, reportId: String? = nil) async throws -> HealthExportPayload {
        struct Body: Encodable { var sourceId: String?; var reportId: String? }
        guard (sourceId == nil) != (reportId == nil) else { throw HealthVaultError.invalidImport }
        if let sourceId { _ = try uuid(sourceId) }; if let reportId { _ = try uuid(reportId) }
        return try await request("POST", "/export", body: Body(sourceId: sourceId, reportId: reportId))
    }
    func ask(_ question: String, reportIds: [String], sourceIds: [String] = []) async throws -> HealthAnswer {
        struct Body: Encodable { var question: String; var reportIds: [String]?; var sourceIds: [String]? }
        guard !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, question.count <= 4000, reportIds.count <= 10, sourceIds.count <= 5 else { throw HealthVaultError.invalidImport }
        for id in reportIds + sourceIds { _ = try uuid(id) }
        return try await request("POST", "/ask", body: Body(question: question, reportIds: reportIds.isEmpty && sourceIds.isEmpty ? nil : reportIds, sourceIds: sourceIds.isEmpty ? nil : sourceIds))
    }
    private func uuid(_ value: String) throws -> String {
        guard UUID(uuidString: value) != nil else { throw HealthVaultError.invalidImport }; return value
    }
    private struct Empty: Decodable {}
    private struct ErrorCode: Decodable { var error: String? }
    private func request<T: Decodable>(_ method: String, _ path: String, body: (some Encodable)? = nil as String?) async throws -> T {
        guard let url = URL(string: "/v1/health\(path)", relativeTo: credentials.serverURL) else { throw HealthVaultError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            let data = try JSONEncoder().encode(body)
            guard data.count <= HealthVaultDraft.maxRequestBytes else { throw HealthVaultError.oversized }
            request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data, response: URLResponse
        do { (data, response) = try await transport(request) }
        catch is CancellationError { throw CancellationError() }
        catch { if Task.isCancelled { throw CancellationError() }; throw HealthVaultError.network }
        try Task.checkCancellation()
        guard data.count <= 48 * 1024 * 1024 else { throw HealthVaultError.oversized }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200...299).contains(status) {
            // Only a closed set of codes is interpreted; server messages never reach UI or logs.
            let code = (try? JSONDecoder().decode(ErrorCode.self, from: data))?.error
            switch code {
            case "health_no_values": throw HealthVaultError.noValues
            case "health_analysis_too_large": throw HealthVaultError.analysisTooLarge
            case "health_context_too_large": throw HealthVaultError.contextTooLarge
            case "health_empty": throw HealthVaultError.empty
            case "health_busy": throw HealthVaultError.busy
            case "health_consent_required", "health_skill_disabled": throw HealthVaultError.consent
            default: break
            }
        }
        switch status {
        case 200...299: break
        case 401, 403: throw HealthVaultError.access
        case 404: throw HealthVaultError.notFound
        case 429: throw HealthVaultError.busy
        case 409: throw HealthVaultError.conflict
        case 413: throw HealthVaultError.oversized
        case 400, 422: throw HealthVaultError.invalidImport
        case 503: throw HealthVaultError.unavailable
        default: throw HealthVaultError.network
        }
        if data.isEmpty, let empty = Empty() as? T { return empty }
        guard let result = try? JSONDecoder().decode(T.self, from: data) else { throw HealthVaultError.invalidResponse }
        return result
    }
}

private final class HealthNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
