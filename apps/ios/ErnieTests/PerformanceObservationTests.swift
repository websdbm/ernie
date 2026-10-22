import Foundation
import Testing
@testable import Ernie

@MainActor struct PerformanceObservationTests {
    private let session = UUID().uuidString
    private let request = UUID().uuidString
    private func trace() -> LatencyTrace {
        var trace = LatencyTrace()
        trace.mark(.messageSent)
        return trace
    }

    @Test func intervalliMonotoniIgnoranoSaltiDellOrologioENonInvianoValoriInvalidi() throws {
        var trace = LatencyTrace()
        trace.mark(.pttReleased, at: Date(timeIntervalSince1970: 100), uptime: 10)
        trace.mark(.transcriptFinal, at: Date(timeIntervalSince1970: 99), uptime: 10.2)
        trace.mark(.messageSent, at: Date(timeIntervalSince1970: 50), uptime: 10.3)
        trace.mark(.firstToken, at: Date(timeIntervalSince1970: 20), uptime: 10.8)
        trace.mark(.firstSpeech, at: .now, uptime: 11)
        trace.mark(.speechEnded, at: .now, uptime: .infinity)
        trace.mark(.responseCompleted, at: .now, uptime: 1000)
        let metrics = PerformanceObservation.Metrics(trace: trace, voice: true)
        #expect(abs(try #require(metrics.firstContentMs) - 500) < 0.001)
        #expect(abs(try #require(metrics.sttFinalizationMs) - 200) < 0.001)
        #expect(metrics.audibleMs == 1000)
        #expect(metrics.speechEndedMs == nil)
        #expect(metrics.completedMs == nil)
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(metrics)) as? [String: Any])
        #expect(json["speechEndedMs"] == nil)
        #expect(json["completedMs"] == nil)
        #expect(PerformanceObservation.Metrics(trace: trace, voice: false).audibleMs == nil)
    }

    @Test func voceSiChiudeDopoCompletedEMisuraUltimaFrase() throws {
        var values: [PerformanceObservation] = []
        let recorder = PerformanceTurnRecorder { values.append($0) }
        recorder.begin(session: session, request: request, mode: "voice", trace: trace())
        recorder.audibleStarted()
        recorder.speechStopped() // Gap between sentences is not the end of the server turn.
        #expect(values.isEmpty)
        recorder.audibleStarted()
        recorder.complete(request: request, outcome: .completed, speaking: true)
        #expect(values.isEmpty)
        recorder.speechStopped()
        let result = try #require(values.first)
        #expect(result.metrics.firstSpeechMs != nil)
        #expect(result.metrics.speechEndedMs! >= result.metrics.completedMs!)
        recorder.speechStopped()
        recorder.complete(request: request, outcome: .completed, speaking: false)
        #expect(values.count == 1)
    }

    @Test(arguments: [PerformanceObservation.Outcome.completed, .error, .cancelled, .interrupted, .abandoned])
    func esitiEReplayNonCreanoNuoveMisure(outcome: PerformanceObservation.Outcome) throws {
        var values: [PerformanceObservation] = []
        let recorder = PerformanceTurnRecorder { values.append($0) }
        recorder.complete(request: request, outcome: .completed, speaking: false) // restored/replayed history
        #expect(values.isEmpty)
        recorder.begin(session: session, request: request, mode: "text", trace: trace())
        recorder.mark(.firstToken, request: UUID().uuidString) // unrelated broadcast
        recorder.reconnect()
        recorder.end(outcome)
        recorder.complete(request: request, outcome: .completed, speaking: false)
        let result = try #require(values.first)
        #expect(values.count == 1)
        #expect(result.outcome == outcome)
        #expect(result.reconnected)
        #expect(result.metrics.firstContentMs == nil)
        #expect(result.metrics.completedMs != nil)
        #expect(result.metrics.firstSpeechMs == nil)
    }

    @Test func muteEPlaybackFallitoNonRisultanoVoceCompletata() {
        var values: [PerformanceObservation] = []
        let recorder = PerformanceTurnRecorder { values.append($0) }
        recorder.begin(session: session, request: request, mode: "voice", trace: trace())
        recorder.audibleStarted()
        recorder.interruptSpeech()
        recorder.speechStopped()
        recorder.complete(request: request, outcome: .completed, speaking: false)
        #expect(values.first?.outcome == .interrupted)
        recorder.begin(session: session, request: UUID().uuidString, mode: "text", trace: trace())
        recorder.speechFailed()
        // Server completion must not overwrite an audio failure.
        let other = UUID().uuidString
        recorder.begin(session: session, request: other, mode: "text", trace: trace())
        recorder.speechFailed()
        recorder.complete(request: other, outcome: .completed, speaking: false)
        #expect(values.last?.outcome == .error)
    }

    @Test func callbackVoceVecchiaNonContaminaIlTurnoSuccessivo() {
        var values: [PerformanceObservation] = []
        let recorder = PerformanceTurnRecorder { values.append($0) }
        let old = UUID().uuidString
        recorder.begin(session: session, request: old, mode: "voice", trace: trace())
        recorder.begin(session: session, request: request, mode: "text", trace: trace())
        recorder.audibleStarted(request: old)
        recorder.speechFailed(request: old)
        recorder.speechStopped(request: old)
        recorder.complete(request: request, outcome: .completed, speaking: false)
        #expect(values.count == 2)
        #expect(values.last?.outcome == .completed)
        #expect(values.last?.metrics.firstSpeechMs == nil)
    }

    @Test func turnoOltreFinestraQuindiciMinutiNonInviaCompletamentoInvalido() {
        var values: [PerformanceObservation] = []
        let recorder = PerformanceTurnRecorder { values.append($0) }
        var old = LatencyTrace()
        old.mark(.messageSent, at: .now, uptime: ProcessInfo.processInfo.systemUptime - 901)
        recorder.begin(session: session, request: request, mode: "text", trace: old)
        recorder.complete(request: request, outcome: .completed, speaking: false)
        #expect(values.isEmpty)
    }

    @Test func payloadHaSoloSchemaNumericoConsentito() throws {
        var values: [PerformanceObservation] = []
        let recorder = PerformanceTurnRecorder { values.append($0) }
        recorder.begin(session: session, request: request, mode: "text", trace: trace())
        recorder.mark(.firstToken, request: request)
        recorder.complete(request: request, outcome: .completed, speaking: false)
        let observation = try #require(values.first)
        let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(observation)) as? [String: Any])
        #expect(Set(json.keys) == ["sessionId", "requestId", "source", "appVersion", "inputMode", "outcome", "reconnected", "metrics"])
        #expect(observation.source == "ios_simulator")
        #expect(observation.appVersion.count <= 40)
        #expect(observation.metrics.firstContentMs != nil)
    }

    private func observation(_ id: UUID = UUID()) -> PerformanceObservation {
        PerformanceObservation(sessionId: UUID(uuidString: session)!, requestId: id, source: "ios_simulator", appVersion: "test",
            inputMode: "text", outcome: .completed, reconnected: false, metrics: .init(trace: trace(), voice: false))
    }
    private func yieldUntil(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition())
    }

    @Test func codaLimitataBatchVentiERetryStessaIdentita() async {
        var batches: [[PerformanceObservation]] = []
        let queue = PerformanceObservationQueue(send: {
            batches.append($0)
            if batches.count < 3 { throw URLError(.notConnectedToInternet) }
        }, pause: {})
        for _ in 0..<60 { queue.enqueue(observation()) }
        #expect(queue.pending.count == 40)
        await yieldUntil { batches.count == 4 }
        #expect(batches.map(\.count) == [20, 20, 20, 20])
        #expect(batches[0] == batches[1] && batches[1] == batches[2])
        #expect(queue.pending.isEmpty)
    }

    @Test func logoutCancellaCodaETentativiAncheConRispostaTardiva() async {
        var calls = 0
        var pending: CheckedContinuation<Void, any Error>?
        let queue = PerformanceObservationQueue(send: { _ in
            calls += 1
            try await withCheckedThrowingContinuation { pending = $0 }
        }, pause: {})
        queue.enqueue(observation())
        await yieldUntil { calls == 1 }
        queue.enqueue(observation())
        queue.invalidate()
        pending?.resume(throwing: URLError(.networkConnectionLost))
        queue.enqueue(observation())
        for _ in 0..<50 { await Task.yield() }
        #expect(calls == 1)
        #expect(queue.pending.isEmpty)
    }

    @Test(arguments: [401, 403, 404]) func rifiutoAutorizzazioneOServerVecchioFermaInvii(status: Int) async {
        var calls = 0
        let queue = PerformanceObservationQueue(send: { _ in
            calls += 1
            throw ApiError(status: status, code: "test", message: "test")
        }, pause: {})
        queue.enqueue(observation())
        await yieldUntil { calls == 1 }
        for _ in 0..<20 { await Task.yield() }
        queue.enqueue(observation())
        #expect(queue.pending.isEmpty)
        #expect(calls == 1)
    }
}

@MainActor private final class PerformanceSpeechOutput: SpeechOutput {
    let localVoiceDescription = "Test"
    var finish: ((Bool) -> Void)?
    func play(_ data: Data, started: @escaping () -> Void, mouth: @escaping (Bool) -> Void, finished: @escaping (Bool) -> Void) throws {
        finish = finished; started()
    }
    func speak(_ text: String, started: @escaping () -> Void, progress: @escaping (Int) -> Void, finished: @escaping (Bool) -> Void) {
        finish = finished; started()
    }
    func stop() { finish = nil }
}

@MainActor struct ConversationPerformanceTests {
    @Test(arguments: ["text", "voice", "tool", "error", "stop", "abandoned", "completedError", "completedCancelled", "completedStop"])
    func eventiRealiDelProtocolloRegistranoUnSoloTurno(mode: String) async throws {
        let name = "performance-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        var batches: [PerformanceObservation] = []
        let queue = PerformanceObservationQueue(send: { batches += $0 }, pause: {})
        let output = PerformanceSpeechOutput()
        let speaker = Speaker(output: output)
        let credentials = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "not-a-key")
        speaker.configure(credentials: credentials, engine: .ios, style: .warm)
        var settings = LocalSettings()
        settings.speakTextReplies = false
        settings.voiceOutput = true
        let store = ConversationStore(credentials: credentials, speaker: speaker, inbox: InboxStore(), settings: settings,
            transcript: TranscriptStore(directory: directory, defaults: defaults), performanceQueue: queue, deviceContext: { nil })
        if mode == "voice" {
            store.currentTrace = LatencyTrace()
            store.currentTrace?.mark(.pttReleased)
            store.currentTrace?.mark(.transcriptFinal)
        }
        store.send("Test sintetico senza rete", inputMode: mode == "voice" ? "voice" : "text")
        let request = try #require(store.activeCorrelationId)
        let sid = store.sessionId
        func apply(_ payload: EventPayload, seq: Int) {
            store.apply(AgentEvent(payload: payload, sessionId: sid, correlationId: request, seq: seq))
        }
        if mode == "tool" {
            apply(.toolStarted(.init(toolCallId: "test", toolId: "brain_search")), seq: 1)
        } else if mode == "error" {
            apply(.error(.init(code: "failed", message: "Errore sintetico", retryable: false)), seq: 1)
        } else if mode == "stop" {
            store.bargeIn()
        } else if mode == "abandoned" {
            store.startNewSession()
        } else {
            apply(.assistantTextDelta(.init(delta: "Una risposta sintetica.")), seq: 1)
        }
        if mode == "voice" {
            #expect(speaker.isSpeaking)
            #expect(batches.isEmpty)
        }
        let finishReason: String? = switch mode {
        case "completedError": "error"
        case "completedCancelled": "cancelled"
        case "completedStop": "stop"
        default: nil
        }
        apply(.assistantCompleted(.init(finishReason: finishReason)), seq: 2)
        if mode == "voice" {
            #expect(batches.isEmpty) // Completion is not the end of playback.
            output.finish?(true)
        }
        for _ in 0..<1000 { if !batches.isEmpty { break }; await Task.yield() }
        let observation = try #require(batches.first)
        #expect(batches.count == 1)
        #expect(observation.requestId.uuidString == request.uppercased())
        #expect(observation.metrics.completedMs != nil)
        #expect(observation.metrics.firstContentMs != nil || !["text", "voice"].contains(mode))
        if mode == "tool" { #expect(observation.metrics.firstContentMs == nil) }
        if mode == "voice" {
            #expect(observation.metrics.audibleMs != nil)
            #expect(observation.metrics.sttFinalizationMs != nil)
            #expect(observation.metrics.speechEndedMs! >= observation.metrics.completedMs!)
        }
        let expectedOutcome: PerformanceObservation.Outcome = switch mode {
        case "error", "completedError": .error
        case "stop", "completedCancelled": .cancelled
        case "abandoned": .abandoned
        default: .completed
        }
        #expect(observation.outcome == expectedOutcome)
        apply(.assistantCompleted(.init()), seq: 3)
        for _ in 0..<20 { await Task.yield() }
        #expect(batches.count == 1)
        store.disconnect()
    }
}

private actor PerformanceHTTP {
    var request: URLRequest?
    func send(_ value: URLRequest) async throws -> (Data, URLResponse) {
        request = value
        return (Data(#"{"accepted":1}"#.utf8), HTTPURLResponse(url: value.url!, statusCode: 202, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor struct PerformanceAPITests {
    @Test func inviaAlSoloEndpointAutenticatoSchemaSenzaContenuto() async throws {
        let http = PerformanceHTTP()
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.invalid")!, apiKey: "synthetic-test-only"), transport: http.send)
        var trace = LatencyTrace()
        trace.mark(.messageSent)
        trace.mark(.responseCompleted)
        let observation = PerformanceObservation(sessionId: UUID(), requestId: UUID(), source: PerformanceObservation.source, appVersion: PerformanceObservation.appVersion,
            inputMode: "text", outcome: .completed, reconnected: false, metrics: .init(trace: trace, voice: false))
        try await api.performanceObservations([observation])
        let request = try #require(await http.request)
        #expect(request.url?.path == "/v1/performance/observations")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-test-only")
        let body = try #require(request.httpBody)
        let evidence = URL(fileURLWithPath: "/tmp/ernie-perf-ios-20261021")
        try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true)
        try body.write(to: evidence.appendingPathComponent("client-payload.json"), options: .atomic)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(Set(json.keys) == ["observations"])
        let values = try #require(json["observations"] as? [[String: Any]])
        #expect(values.count == 1)
        #expect(values.first?["requestId"] as? String == observation.requestId.uuidString)
    }
}
