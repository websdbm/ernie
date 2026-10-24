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
    /// Espressione temporanea (M10): torna neutra dopo il parlato e la durata indicata dal server.
    private var emotionTask: Task<Void, Never>?
    var currentTrace: LatencyTrace?
    var settings: LocalSettings
    /// Testo da proporre nel campo di scrittura (es. «Affina la ricetta …»): letto e azzerato dalla barra di input.
    var composerSuggestion: String?
    /// Local game launch shared by typed input and speech transcription; never queued to the server.
    private(set) var gameLaunchID: UUID?
    let gameStorageID: String
    /// Blocchi strutturati in arrivo (es. liste della spesa): l'app aggiorna gli store dedicati.
    var onBlock: ((ContentBlock) -> Void)?
    /// Ogni messaggio in famiglia che entra nella chat (gli urgenti vanno a tutto schermo).
    var onFamilyMessage: ((FamilyMessageBlock) -> Void)?
    /// Turno chiuso del tutto (risposta finita e voce terminata): la conversazione continua riapre il microfono.
    var onSettled: (() -> Void)?

    private(set) var activeCorrelationId: String?
    private var activeInputMode: String?
    private var speechCorrelationId: String?
    private var lastSeq = -1
    private let speaker: Speaker
    private let inbox: InboxStore
    private let transcript: TranscriptStore
    private let deviceContext: () -> DeviceContextPayload?
    private let performanceQueue: PerformanceObservationQueue
    private let performance: PerformanceTurnRecorder
    private let client: ProtocolClient
    private var sessionSwitch: Task<Void, Never>?
    private var pump: Task<Void, Never>?
    private var isListening = false
    private var activeRequest: ChatRequestRecovery?
    private var failedRequest: ChatRequestRecovery?
    private var safeRequestReplay = false
    private var turnWatch: Task<Void, Never>?
    private var wantsConnection = false
    private(set) var isAttached = true
    private var mutedCorrelationId: String?
    private(set) var recoveryStatus: String?
    var canRecoverRequest: Bool { failedRequest?.isRecoverable == true && activeCorrelationId == nil }


    init(credentials: Credentials, speaker: Speaker, inbox: InboxStore, settings: LocalSettings, transcript: TranscriptStore = TranscriptStore(), performanceQueue: PerformanceObservationQueue? = nil,
         deviceContext: @escaping () -> DeviceContextPayload? = { DeviceContextProvider.shared.context() }) {
        self.gameStorageID = ErnieTRIXSession.storageID(for: credentials)
        self.deviceContext = deviceContext
        let api = ApiClient(credentials: credentials)
        let queue = performanceQueue ?? PerformanceObservationQueue(send: { try await api.performanceObservations($0) })
        self.performanceQueue = queue
        self.performance = PerformanceTurnRecorder(emit: { queue.enqueue($0) })
        self.transcript = transcript
        self.speaker = speaker
        self.inbox = inbox
        self.settings = settings
        let store = transcript
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
        // Messaggi rimasti «in attesa» quando l'app è stata chiusa: partono appena c'è la connessione.
        outbox = Self.pendingOutbox(loadedItems)
        restoreRequest(loadedItems)
        wireSpeaker()
        inbox.onCards = { [weak self] cards in self?.merge(cards) }
    }

    // MARK: - connessione

    func connect() {
        isAttached = true
        wantsConnection = true
        #if DEBUG
        // Solo per le verifiche in simulatore: SIMCTL_CHILD_ERNIE_DEBUG_EMOTION=happy|sad|surprised|playful|love.
        if let e = ProcessInfo.processInfo.environment["ERNIE_DEBUG_EMOTION"], !e.isEmpty {
            showEmotion(e, durationMs: 30_000)
        }
        #endif
        pump?.cancel()
        pump = Task { [weak self] in
            guard let self else { return }
            guard self.isAttached, !Task.isCancelled else { return }
            await self.client.connect()
            guard self.isAttached, !Task.isCancelled else { await self.client.disconnect(); return }
            for await signal in self.client.signals {
                if Task.isCancelled { return }
                self.handle(signal)
            }
        }
    }

    func disconnect() {
        performanceQueue.invalidate()
        performance.end(.abandoned)
        isAttached = false
        onSettled = nil
        onBlock = nil
        onFamilyMessage = nil
        speaker.onSpeakingChanged = nil
        speaker.onAudibleStarted = nil
        speaker.onPlaybackFailed = nil
        _ = speaker.stop()
        wantsConnection = false
        turnWatch?.cancel()
        sessionSwitch?.cancel()
        emotionTask?.cancel()
        pump?.cancel()
        Task { await client.disconnect() }
    }

    private static let noSession = "00000000-0000-0000-0000-000000000000"

    /// Una sola ripresa automatica da `session_forbidden` per avvio (evita cicli se il server rifiuta anche la nuova).
    private var recoveredForeignSession = false

    /// Nuova sessione sul server; con `keepingHistory` le schede e i messaggi già visibili restano nella conversazione.
    private func adoptNewSession(keepingHistory: Bool) {
        lastSeq = -1
        sessionId = Ids.new()
        transcript.setCurrent(sessionId)
        if !keepingHistory { items = [] }
        persist()
        let sid = sessionId
        Log.chat.info("sessione salvata non disponibile: nuova sessione \(sid, privacy: .public)")
        switchTransport(to: sid)
    }

    func startNewSession() {
        guard isAttached else { return }
        performance.end(.abandoned)
        _ = speaker.stop()
        activeCorrelationId = nil
        activeRequest = nil
        failedRequest = nil
        recoveryStatus = nil
        safeRequestReplay = false
        agentState = .idle
        // I messaggi in coda appartenevano alla conversazione di prima: non devono partire in questa.
        outbox = []
        items = []
        lastSeq = -1
        sessionId = Ids.new()
        transcript.setCurrent(sessionId)
        persist()
        let sid = sessionId
        switchTransport(to: sid)
    }

    private func switchTransport(to target: String, lastSeq: Int = -1) {
        let previous = sessionSwitch
        sessionSwitch = Task {
            await previous?.value
            guard isAttached, sessionId == target, !Task.isCancelled else { return }
            await client.switchSession(to: target, lastSeq: lastSeq)
            if !isAttached { await client.disconnect() }
        }
    }

    /// Conversazioni passate salvate sul telefono (pannello laterale).
    func pastSessions() -> [TranscriptStore.SessionSummary] { transcript.list() }

    /// Riprende una conversazione passata: messaggi e schede dal telefono, stessa sessione sul server (che ne ricorda
    /// la memoria), ripresa degli eventi dall'ultimo numero di sequenza visto.
    func resume(sessionId target: String) {
        guard isAttached, target != sessionId, let file = transcript.load(target) else { return }
        performance.end(.abandoned)
        _ = speaker.stop()
        activeCorrelationId = nil
        activeRequest = nil
        failedRequest = nil
        recoveryStatus = nil
        safeRequestReplay = false
        agentState = .idle
        outbox = []
        items = file.items.map { item in
            if case .message(var m) = item, m.isStreaming {
                m.isStreaming = false
                return .message(m)
            }
            return item
        }
        lastSeq = file.lastSeq
        sessionId = target
        transcript.setCurrent(target)
        outbox = Self.pendingOutbox(items)
        restoreRequest(items)
        let seq = file.lastSeq
        switchTransport(to: target, lastSeq: seq)
    }

    /// Toglie una conversazione passata dal telefono (non quella aperta).
    func deleteSession(_ id: String) {
        guard id != sessionId else { return }
        transcript.delete(id)
    }

    // MARK: - azioni dell'utente

    /// Messaggi scritti o toccati (schede) mentre Ernie sta ancora rispondendo: partono uno alla volta a turno finito.
    private struct Outgoing { let messageId: String; let text: String; let inputMode: String; let attachments: [DocumentRef]; var payload: UserMessagePayload? = nil; var trace: LatencyTrace? = nil }
    private var outbox: [Outgoing] = []
    var queuedCount: Int { outbox.count }

    /// Coda ricostruita dai fumetti segnati «in attesa» (gli allegati non si salvano: partono senza).
    private static func pendingOutbox(_ items: [ChatItem]) -> [Outgoing] {
        items.compactMap { item in
            guard case .message(let m) = item, m.role == .user, m.queued == true else { return nil }
            return Outgoing(messageId: m.id, text: m.text, inputMode: m.inputMode ?? "text", attachments: [], payload: m.requestPayload)
        }
    }

    /// Ultimo evento ricevuto per il turno aperto: senza notizie per troppo tempo il turno si chiude da solo.
    private var turnActivityAt = Date.distantPast

    func send(_ raw: String, inputMode: String, attachments: [DocumentRef] = []) {
        guard isAttached else { return }
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty, !attachments.isEmpty { text = "Leggi questo allegato." }
        guard !text.isEmpty else { return }
        if ErnieTRIXLaunch.matches(text, hasAttachments: !attachments.isEmpty) {
            if speaker.isSpeaking { muteSpeech() }
            if activeCorrelationId == nil { currentTrace = nil }
            gameLaunchID = UUID()
            return
        }
        if canRecoverRequest, ["riprova", "riprendi", "riprova."].contains(text.lowercased()) {
            recoverLastRequest()
            return
        }
        // Risposta a voce in corso: si zittisce la voce ma il turno continua (la risposta scritta arriva intera);
        // il nuovo messaggio si mette in coda e parte a turno finito.
        if speaker.isSpeaking { muteSpeech() }
        let payload = UserMessagePayload(text: text, inputMode: inputMode, locale: "it-IT",
            attachments: attachments.isEmpty ? nil : attachments.map { DocumentAttachment(id: $0.id) },
            device: deviceContext())
        let info = attachments.map { AttachmentInfo(id: $0.id, title: $0.title, pages: $0.pages) }
        let messageId = Ids.new()
        let queued = activeCorrelationId != nil
        failedRequest = nil
        items.append(.message(ChatMessage(id: messageId, correlationId: queued ? "" : Ids.new(), role: .user, text: text, inputMode: inputMode, createdAt: .now, attachments: info.isEmpty ? nil : info, queued: queued ? true : nil, requestPayload: payload)))
        lastError = nil
        let outgoing = Outgoing(messageId: messageId, text: text, inputMode: inputMode, attachments: attachments, payload: payload, trace: inputMode == "voice" ? currentTrace : nil)
        if queued {
            outbox.append(outgoing)
            persist()
        } else {
            dispatch(outgoing)
        }
    }

    /// Invia davvero un messaggio: apre il turno e lo manda al server.
    private func dispatch(_ out: Outgoing) {
        guard isAttached else { return }
        let correlationId = Ids.new()
        let payload = out.payload ?? UserMessagePayload(text: out.text, inputMode: out.inputMode, locale: "it-IT",
            attachments: out.attachments.isEmpty ? nil : out.attachments.map { DocumentAttachment(id: $0.id) },
            device: deviceContext())
        activeRequest = ChatRequestRecovery(messageId: out.messageId, correlationId: correlationId, payload: payload)
        recoveryStatus = nil
        if let i = items.firstIndex(where: { $0.id == "m:\(out.messageId)" }), case .message(var m) = items[i] {
            m.correlationId = correlationId
            m.queued = nil
            m.requestPayload = payload
            m.awaitingResponse = true
            m.recoveryNeeded = nil
            items[i] = .message(m)
        }
        activeCorrelationId = correlationId
        activeInputMode = out.inputMode
        turnActivityAt = .now
        agentState = .thinking
        watchTurn(correlationId)
        currentTrace = out.trace ?? LatencyTrace()
        currentTrace?.mark(.messageSent)
        performance.begin(session: sessionId, request: correlationId, mode: out.inputMode, trace: currentTrace!)
        persist()
        guard connection == .connected else {
            recoveryStatus = "Attendo la connessione per inviare la richiesta…"
            return
        }
        Task {
            do {
                try await client.send(.userMessage(payload), correlationId: correlationId)
            } catch {
                // Esito del trasporto incerto: recupera con la stessa identità, senza duplicare azioni.
                guard self.wantsConnection, self.activeCorrelationId == correlationId else { return }
                self.recoveryStatus = "Connessione interrotta. Recupero la richiesta…"
                Task { await self.client.reconnect() }
            }
        }
    }

    private func restoreRequest(_ loaded: [ChatItem]) {
        for item in loaded.reversed() {
            guard case .message(let message) = item, message.role == .user else { continue }
            if message.queued == true { continue }
            if message.awaitingResponse == true, let request = ChatRequestRecovery.from(message) {
                activeRequest = request
                activeCorrelationId = request.correlationId
                activeInputMode = request.payload.inputMode
                turnActivityAt = .now
                agentState = .thinking
            } else if message.recoveryNeeded == true {
                failedRequest = ChatRequestRecovery.from(message)
            }
            break
        }
    }

    private func markRequest(_ request: ChatRequestRecovery, pending: Bool, failed: Bool = false) {
        guard let i = items.firstIndex(where: { $0.id == "m:\(request.messageId)" }),
              case .message(var message) = items[i] else { return }
        message.awaitingResponse = pending
        message.recoveryNeeded = failed
        items[i] = .message(message)
    }

    func recoverLastRequest() {
        guard canRecoverRequest, var request = failedRequest else { return }
        failedRequest = nil
        request.attempts = 0
        activeRequest = request
        activeCorrelationId = request.correlationId
        activeInputMode = request.payload.inputMode
        markRequest(request, pending: true)
        turnActivityAt = .now
        agentState = .thinking
        lastError = nil
        persist()
        watchTurn(request.correlationId)
        if connection == .connected { recoverActiveRequest() }
        else { Task { await client.reconnect() } }
    }

    private func recoverActiveRequest() {
        performance.reconnect()
        guard var request = activeRequest, request.correlationId == activeCorrelationId else { return }
        guard request.isRecoverable else {
            interruptTurn(request.correlationId, recoverable: false)
            return
        }
        guard safeRequestReplay else {
            interruptTurn(request.correlationId)
            return
        }
        guard request.nextAttempt() else {
            interruptTurn(request.correlationId)
            return
        }
        activeRequest = request
        recoveryStatus = "Recupero della risposta (\(request.attempts)/3)…"
        turnActivityAt = .now
        watchTurn(request.correlationId)
        Task { [weak self] in
            guard let self else { return }
            do { try await self.client.send(.userMessage(request.payload), correlationId: request.correlationId) }
            catch {
                guard self.wantsConnection, self.activeCorrelationId == request.correlationId else { return }
                try? await Task.sleep(for: .seconds(Double(request.attempts * 2)))
                guard self.wantsConnection, self.activeCorrelationId == request.correlationId else { return }
                await self.client.reconnect()
            }
        }
    }

    /// Turno senza notizie (connessione persa a metà, server riavviato): dopo due minuti si chiude da solo, tranne
    /// mentre aspetta una conferma dell'utente.
    private func watchTurn(_ correlationId: String) {
        turnWatch?.cancel()
        turnWatch = Task { [weak self] in
            while true {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self, self.activeCorrelationId == correlationId else { return }
                let waiting = self.items.contains { item in
                    if case .confirmation(let c) = item { return c.correlationId == correlationId && c.decision == nil }
                    return false
                }
                if !waiting, Date().timeIntervalSince(self.turnActivityAt) > 120 {
                    if self.connection == .connected, self.safeRequestReplay,
                       let request = self.activeRequest, request.attempts < 3 {
                        self.turnActivityAt = .now
                        await self.client.reconnect()
                    } else {
                        self.interruptTurn(correlationId)
                    }
                    return
                }
            }
        }
    }

    /// Chiude in locale un turno di cui il server non manderà più la fine (revisione del 16 ott 2026: dopo una
    /// disconnessione si restava su «ci penso» per sempre e i nuovi messaggi aspettavano senza partire).
    private func interruptTurn(_ correlationId: String, recoverable: Bool = true) {
        guard activeCorrelationId == correlationId else { return }
        if let request = activeRequest {
            failedRequest = recoverable ? request : nil
            markRequest(request, pending: false, failed: recoverable)
        }
        activeRequest = nil
        recoveryStatus = nil
        if let i = items.lastIndex(where: { if case .message(let m) = $0 { return m.role == .assistant && m.correlationId == correlationId }; return false }),
           case .message(var m) = items[i] {
            m.isStreaming = false
            m.cancelled = true
            items[i] = .message(m)
        } else {
            items.append(.message(ChatMessage(id: Ids.new(), correlationId: Ids.new(), role: .system, text: "Non riesco a recuperare la risposta dopo più tentativi. Puoi riprendere la stessa richiesta con «Recupera risposta».", createdAt: .now)))
        }
        activeCorrelationId = nil
        performance.end(.interrupted)
        closeTrace()
        recomputeState()
        persist()
        drainOutbox()
    }

    /// Riconnessione: parte la coda; il turno aperto, se nella ripresa non arriva niente, era perso.
    private func onReconnected() {
        lastError = nil
        if activeCorrelationId != nil { recoverActiveRequest() }
        else { drainOutbox() }
    }

    /// A turno chiuso, parte il primo messaggio in coda (se c'è).
    private func drainOutbox() {
        guard isAttached else { return }
        guard activeCorrelationId == nil, !outbox.isEmpty else { return }
        dispatch(outbox.removeFirst())
    }

    /// Il server ha rifiutato il messaggio perché un turno era ancora aperto: torna in coda e riparte da solo.
    private func requeue(correlationId: String) {
        performance.complete(request: correlationId, outcome: .error, speaking: false)
        guard let i = items.firstIndex(where: { if case .message(let m) = $0 { return m.correlationId == correlationId && m.role == .user } ; return false }),
              case .message(var m) = items[i] else { return }
        m.queued = true
        items[i] = .message(m)
        outbox.insert(Outgoing(messageId: m.id, text: m.text, inputMode: m.inputMode ?? "text", attachments: [], payload: m.requestPayload), at: 0)
        if activeCorrelationId == correlationId {
            activeCorrelationId = nil
            activeRequest = nil
            turnWatch?.cancel()
        }
        recomputeState()
        persist()
        Task {
            try? await Task.sleep(for: .milliseconds(1500))
            drainOutbox()
        }
    }

    /// Barge-in: ferma la voce subito e dice al server fino a dove l'utente ha sentito.
    func bargeIn() {
        performance.end(.cancelled)
        mutedCorrelationId = activeCorrelationId
        let spokenThrough = speaker.stop()
        if let corr = activeCorrelationId {
            Task { try? await client.send(.userCancel(UserCancelPayload(targetCorrelationId: corr, spokenThroughIndex: spokenThrough))) }
            // Se il server non conosce più quel turno non risponde: Stop deve sbloccare comunque.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(3))
                guard let self, self.activeCorrelationId == corr, !self.speaker.isSpeaking else { return }
                self.interruptTurn(corr, recoverable: false)
            }
        }
        agentState = isListening ? .listening : .idle
    }

    func respond(to card: ConfirmationCard, approve: Bool, always: Bool = false) {
        update(confirmation: card.approvalId) {
            $0.decision = approve ? "approved" : "denied"
            if approve && always { $0.always = true }
        }
        let payload = ToolConfirmationRespondPayload(
            approvalId: card.approvalId,
            decision: approve ? "approve" : "deny",
            always: approve && always ? true : nil
        )
        Task { try? await client.send(.toolConfirmationRespond(payload), correlationId: card.correlationId) }
    }

    /// «Riprendi» su un'automazione messa in pausa dal server dopo fallimenti ripetuti.
    func resume(_ card: NotificationCard) async {
        guard let id = card.automationId else { return }
        do {
            try await inbox.resumeAutomation(id: id)
            update(notification: card.id) { $0.resumed = true }
        } catch {
            update(notification: card.id) { $0.resumed = false }
            lastError = AppModel.describe(error)
        }
        persist()
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

    /// Mostra un'espressione e la riporta a neutra quando Ernie ha finito di parlare e la durata è passata.
    private func showEmotion(_ name: String, durationMs: Int) {
        Log.chat.debug("espressione mostrata: \(name, privacy: .public) per \(durationMs) ms")
        lastAvatarEmotion = name
        emotionTask?.cancel()
        emotionTask = Task { [weak self] in
            // L'evento arriva a fine turno, spesso prima che la voce parta: con la voce accesa si aspetta che il
            // parlato cominci (al più 6 s) e poi che finisca; la durata parte da lì (prima l'espressione restava
            // visibile un secondo appena, perché il conto partiva prima della voce).
            var waited = 0
            if self?.settings.voiceOutput == true {
                while let self, !self.speaker.isSpeaking, self.agentState != .idle || waited < 1500,
                      waited < 6_000, !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250))
                    waited += 250
                }
            }
            waited = 0
            while let self, self.speaker.isSpeaking || self.agentState == .speaking, waited < 90_000, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                waited += 250
            }
            try? await Task.sleep(for: .milliseconds(durationMs))
            guard !Task.isCancelled else { return }
            self?.lastAvatarEmotion = "neutral"
        }
    }

    func setListening(_ on: Bool) {
        isListening = on
        if on { agentState = .listening } else { recomputeState() }
    }

    var isBusy: Bool { activeCorrelationId != nil || speaker.isSpeaking }

    // MARK: - eventi

    private func handle(_ signal: ProtocolClient.Signal) {
        guard isAttached else { return }
        switch signal {
        case .state(let s):
            connection = s
            if s != .connected, activeCorrelationId != nil {
                recoveryStatus = "Connessione interrotta. Recupero la richiesta…"
                performance.reconnect()
            }
        case .gap(let expected, let received):
            Log.net.info("buco di sequenza: atteso \(expected) ricevuto \(received)")
        case .event(let e):
            apply(e)
        }
    }

    func apply(_ e: AgentEvent) {
        guard isAttached else { return }
        // Eventi di un'altra conversazione (risposta in corso quando si è aperta «Nuova conversazione»): fuori.
        if e.sessionId != sessionId, e.sessionId != Self.noSession { return }
        if e.sessionId == sessionId { lastSeq = max(lastSeq, e.seq) }
        if e.correlationId == activeCorrelationId {
            turnActivityAt = .now
            if e.type != "session.pong" { recoveryStatus = nil }
        }
        switch e.payload {
        case .sessionStarted(let p):
            safeRequestReplay = p.safeRequestReplay == true
            onReconnected()
            if let replayed = p.replayed, replayed > 0 { Log.net.info("ripresa: \(replayed) eventi rinviati") }
        case .assistantStarted(let p):
            upsertAssistant(for: e.correlationId) { m in
                m.route = p.route
                m.modelClass = p.modelClass
                m.isStreaming = true
            }
            if shouldSpeak(e.correlationId) { speaker.beginTurn(); speechCorrelationId = e.correlationId }
            if activeCorrelationId == e.correlationId { agentState = .thinking }
        case .assistantTextDelta(let p):
            if !p.delta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { performance.mark(.firstToken, request: e.correlationId) }
            if e.correlationId == activeCorrelationId { currentTrace?.mark(.firstToken) }
            upsertAssistant(for: e.correlationId) { $0.text += p.delta }
            if shouldSpeak(e.correlationId) { speechCorrelationId = e.correlationId; speaker.feed(p.delta) }
        case .assistantTextCompleted(let p):
            if !p.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { performance.mark(.firstToken, request: e.correlationId) }
            if e.correlationId == activeCorrelationId { currentTrace?.mark(.textCompleted) }
            upsertAssistant(for: e.correlationId) { $0.text = p.text }
            if shouldSpeak(e.correlationId) { speechCorrelationId = e.correlationId; speaker.flush(fullText: p.text) }
        case .toolStarted(let p):
            upsertAssistant(for: e.correlationId) { m in
                if m.tools.contains(where: { $0.id == p.toolCallId }) { return }
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
            let outcome: PerformanceObservation.Outcome = switch p.finishReason {
            case "error": .error
            case "cancelled": .cancelled
            default: .completed
            }
            performance.complete(request: e.correlationId, outcome: outcome, speaking: speaker.isSpeaking && speechCorrelationId == e.correlationId)
            upsertAssistant(for: e.correlationId) { m in
                m.isStreaming = false
                m.usage = p.usage
            }
            finishTurn(e.correlationId)
        case .assistantCancelled:
            performance.complete(request: e.correlationId, outcome: .cancelled, speaking: speaker.isSpeaking && speechCorrelationId == e.correlationId)
            upsertAssistant(for: e.correlationId) { m in
                m.isStreaming = false
                m.cancelled = true
            }
            finishTurn(e.correlationId)
        case .toolConfirmationRequested(let p):
            performance.mark(.firstToken, request: e.correlationId)
            items.append(.confirmation(ConfirmationCard(approvalId: p.approvalId, correlationId: e.correlationId, toolId: p.toolId, displayName: p.displayName, argsPreview: p.argsPreview, reason: p.reason, expiresAt: p.expiresAt, allowAlways: p.allowAlways, presentation: p.presentation)))
            persist()
        case .toolConfirmationResolved(let p):
            update(confirmation: p.approvalId) { $0.decision = p.decision }
        case .assistantBlock(let p):
            if case .unknown = p.block { /* No visible content to measure. */ }
            else { performance.mark(.firstToken, request: e.correlationId) }
            // Messaggio in famiglia: un fumetto suo nella conversazione, non dentro la risposta di Ernie.
            if case .familyMessage(let f) = p.block {
                addFamily(f)
                break
            }
            onBlock?(p.block)
            if case .unknown = p.block { break }
            if case .todoList(let update) = p.block,
               activeCorrelationId != e.correlationId,
               !items.contains(where: { if case .message(let m) = $0 { return m.correlationId == e.correlationId }; return false }) {
                // Gli aggiornamenti dei promemoria hanno un correlationId autonomo: non sono nuovi turni.
                items.refreshTodoList(update.list)
                persist()
                break
            }
            upsertAssistant(for: e.correlationId) { m in
                switch p.block {
                case .shoppingList, .todoList:
                    m.blocks.append(p.block)
                    m.coalesceListSnapshots()
                    return
                default: break
                }
                // Più promemoria creati nello stesso turno: una scheda sola con tutti, non una per promemoria.
                if case .reminders(let incoming) = p.block,
                   let i = m.blocks.firstIndex(where: { if case .reminders = $0 { return true }; return false }),
                   case .reminders(var merged) = m.blocks[i] {
                    for r in incoming.reminders {
                        if let j = merged.reminders.firstIndex(where: { $0.id == r.id }) { merged.reminders[j] = r }
                        else { merged.reminders.append(r) }
                    }
                    if merged.reminders.count > 1, merged.title == incoming.title { merged.title = "Promemoria impostati" }
                    m.blocks[i] = .reminders(merged)
                    return
                }
                if !m.blocks.contains(p.block) { m.blocks.append(p.block) }
            }
        case .avatarEmotion(let p):
            Log.chat.info("espressione dell'avatar: \(p.name, privacy: .public)")
            showEmotion(p.name, durationMs: p.durationMs ?? 5000)
        case .automationRunUpdated, .inboxUpdated:
            inbox.scheduleRefresh()
        case .error(let p):
            if p.code == "busy" {
                requeue(correlationId: e.correlationId)
                break
            }
            // La sessione salvata appartiene a un altro utente o server (dopo «Cambia server» o una chiave nuova):
            // si apre una sessione nuova tenendo la cronologia visibile e si rimanda il messaggio, una volta sola.
            if p.code == "session_forbidden", !recoveredForeignSession {
                recoveredForeignSession = true
                adoptNewSession(keepingHistory: true)
                requeue(correlationId: e.correlationId)
                break
            }
            if p.code == "session_forbidden" { break }
            performance.complete(request: e.correlationId, outcome: .error, speaking: speaker.isSpeaking && speechCorrelationId == e.correlationId)
            fail(p.message)
            if activeCorrelationId == e.correlationId { finishTurn(e.correlationId) }
        case .sessionPong, .avatarGesture, .avatarGaze, .unknown, .sessionStart, .userMessage, .userCancel, .sessionPing, .toolConfirmationRespond:
            break
        }
    }

    private func shouldSpeak(_ correlationId: String) -> Bool {
        guard isAttached, correlationId != mutedCorrelationId, correlationId == activeCorrelationId, settings.voiceOutput else { return false }
        return activeInputMode == "voice" || settings.speakTextReplies
    }

    /// Zittisce la voce (pulsante in alto) lasciando che il turno continui per iscritto.
    func muteSpeech() {
        if speaker.isSpeaking, let speechCorrelationId { performance.interruptSpeech(request: speechCorrelationId) }
        mutedCorrelationId = activeCorrelationId
        _ = speaker.stop()
        recomputeState()
    }

    private func finishTurn(_ correlationId: String) {
        // Anche una risposta arrivata dopo il limite di recupero va salvata nella cronologia.
        defer { persist() }
        if let request = failedRequest, request.correlationId == correlationId {
            markRequest(request, pending: false)
            failedRequest = nil
        }
        guard activeCorrelationId == correlationId else { return }
        if let request = activeRequest { markRequest(request, pending: false) }
        activeRequest = nil
        turnWatch?.cancel()
        recoveryStatus = nil
        activeCorrelationId = nil
        if !speaker.isSpeaking { closeTrace() }
        recomputeState()
        persist()
        drainOutbox()
    }

    private func closeTrace() {
        if let t = currentTrace, t.marks[.messageSent] != nil {
            latencyHistory.append(t)
            if latencyHistory.count > 30 { latencyHistory.removeFirst() }
        }
        currentTrace = nil
    }

    private func recomputeState() {
        let previous = agentState
        if isListening { agentState = .listening } else if speaker.isSpeaking { agentState = .speaking } else if activeCorrelationId != nil { agentState = .thinking } else { agentState = .idle }
        if agentState == .idle, previous != .idle { onSettled?() }
    }

    private func fail(_ message: String) {
        lastError = message
        items.append(.message(ChatMessage(id: Ids.new(), correlationId: Ids.new(), role: .system, text: message, createdAt: .now)))
    }

    // MARK: - voce

    private func wireSpeaker() {
        speaker.onPlaybackFailed = { [weak self] in
            guard let self, let request = self.speechCorrelationId else { return }
            self.performance.speechFailed(request: request)
        }
        speaker.onAudibleStarted = { [weak self] in
            self?.currentTrace?.mark(.firstSpeech)
            if let self, let request = self.speechCorrelationId { self.performance.audibleStarted(request: request) }
        }
        speaker.onSpeakingChanged = { [weak self] speaking in
            guard let self else { return }
            if !speaking {
                self.currentTrace?.markSpeechEnded()
                if let request = self.speechCorrelationId { self.performance.speechStopped(request: request) }
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
        guard isAttached else { return }
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

    /// Messaggio in famiglia (ricevuto o mandato): una volta sola per id, in fondo alla conversazione.
    func addFamily(_ m: FamilyMessageBlock) {
        guard isAttached else { return }
        FamilyMessageSync.noteSeen(m)
        FamilyLatest(block: m)?.saveAndReload()
        onFamilyMessage?(m)
        let index = items.firstIndex { item in
            if case .family(let f) = item { return f.id == m.id }
            return false
        }
        if let index {
            // Già nella chat: si aggiorna (conferma di lettura di un urgente).
            if case .family(let f) = items[index], f != m {
                items[index] = .family(m)
                persist()
            }
            return
        }
        items.append(.family(m))
        persist()
        if m.incoming { FamilyMessageSync.pendingRead.insert(m.id) }
    }

    private func persist() {
        guard isAttached else { return }
        if items.count > 400 { items.removeFirst(items.count - 400) }
        transcript.save(.init(sessionId: sessionId, lastSeq: lastSeq, items: items, updatedAt: .now))
    }
}
