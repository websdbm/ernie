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
    /// Blocchi strutturati in arrivo (es. liste della spesa): l'app aggiorna gli store dedicati.
    var onBlock: ((ContentBlock) -> Void)?
    /// Ogni messaggio in famiglia che entra nella chat (gli urgenti vanno a tutto schermo).
    var onFamilyMessage: ((FamilyMessageBlock) -> Void)?
    /// Turno chiuso del tutto (risposta finita e voce terminata): la conversazione continua riapre il microfono.
    var onSettled: (() -> Void)?

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
        // Messaggi rimasti «in attesa» quando l'app è stata chiusa: partono appena c'è la connessione.
        outbox = Self.pendingOutbox(loadedItems)
        wireSpeaker()
        inbox.onCards = { [weak self] cards in self?.merge(cards) }
    }

    // MARK: - connessione

    func connect() {
        #if DEBUG
        // Solo per le verifiche in simulatore: SIMCTL_CHILD_ERNIE_DEBUG_EMOTION=happy|sad|surprised|playful|love.
        if let e = ProcessInfo.processInfo.environment["ERNIE_DEBUG_EMOTION"], !e.isEmpty {
            showEmotion(e, durationMs: 30_000)
        }
        #endif
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
        Task { await client.switchSession(to: sid) }
    }

    func startNewSession() {
        _ = speaker.stop()
        activeCorrelationId = nil
        agentState = .idle
        // I messaggi in coda appartenevano alla conversazione di prima: non devono partire in questa.
        outbox = []
        items = []
        lastSeq = -1
        sessionId = Ids.new()
        transcript.setCurrent(sessionId)
        persist()
        let sid = sessionId
        Task { await client.switchSession(to: sid) }
    }

    /// Conversazioni passate salvate sul telefono (pannello laterale).
    func pastSessions() -> [TranscriptStore.SessionSummary] { transcript.list() }

    /// Riprende una conversazione passata: messaggi e schede dal telefono, stessa sessione sul server (che ne ricorda
    /// la memoria), ripresa degli eventi dall'ultimo numero di sequenza visto.
    func resume(sessionId target: String) {
        guard target != sessionId, let file = transcript.load(target) else { return }
        _ = speaker.stop()
        activeCorrelationId = nil
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
        let seq = file.lastSeq
        Task { await client.switchSession(to: target, lastSeq: seq) }
    }

    /// Toglie una conversazione passata dal telefono (non quella aperta).
    func deleteSession(_ id: String) {
        guard id != sessionId else { return }
        transcript.delete(id)
    }

    // MARK: - azioni dell'utente

    /// Messaggi scritti o toccati (schede) mentre Ernie sta ancora rispondendo: partono uno alla volta a turno finito.
    private struct Outgoing { let messageId: String; let text: String; let inputMode: String; let attachments: [DocumentRef] }
    private var outbox: [Outgoing] = []
    var queuedCount: Int { outbox.count }

    /// Coda ricostruita dai fumetti segnati «in attesa» (gli allegati non si salvano: partono senza).
    private static func pendingOutbox(_ items: [ChatItem]) -> [Outgoing] {
        items.compactMap { item in
            guard case .message(let m) = item, m.role == .user, m.queued == true else { return nil }
            return Outgoing(messageId: m.id, text: m.text, inputMode: m.inputMode ?? "text", attachments: [])
        }
    }

    /// Ultimo evento ricevuto per il turno aperto: senza notizie per troppo tempo il turno si chiude da solo.
    private var turnActivityAt = Date.distantPast

    func send(_ raw: String, inputMode: String, attachments: [DocumentRef] = []) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty, !attachments.isEmpty { text = "Riassumi questo documento per studiarlo e fammi lo schema." }
        guard !text.isEmpty else { return }
        // Risposta a voce in corso: si zittisce la voce ma il turno continua (la risposta scritta arriva intera);
        // il nuovo messaggio si mette in coda e parte a turno finito.
        if speaker.isSpeaking { muteSpeech() }
        let info = attachments.map { AttachmentInfo(id: $0.id, title: $0.title, pages: $0.pages) }
        let messageId = Ids.new()
        let queued = activeCorrelationId != nil
        items.append(.message(ChatMessage(id: messageId, correlationId: queued ? "" : Ids.new(), role: .user, text: text, inputMode: inputMode, createdAt: .now, attachments: info.isEmpty ? nil : info, queued: queued ? true : nil)))
        lastError = nil
        let outgoing = Outgoing(messageId: messageId, text: text, inputMode: inputMode, attachments: attachments)
        if queued {
            outbox.append(outgoing)
            persist()
        } else {
            dispatch(outgoing)
        }
    }

    /// Invia davvero un messaggio: apre il turno e lo manda al server.
    private func dispatch(_ out: Outgoing) {
        let correlationId = Ids.new()
        if let i = items.firstIndex(where: { $0.id == out.messageId }), case .message(var m) = items[i] {
            m.correlationId = correlationId
            m.queued = nil
            items[i] = .message(m)
        }
        activeCorrelationId = correlationId
        activeInputMode = out.inputMode
        turnActivityAt = .now
        agentState = .thinking
        watchTurn(correlationId)
        if currentTrace == nil || out.inputMode == "text" { currentTrace = LatencyTrace() }
        currentTrace?.mark(.messageSent)
        persist()
        Task {
            do {
                let payload = UserMessagePayload(
                    text: out.text, inputMode: out.inputMode, locale: "it-IT",
                    attachments: out.attachments.isEmpty ? nil : out.attachments.map { DocumentAttachment(id: $0.id) },
                    device: DeviceContextProvider.shared.context()
                )
                try await client.send(.userMessage(payload), correlationId: correlationId)
            } catch {
                // Non è partito (connessione assente o in ripresa): torna in coda e riparte da solo alla
                // riconnessione, invece di lasciare il turno aperto per sempre.
                self.backToQueue(out, correlationId: correlationId)
            }
        }
    }

    private func backToQueue(_ out: Outgoing, correlationId: String) {
        if let i = items.firstIndex(where: { $0.id == out.messageId }), case .message(var m) = items[i] {
            m.queued = true
            items[i] = .message(m)
        }
        outbox.insert(out, at: 0)
        if activeCorrelationId == correlationId { activeCorrelationId = nil }
        lastError = "Non sono collegato: lo mando appena torna la connessione."
        closeTrace()
        recomputeState()
        persist()
    }

    /// Turno senza notizie (connessione persa a metà, server riavviato): dopo due minuti si chiude da solo, tranne
    /// mentre aspetta una conferma dell'utente.
    private func watchTurn(_ correlationId: String) {
        Task { [weak self] in
            while true {
                try? await Task.sleep(for: .seconds(20))
                guard let self, self.activeCorrelationId == correlationId else { return }
                let waiting = self.items.contains { item in
                    if case .confirmation(let c) = item { return c.correlationId == correlationId && c.decision == nil }
                    return false
                }
                if !waiting, Date().timeIntervalSince(self.turnActivityAt) > 120 {
                    self.interruptTurn(correlationId)
                    return
                }
            }
        }
    }

    /// Chiude in locale un turno di cui il server non manderà più la fine (revisione del 16 ott 2026: dopo una
    /// disconnessione si restava su «ci penso» per sempre e i nuovi messaggi aspettavano senza partire).
    private func interruptTurn(_ correlationId: String) {
        guard activeCorrelationId == correlationId else { return }
        if let i = items.lastIndex(where: { if case .message(let m) = $0 { return m.role == .assistant && m.correlationId == correlationId }; return false }),
           case .message(var m) = items[i] {
            m.isStreaming = false
            m.cancelled = true
            items[i] = .message(m)
        } else {
            items.append(.message(ChatMessage(id: Ids.new(), correlationId: Ids.new(), role: .system, text: "La risposta si è persa per un problema di connessione: riprova.", createdAt: .now)))
        }
        activeCorrelationId = nil
        closeTrace()
        recomputeState()
        persist()
        drainOutbox()
    }

    /// Riconnessione: parte la coda; il turno aperto, se nella ripresa non arriva niente, era perso.
    private func onReconnected() {
        lastError = nil
        if let corr = activeCorrelationId {
            let since = Date.now
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(4))
                guard let self, self.activeCorrelationId == corr, self.turnActivityAt < since else { return }
                self.interruptTurn(corr)
            }
        } else {
            drainOutbox()
        }
    }

    /// A turno chiuso, parte il primo messaggio in coda (se c'è).
    private func drainOutbox() {
        guard activeCorrelationId == nil, !outbox.isEmpty else { return }
        dispatch(outbox.removeFirst())
    }

    /// Il server ha rifiutato il messaggio perché un turno era ancora aperto: torna in coda e riparte da solo.
    private func requeue(correlationId: String) {
        guard let i = items.firstIndex(where: { if case .message(let m) = $0 { return m.correlationId == correlationId && m.role == .user } ; return false }),
              case .message(var m) = items[i] else { return }
        m.queued = true
        items[i] = .message(m)
        outbox.insert(Outgoing(messageId: m.id, text: m.text, inputMode: m.inputMode ?? "text", attachments: []), at: 0)
        if activeCorrelationId == correlationId { activeCorrelationId = nil }
        recomputeState()
        persist()
        Task {
            try? await Task.sleep(for: .milliseconds(1500))
            drainOutbox()
        }
    }

    /// Barge-in: ferma la voce subito e dice al server fino a dove l'utente ha sentito.
    func bargeIn() {
        let spokenThrough = speaker.stop()
        if let corr = activeCorrelationId {
            Task { try? await client.send(.userCancel(UserCancelPayload(targetCorrelationId: corr, spokenThroughIndex: spokenThrough))) }
            // Se il server non conosce più quel turno non risponde: Stop deve sbloccare comunque.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(3))
                guard let self, self.activeCorrelationId == corr, !self.speaker.isSpeaking else { return }
                self.interruptTurn(corr)
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
        switch signal {
        case .state(let s):
            let wasConnected = connection == .connected
            connection = s
            if s == .connected, !wasConnected { onReconnected() }
        case .gap(let expected, let received):
            Log.net.info("buco di sequenza: atteso \(expected) ricevuto \(received)")
        case .event(let e):
            apply(e)
        }
    }

    private func apply(_ e: AgentEvent) {
        // Eventi di un'altra conversazione (risposta in corso quando si è aperta «Nuova conversazione»): fuori.
        if e.sessionId != sessionId, e.sessionId != Self.noSession { return }
        lastSeq = max(lastSeq, e.seq)
        if e.correlationId == activeCorrelationId { turnActivityAt = .now }
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
            items.append(.confirmation(ConfirmationCard(approvalId: p.approvalId, correlationId: e.correlationId, toolId: p.toolId, displayName: p.displayName, argsPreview: p.argsPreview, reason: p.reason, expiresAt: p.expiresAt, allowAlways: p.allowAlways)))
            persist()
        case .toolConfirmationResolved(let p):
            update(confirmation: p.approvalId) { $0.decision = p.decision }
        case .assistantBlock(let p):
            // Messaggio in famiglia: un fumetto suo nella conversazione, non dentro la risposta di Ernie.
            if case .familyMessage(let f) = p.block {
                addFamily(f)
                break
            }
            onBlock?(p.block)
            if case .unknown = p.block { break }
            upsertAssistant(for: e.correlationId) { m in
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

    /// Messaggio in famiglia (ricevuto o mandato): una volta sola per id, in fondo alla conversazione.
    func addFamily(_ m: FamilyMessageBlock) {
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
        if items.count > 400 { items.removeFirst(items.count - 400) }
        transcript.save(.init(sessionId: sessionId, lastSeq: lastSeq, items: items, updatedAt: .now))
    }
}
