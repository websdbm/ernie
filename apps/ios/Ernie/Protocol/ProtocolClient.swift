import Foundation

/// Connessione WebSocket al backend: una sessione per connessione, `session.start` con ripresa (`resumeFromSeq`),
/// deduplica per id, controllo di sequenza, ping periodico, riconnessione con backoff.
actor ProtocolClient {
    enum ConnectionState: Sendable, Equatable {
        case disconnected
        case connecting
        case connected
        case reconnecting(attempt: Int)
    }

    enum Signal: Sendable {
        case state(ConnectionState)
        case event(AgentEvent)
        case gap(expected: Int, received: Int)
    }

    let signals: AsyncStream<Signal>
    private let emit: AsyncStream<Signal>.Continuation
    private let credentials: Credentials
    private let session: URLSession
    private(set) var sessionId: String
    private(set) var lastSeq: Int
    private var task: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var pingLoop: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var wantConnected = false
    private var attempt = 0
    private let dedupe = EventDeduper()
    private var tracker: SequenceTracker
    private var outSeq = SequenceSource()

    init(credentials: Credentials, sessionId: String, lastSeq: Int = -1) {
        self.credentials = credentials
        self.sessionId = sessionId
        self.lastSeq = lastSeq
        self.tracker = SequenceTracker(start: max(0, lastSeq + 1))
        let (stream, continuation) = AsyncStream.makeStream(of: Signal.self, bufferingPolicy: .unbounded)
        signals = stream
        emit = continuation
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 20
        session = URLSession(configuration: config)
    }

    func connect() {
        wantConnected = true
        attempt = 0
        open()
    }

    func disconnect() {
        wantConnected = false
        reconnectTask?.cancel()
        receiveLoop?.cancel()
        pingLoop?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        emit.yield(.state(.disconnected))
    }

    /// Nuova conversazione: nuova sessione, sequenze azzerate, nuova connessione.
    func switchSession(to newSessionId: String) {
        disconnect()
        sessionId = newSessionId
        lastSeq = -1
        tracker = SequenceTracker()
        outSeq = SequenceSource()
        connect()
    }

    /// Invia un evento client; restituisce il correlationId usato.
    @discardableResult
    func send(_ payload: EventPayload, correlationId: String = Ids.new(), persist: Bool? = nil) async throws -> String {
        let event = AgentEvent(payload: payload, sessionId: sessionId, correlationId: correlationId, seq: outSeq.next(), persist: persist)
        try await sendRaw(event)
        return correlationId
    }

    // MARK: - privato

    private func open() {
        receiveLoop?.cancel()
        pingLoop?.cancel()
        var request = URLRequest(url: credentials.webSocketURL)
        request.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        let t = session.webSocketTask(with: request)
        task = t
        emit.yield(.state(attempt == 0 ? .connecting : .reconnecting(attempt: attempt)))
        t.resume()
        let info = ClientInfo(
            platform: "ios",
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            locale: Locale.current.identifier
        )
        let start = AgentEvent(
            payload: .sessionStart(SessionStartPayload(clientInfo: info, resumeFromSeq: lastSeq >= 0 ? lastSeq : nil)),
            sessionId: sessionId,
            correlationId: Ids.new(),
            seq: outSeq.next()
        )
        Task { [weak self] in
            guard let self else { return }
            do { try await self.sendRaw(start) } catch { await self.handleDisconnect(error) }
        }
        receiveLoop = Task { [weak self] in await self?.runReceiveLoop(on: t) }
        pingLoop = Task { [weak self] in await self?.runPingLoop(on: t) }
    }

    private func sendRaw(_ event: AgentEvent) async throws {
        guard let task else { throw URLError(.notConnectedToInternet) }
        try await task.send(.string(try event.encoded()))
    }

    private func runReceiveLoop(on t: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await t.receive()
                switch message {
                case .string(let s): handleIncoming(s)
                case .data(let d): handleIncoming(String(decoding: d, as: UTF8.self))
                @unknown default: break
                }
            } catch {
                if Task.isCancelled || task !== t { return }
                handleDisconnect(error)
                return
            }
        }
    }

    private func runPingLoop(on t: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(25))
            if Task.isCancelled || task !== t { return }
            let ping = AgentEvent(payload: .sessionPing, sessionId: sessionId, correlationId: Ids.new(), seq: outSeq.next(), persist: false)
            do { try await t.send(.string(try ping.encoded())) } catch {
                if task === t { handleDisconnect(error) }
                return
            }
        }
    }

    private func handleIncoming(_ json: String) {
        let event: AgentEvent
        do { event = try AgentEvent.decode(json) } catch {
            Log.net.warning("evento non decodificabile: \(error.localizedDescription, privacy: .public)")
            return
        }
        if dedupe.isDuplicate(event.id) { return }
        // Il controllo di sequenza segnala soltanto: dopo una ripresa il server rinvia eventi con seq inferiori
        // a quello di `session.started`, che sono legittimi (deduplicati per id).
        if case .gap(let expected, let received) = tracker.check(event.seq) {
            emit.yield(.gap(expected: expected, received: received))
        }
        lastSeq = max(lastSeq, event.seq)
        if case .sessionStarted = event.payload {
            attempt = 0
            emit.yield(.state(.connected))
        }
        emit.yield(.event(event))
    }

    private func handleDisconnect(_ error: any Error) {
        Log.net.info("connessione chiusa: \(error.localizedDescription, privacy: .public)")
        task = nil
        emit.yield(.state(.disconnected))
        guard wantConnected else { return }
        attempt += 1
        let delay = min(30.0, pow(2.0, Double(attempt - 1)))
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            await self.reopenIfWanted()
        }
    }

    private func reopenIfWanted() {
        if wantConnected && task == nil { open() }
    }
}
