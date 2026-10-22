import Foundation

/// Deliberately closed numeric schema: no conversation content or device/account identifiers.
struct PerformanceObservation: Codable, Sendable, Equatable {
    enum Outcome: String, Codable, Sendable { case completed, error, cancelled, interrupted, abandoned }
    struct Metrics: Codable, Sendable, Equatable {
        var firstContentMs: Double?
        var completedMs: Double?
        var firstSpeechMs: Double?
        var speechEndedMs: Double?
        var sttFinalizationMs: Double?
        var audibleMs: Double?

        init(trace: LatencyTrace, voice: Bool) {
            func ms(_ a: LatencyTrace.Stage, _ b: LatencyTrace.Stage) -> Double? {
                guard let seconds = trace.seconds(from: a, to: b) else { return nil }
                let value = seconds * 1000
                return value.isFinite && (0...900_000).contains(value) ? value.rounded() : nil
            }
            firstContentMs = ms(.messageSent, .firstToken)
            completedMs = ms(.messageSent, .responseCompleted)
            firstSpeechMs = ms(.messageSent, .firstSpeech)
            speechEndedMs = trace.marks[.firstSpeech] == nil ? nil : ms(.messageSent, .speechEnded)
            sttFinalizationMs = voice ? ms(.pttReleased, .transcriptFinal) : nil
            audibleMs = voice ? ms(.pttReleased, .firstSpeech) : nil
        }
    }
    let sessionId: UUID
    let requestId: UUID
    let source: String
    let appVersion: String
    let inputMode: String
    let outcome: Outcome
    let reconnected: Bool
    let metrics: Metrics

    static var source: String {
        #if targetEnvironment(simulator)
        "ios_simulator"
        #else
        "ios"
        #endif
    }
    static var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return String("\(info["CFBundleShortVersionString"] as? String ?? "0") (\(info["CFBundleVersion"] as? String ?? "0"))".prefix(40))
    }
}

/// One current measured turn. Historical replay/recovery never creates a new observation.
@MainActor
final class PerformanceTurnRecorder {
    private struct Turn {
        let sessionId: UUID
        let requestId: UUID
        let voice: Bool
        var trace: LatencyTrace
        var reconnected = false
        var outcome: PerformanceObservation.Outcome?
        var terminal = false
    }
    private var turn: Turn?
    private let emit: (PerformanceObservation) -> Void
    init(emit: @escaping (PerformanceObservation) -> Void) { self.emit = emit }

    func begin(session: String, request: String, mode: String, trace: LatencyTrace) {
        end(.abandoned)
        guard let sid = UUID(uuidString: session), let rid = UUID(uuidString: request) else { return }
        turn = Turn(sessionId: sid, requestId: rid, voice: mode == "voice", trace: trace)
    }
    func mark(_ stage: LatencyTrace.Stage, request: String) {
        guard turn?.requestId == UUID(uuidString: request), turn?.terminal == false else { return }
        turn?.trace.mark(stage)
    }
    func reconnect() { turn?.reconnected = true }
    private func matches(_ request: String?) -> Bool { request == nil || turn?.requestId == UUID(uuidString: request!) }
    func audibleStarted(request: String? = nil) {
        guard matches(request) else { return }
        turn?.trace.mark(.firstSpeech)
    }
    func speechStopped(request: String? = nil) {
        guard matches(request) else { return }
        guard turn?.trace.marks[.firstSpeech] != nil else { settleIfTerminal(); return }
        turn?.trace.markSpeechEnded()
        settleIfTerminal()
    }
    /// Muting may happen before server completion: keep measuring the written response.
    func speechFailed(request: String? = nil) { if matches(request), turn != nil { turn?.outcome = .error } }
    func interruptSpeech(request: String? = nil) { if matches(request), turn != nil { turn?.outcome = .interrupted } }
    func complete(request: String, outcome: PerformanceObservation.Outcome, speaking: Bool) {
        guard turn?.requestId == UUID(uuidString: request) else { return }
        turn?.trace.mark(.responseCompleted)
        if turn?.outcome == nil || outcome == .error || outcome == .cancelled { turn?.outcome = outcome }
        turn?.terminal = true
        if !speaking { settleIfTerminal() }
    }
    func end(_ outcome: PerformanceObservation.Outcome) {
        guard turn != nil else { return }
        turn?.trace.mark(.responseCompleted)
        if turn?.trace.marks[.firstSpeech] != nil { turn?.trace.markSpeechEnded() }
        turn?.outcome = outcome
        turn?.terminal = true
        settleIfTerminal()
    }
    private func settleIfTerminal() {
        guard let value = turn, value.terminal, let outcome = value.outcome else { return }
        turn = nil
        let metrics = PerformanceObservation.Metrics(trace: value.trace, voice: value.voice)
        // A suspended turn beyond the server's 15-minute measurement window is omitted, never clamped.
        guard outcome != .completed || metrics.completedMs != nil else { return }
        emit(PerformanceObservation(sessionId: value.sessionId, requestId: value.requestId,
            source: PerformanceObservation.source, appVersion: PerformanceObservation.appVersion,
            inputMode: value.voice ? "voice" : "text", outcome: outcome, reconnected: value.reconnected,
            metrics: metrics))
    }
}

extension ApiClient {
    func performanceObservations(_ observations: [PerformanceObservation]) async throws {
        struct Body: Encodable, Sendable { let observations: [PerformanceObservation] }
        struct Response: Decodable { let accepted: Int }
        let _: Response = try await request("POST", "/v1/performance/observations", body: Body(observations: observations))
    }
}

/// Session-owned, bounded and best effort. No disk cache and no global account-crossing state.
@MainActor
final class PerformanceObservationQueue {
    typealias Sender = @MainActor ([PerformanceObservation]) async throws -> Void
    private let send: Sender
    private let pause: @MainActor () async throws -> Void
    private var worker: Task<Void, Never>?
    private var enabled = true
    private(set) var pending: [PerformanceObservation] = []
    init(send: @escaping Sender, pause: @escaping @MainActor () async throws -> Void = {
        try await Task.sleep(for: .seconds(2))
    }) { self.send = send; self.pause = pause }

    func enqueue(_ observation: PerformanceObservation) {
        guard enabled else { return }
        guard !pending.contains(where: { $0.sessionId == observation.sessionId && $0.requestId == observation.requestId }) else { return }
        if pending.count == 40 { pending.removeFirst() }
        pending.append(observation)
        guard worker == nil else { return }
        worker = Task { [weak self] in await self?.drain() }
    }
    func invalidate() {
        enabled = false
        worker?.cancel()
        worker = nil
        pending.removeAll()
    }
    private func drain() async {
        defer { worker = nil }
        while enabled, !Task.isCancelled, !pending.isEmpty {
            let batch = Array(pending.prefix(20))
            pending.removeFirst(batch.count)
            for attempt in 0..<3 {
                guard enabled, !Task.isCancelled else { return }
                do { try await send(batch); break }
                catch is CancellationError { return }
                catch let error as ApiError where (400..<500).contains(error.status) && error.status != 429 {
                    // Unsupported endpoint or revoked credentials must not generate a retry loop.
                    invalidate()
                    return
                } catch {
                    if attempt < 2 { do { try await pause() } catch { return } }
                }
            }
        }
    }
}
