import Foundation
import Observation

/// Stato della conversazione: applica gli eventi del protocollo, pilota la sintesi vocale, salva la cronologia.
@MainActor
@Observable
final class ConversationStore {
    private(set) var items: [ChatItem] = []
    private(set) var connection: ProtocolClient.ConnectionState = .disconnected
    private(set) var agentState: AgentState = .idle
    private(set) var sessionId: String
    private(set) var lastError: String?
    private(set) var latencyHistory: [LatencyTrace] = []
    private(set) var lastAvatarEmotion = "neutral"
    var currentTrace: LatencyTrace?
    var settings: LocalSettings
    /// Testo da proporre nel campo di scrittura (es. «Affina la ricetta …»): letto e azzerato dalla barra di input.
    var composerSuggestion: String?
    /// Blocchi strutturati in arrivo (es. liste della spesa): l'app aggiorna gli store dedicati.
    var onBlock: ((ContentBlock) -> Void)?

    private(set) var activeCorrelationId: String?
    private var activeInputMode: String?
    private var lastSeq = -1
    private let speaker: Speaker
    private let inbox: InboxStore
    private let transcript = TranscriptStore()
    private let client: ProtocolClient
    private var pump: Task<Void, Never>?
    private var isListening = false

    init(credentials: Credentials, speaker: Speaker, inbox: InboxStore, settings: LocalSettings) {
        self.speaker = speaker
        self.inbox = inbox
        self.settings = settings
        let store = TranscriptStore()
        let sid = store.currentSessionId ?? Ids.new()
        var loadedItems: [ChatItem] = []
        var loadedSeq = -1
        if let file = store.load(sid) {
            loadedItems = file.items.map { item in
                if case .message(var m) = item, m.isStreaming {
                    m.isStreaming = false
                    return .message(m)
                }
                return item
            }
            loadedSeq = file.lastSeq
        } else {
            store.setCurrent(sid)
        }
        sessionId = sid
        items = loadedItems
        lastSeq = loadedSeq
        client = ProtocolClient(credentials: credentials, sessionId: sid, lastSeq: loadedSeq)
        wireSpeaker()
        inbox.onCards = { [weak self] cards in self?.merge(cards) }
    }

    // MARK: - connessione

    func connect() {
        pump?.cancel()
        pump = Task { [weak self] in
            guard let self else { return }
            Task { await self.client.connect() }
            for await signal in self.client.signals {
                if Task.isCancelled { return }
                self.handle(signal)
            }
        }
    }

    func disconnect() {
        pump?.cancel()
        Task { await client.disconnect() }
    }

    func startNewSession() {
        _ = speaker.stop()
        activeCorrelationId = nil
        agentState = .idle
        items = []
        lastSeq = -1
        sessionId = Ids.new()
        transcript.setCurrent(sessionId)
        persist()
        let sid = sessionId
        Task { await client.switchSession(to: sid) }
    }

    // MARK: - azioni dell'utente

    func send(_ raw: String, inputMode: String, attachments: [DocumentRef] = []) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty, !attachments.isEmpty { text = "Riassumi questo documento per studiarlo e fammi lo schema." }
        guard !text.isEmpty else { return }
        if speaker.isSpeaking { bargeIn() }
        let correlationId = Ids.new()
        let info = attachments.map { AttachmentInfo(id: $0.id, title: $0.title, pages: $0.pages) }
        items.append(.message(ChatMessage(id: Ids.new(), correlationId: correlationId, role: .user, text: text, inputMode: inputMode, createdAt: .now, attachments: info.isEmpty ? nil : info)))
        activeCorrelationId = correlationId
        activeInputMode = inputMode
        agentState = .thinking
        lastError = nil
        if currentTrace == nil || inputMode == "text" { currentTrace = LatencyTrace() }
        currentTrace?.mark(.messageSent)
        persist()
        Task {
            do {
                let payload = UserMessagePayload(
                    text: text, inputMode: inputMode, locale: "it-IT",
                    attachments: attachments.isEmpty ? nil : attachments.map { DocumentAttachment(id: $0.id) }
                )
                try await client.send(.userMessage(payload), correlationId: correlationId)
            } catch {
                self.fail("Invio non riuscito: \(error.localizedDescription)")
            }
        }
    }

    /// Barge-in: ferma la voce subito e dice al server fino a dove l'utente ha sentito.
    func bargeIn() {
        let spokenThrough = speaker.stop()
        if let corr = activeCorrelationId {
            Task { try? await client.send(.userCancel(UserCancelPayload(targetCorrelationId: corr, spokenThroughIndex: spokenThrough))) }
        }
        agentState = isListening ? .listening : .idle
    }

    func respond(to card: ConfirmationCard, approve: Bool) {
        update(confirmation: card.approvalId) { $0.decision = approve ? "approved" : "denied" }
        Task { try? await client.send(.toolConfirmationRespond(ToolConfirmationRespondPayload(approvalId: card.approvalId, decision: approve ? "approve" : "deny")), correlationId: card.correlationId) }
    }

    func decide(action: PendingActionSummary, in card: NotificationCard, approve: Bool) async {
        do {
            let result = try await inbox.decide(approvalId: action.approvalId, approve: approve)
            update(notification: card.id) { n in
                if let i = n.pendingActions.firstIndex(where: { $0.approvalId == action.approvalId }) {
                    n.pendingActions[i].decision = result.outcome
                }
            }
        } catch {
            lastError = AppModel.describe(error)
        }
        persist()
    }

    func setListening(_ on: Bool) {
        isListening = on
        if on { agentState = .listening } else { recomputeState() }
    }

    var isBusy: Bool { activeCorrelationId != nil || speaker.isSpeaking }

    // MARK: - eventi

    private func handle(_ signal: ProtocolClient.Signal) {
        switch signal {
        case .state(let s):
            connection = s
        case .gap(let expected, let received):
            Log.net.info("buco di sequenza: atteso \(expected) ricevuto \(received)")
        case .event(let e):
            apply(e)
        }
    }

    private func apply(_ e: AgentEvent) {
        lastSeq = max(lastSeq, e.seq)
        switch e.payload {
        case .sessionStarted(let p):
            if let replayed = p.replayed, replayed > 0 { Log.net.info("ripresa: \(replayed) eventi rinviati") }
        case .assistantStarted(let p):
            upsertAssistant(for: e.correlationId) { m in
                m.route = p.route
                m.modelClass = p.modelClass
                m.isStreaming = true
            }
            if shouldSpeak(e.correlationId) { speaker.beginTurn() }
            if activeCorrelationId == e.correlationId { agentState = .thinking }
        case .assistantTextDelta(let p):
            currentTrace?.mark(.firstToken)
            upsertAssistant(for: e.correlationId) { $0.text += p.delta }
            if shouldSpeak(e.correlationId) { speaker.feed(p.delta) }
        case .assistantTextCompleted(let p):
            currentTrace?.mark(.textCompleted)
            upsertAssistant(for: e.correlationId) { $0.text = p.text }
            if shouldSpeak(e.correlationId) { speaker.flush(fullText: p.text) }
        case .toolStarted(let p):
            upsertAssistant(for: e.correlationId) { m in
                m.tools.append(ToolActivity(id: p.toolCallId, toolId: p.toolId, displayName: p.displayName, argsPreview: p.argsPreview))
            }
        case .toolCompleted(let p):
            upsertAssistant(for: e.correlationId) { m in
                if let i = m.tools.firstIndex(where: { $0.id == p.toolCallId }) {
                    m.tools[i].ok = p.ok
                    m.tools[i].durationMs = p.durationMs
                    m.tools[i].error = p.error
                }
            }
        case .assistantCompleted(let p):
            upsertAssistant(for: e.correlationId) { m in
                m.isStreaming = false
                m.usage = p.usage
            }
            finishTurn(e.correlationId)
        case .assistantCancelled:
            upsertAssistant(for: e.correlationId) { m in
                m.isStreaming = false
                m.cancelled = true
            }
            finishTurn(e.correlationId)
        case .toolConfirmationRequested(let p):
            items.append(.confirmation(ConfirmationCard(approvalId: p.approvalId, correlationId: e.correlationId, toolId: p.toolId, displayName: p.displayName, argsPreview: p.argsPreview, reason: p.reason, expiresAt: p.expiresAt)))
            persist()
        case .toolConfirmationResolved(let p):
            update(confirmation: p.approvalId) { $0.decision = p.decision }
        case .assistantBlock(let p):
            onBlock?(p.block)
            if case .unknown = p.block { break }
            upsertAssistant(for: e.correlationId) { m in
                if !m.blocks.contains(p.block) { m.blocks.append(p.block) }
            }
        case .avatarEmotion(let p):
            lastAvatarEmotion = p.name
        case .automationRunUpdated:
            inbox.scheduleRefresh()
        case .error(let p):
            fail(p.message)
            if activeCorrelationId == e.correlationId { finishTurn(e.correlationId) }
        case .sessionPong, .avatarGesture, .avatarGaze, .unknown, .sessionStart, .userMessage, .userCancel, .sessionPing, .toolConfirmationRespond:
            break
        }
    }

    private func shouldSpeak(_ correlationId: String) -> Bool {
        guard correlationId == activeCorrelationId, settings.voiceOutput else { return false }
        return activeInputMode == "voice" || settings.speakTextReplies
    }

    /// Zittisce la voce (pulsante in alto) lasciando che il turno continui per iscritto.
    func muteSpeech() {
        _ = speaker.stop()
        recomputeState()
    }

    private func finishTurn(_ correlationId: String) {
        guard activeCorrelationId == correlationId else { return }
        activeCorrelationId = nil
        if !speaker.isSpeaking { closeTrace() }
        recomputeState()
        persist()
    }

    private func closeTrace() {
        if let t = currentTrace, t.marks[.messageSent] != nil {
            latencyHistory.append(t)
            if latencyHistory.count > 30 { latencyHistory.removeFirst() }
        }
        currentTrace = nil
    }

    private func recomputeState() {
        if isListening { agentState = .listening } else if speaker.isSpeaking { agentState = .speaking } else if activeCorrelationId != nil { agentState = .thinking } else { agentState = .idle }
    }

    private func fail(_ message: String) {
        lastError = message
        items.append(.message(ChatMessage(id: Ids.new(), correlationId: Ids.new(), role: .system, text: message, createdAt: .now)))
    }

    // MARK: - voce

    private func wireSpeaker() {
        speaker.onSpeakingChanged = { [weak self] speaking in
            guard let self else { return }
            if speaking {
                self.currentTrace?.mark(.firstSpeech)
            } else {
                self.currentTrace?.mark(.speechEnded)
                if self.activeCorrelationId == nil { self.closeTrace() }
            }
            self.recomputeState()
        }
    }

    // MARK: - elementi

    private func upsertAssistant(for correlationId: String, _ mutate: (inout ChatMessage) -> Void) {
        if let i = items.lastIndex(where: { if case .message(let m) = $0 { return m.role == .assistant && m.correlationId == correlationId }; return false }),
           case .message(var m) = items[i] {
            mutate(&m)
            items[i] = .message(m)
        } else {
            var m = ChatMessage(id: Ids.new(), correlationId: correlationId, role: .assistant, text: "", isStreaming: true, createdAt: .now)
            mutate(&m)
            items.append(.message(m))
        }
    }

    private func update(confirmation approvalId: String, _ mutate: (inout ConfirmationCard) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == "c:\(approvalId)" }), case .confirmation(var c) = items[i] else { return }
        mutate(&c)
        items[i] = .confirmation(c)
    }

    private func update(notification id: String, _ mutate: (inout NotificationCard) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == "n:\(id)" }), case .notification(var n) = items[i] else { return }
        mutate(&n)
        items[i] = .notification(n)
    }

    private func merge(_ cards: [NotificationCard]) {
        var changed = false
        var fresh: [NotificationCard] = []
        for card in cards {
            if let i = items.firstIndex(where: { $0.id == "n:\(card.id)" }) {
                // Scheda già presente: allinea le decisioni prese altrove (altro dispositivo, REST).
                if case .notification(let current) = items[i], current.pendingActions != card.pendingActions {
                    items[i] = .notification(card)
                    changed = true
                }
            } else {
                fresh.append(card)
            }
        }
        if !fresh.isEmpty {
            items.append(contentsOf: fresh.sorted { $0.createdAt < $1.createdAt }.map(ChatItem.notification))
            changed = true
        }
        if changed { persist() }
    }

    private func persist() {
        if items.count > 400 { items.removeFirst(items.count - 400) }
        transcript.save(.init(sessionId: sessionId, lastSeq: lastSeq, items: items, updatedAt: .now))
    }
}
