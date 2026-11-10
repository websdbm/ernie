import Foundation
import Observation
import UIKit
import UserNotifications
import WidgetKit

/// Stato radice: una conversazione visibile, fino a tre compiti con sessioni indipendenti.
@MainActor
@Observable
final class AppModel {
    private var lifecycle = UUID()
    private var signInAttempt = UUID()
    private var pushToken = UserDefaults.standard.string(forKey: "ernie.apnsToken")
    private var deviceOperation: Task<Void, Never>?
    private(set) var credentials: Credentials?
    private(set) var profile: Profile?
    private(set) var signInError: String?
    private(set) var conversation: ConversationStore?
    private(set) var voice: VoiceController?
    let inbox = InboxStore()
    let habits = HabitsStore()
    /// Messaggi urgenti da confermare («super snooze»): a tutto schermo finché non si conferma.
    let urgent = FamilyUrgentStore()
    private(set) var speaker = Speaker()
    private(set) var concurrentTasks: [ConcurrentTask] = []
    private(set) var pendingTaskInput: PendingTaskInput?
    private(set) var resolvingTask = false
    private(set) var taskNotice: String?
    private var queuedTaskInputs: [PendingTaskInput] = []
    private var taskResolution: Task<Void, Never>?
    private var connectTaskTransports = true
    private var taskTranscript: TranscriptStore?
    private var taskIntentResolver: ((TaskIntentRequest) async throws -> TaskIntentDecision)?
    private var protectedTaskIDs: Set<String> {
        Set((pendingTaskInput.map { [$0.sourceId] } ?? []) + queuedTaskInputs.map(\.sourceId))
    }
    var canStartParallelTask: Bool {
        concurrentTasks.filter(\.isRunning).count < 3 && (concurrentTasks.count < 3 ||
            concurrentTasks.contains { !$0.isRunning && !protectedTaskIDs.contains($0.id) })
    }
    /// Allegato in preparazione (skill «Documenti»): lettura sul telefono e caricamento del testo.
    let documents = DocumentComposer()
    let mediaUploads = MediaUploadQueue.shared
    let mediaImports = MediaImportCoordinator()
    /// Liste della spesa mostrate nelle schede (spunta, aggiungi, togli via REST).
    let todoStore = TodoStore()
    let sshStore = SSHStore()
    let shopping = ShoppingStore()
    /// Promemoria («Ricordami»): copia dei prossimi, notifiche locali, istantanea per il widget.
    let reminders = ReminderStore()
    var settings = LocalSettings.load()
    /// Destinazione richiesta dal widget, conservata fino a quando la navigazione è pronta.
    var pendingLink: AppLink?
    var pendingChatArchiveImport: PendingChatArchiveImport?
    /// Coda delle condivisioni in elaborazione: una passata alla volta.
    @ObservationIgnored private var isProcessingShares = false

    var api: ApiClient? { credentials.map { ApiClient(credentials: $0) } }
    var companionName: String { profile?.companionName ?? "Ernie" }

    init() {}

    #if DEBUG
    /// Offline integration tests exercise the same coordinator without live accounts or sockets.
    init(testTasks: [ConcurrentTask], credentials: Credentials, transcript: TranscriptStore,
         resolver: @escaping (TaskIntentRequest) async throws -> TaskIntentDecision) {
        self.credentials = credentials
        self.concurrentTasks = testTasks
        self.taskIntentResolver = resolver
        self.connectTaskTransports = false
        self.taskTranscript = transcript
        inbox.onCards = { [weak self] cards in self?.conversation?.receiveNotifications(cards) }
        for task in testTasks { wireTask(task.conversation) }
        if let first = testTasks.first { selectTask(first.id) }
    }
    #endif

    func start() async {
        #if DEBUG
        // Accesso automatico per i test (simulatore): SIMCTL_CHILD_ERNIE_API_KEY=… [SIMCTL_CHILD_ERNIE_SERVER_URL=…]
        // xcrun simctl launch … com.websdbm.ernie. Ha la precedenza sulle credenziali salvate (il Keychain del
        // simulatore sopravvive alla reinstallazione dell'app).
        let env = ProcessInfo.processInfo.environment
        if let key = env["ERNIE_API_KEY"], let url = URL(string: env["ERNIE_SERVER_URL"] ?? "http://localhost:3000") {
            if await signIn(serverURL: url, apiKey: key) { return }
        }
        #endif
        if let saved = Credentials.load() {
            await activate(saved)
        }
    }

    /// Verifica le credenziali su `/v1/me`, le salva nel Keychain e avvia la conversazione.
    func signIn(serverURL: URL, apiKey: String) async -> Bool {
        signInError = nil
        pendingChatArchiveImport = nil
        let attempt = UUID()
        signInAttempt = attempt
        let candidate = Credentials(
            serverURL: serverURL,
            apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        do {
            let me = try await ApiClient(credentials: candidate).me()
            guard signInAttempt == attempt, !Task.isCancelled else { return false }
            try candidate.save()
            profile = me
            await activate(candidate)
            return true
        } catch {
            guard signInAttempt == attempt, !Task.isCancelled else { return false }
            signInError = Self.describe(error)
            return false
        }
    }

    /// Cambia solo l'indirizzo del server tenendo la chiave: verifica, salva e ricollega la conversazione.
    func changeServer(to url: URL) async -> Bool {
        guard let current = credentials else { return false }
        return await signIn(serverURL: url, apiKey: current.apiKey)
    }

    func signOut() {
        // Cattura l’API prima di cancellare le credenziali; la rete non blocca mai l’uscita.
        if let api, let token = pushToken {
            let previous = deviceOperation
            deviceOperation = Task {
                await previous?.value
                try? await api.unregisterDevice(token: token)
            }
        }
        lifecycle = UUID()
        signInAttempt = UUID()
        voice?.cancelListening()
        stopTaskWorkspaces()
        conversation = nil
        voice = nil
        profile = nil
        pendingChatArchiveImport = nil
        Credentials.clear()
        credentials = nil
        speaker.configure(credentials: nil, engine: settings.speechEngine, style: settings.speechStyle)
        inbox.reset()
        documents.configure(api: nil)
        todoStore.configure(api: nil)
        sshStore.configure(api: nil)
        shopping.configure(api: nil)
        reminders.configure(api: nil)
        resetLocalState()
        mediaUploads.configure(nil)
    }

    /// All'uscita non resta niente dell'account sul telefono (revisione del 16 ott 2026: le sveglie suonavano ancora,
    /// chi entrava dopo vedeva le chat precedenti e un urgente del vecchio account non si chiudeva più).
    private func resetLocalState() {
        habits.deactivate()
        UserDefaults.standard.removeObject(forKey: "ernie.parallelSessions")
        PendingTaskInput.clearSaved()
        mediaImports.reset()
        TranscriptStore().clearAll()
        let center = UNUserNotificationCenter.current()
        center.removeAllPendingNotificationRequests()
        center.removeAllDeliveredNotifications()
        ReminderAlarms.cancelAll()
        reminders.clear()
        urgent.clearAll()
        ReminderSnapshot(items: [], updatedAt: .now).save()
        FamilyLatest.clear()
        FamilyImageCache.clear()
        MediaImageCache.clear()
        FamilyMessageSync.pendingRead = []
        if let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ReminderSnapshot.appGroup) {
            try? FileManager.default.removeItem(at: group.appendingPathComponent(WidgetSummaryCache.fileName))
        }
        UserDefaults.standard.removeObject(forKey: "family.messages.lastSeen")
        WidgetCenter.shared.reloadAllTimelines()
    }

    func newConversation() {
        guard let task = makeTask(sessionId: Ids.new()) else {
            taskNotice = pendingTaskInput == nil
                ? "Ci sono già tre compiti in corso. Aprine uno per seguirlo o fermarlo."
                : "Scegli prima dove aggiungere la richiesta in attesa."
            return
        }
        selectTask(task.id)
    }

    func resumeConversation(_ id: String) {
        if concurrentTasks.contains(where: { $0.id == id }) { selectTask(id); return }
        guard let task = makeTask(sessionId: id) else {
            taskNotice = "Prima termina un compito o assegna la richiesta in attesa, poi riapri questa conversazione."
            return
        }
        selectTask(task.id)
    }

    func canDeleteConversation(_ id: String) -> Bool {
        id != conversation?.sessionId && !protectedTaskIDs.contains(id) &&
            !concurrentTasks.contains { $0.id == id && $0.isRunning }
    }

    @discardableResult func deleteConversation(_ id: String) -> Bool {
        guard canDeleteConversation(id) else { return false }
        if let index = concurrentTasks.firstIndex(where: { $0.id == id }) {
            concurrentTasks[index].voice.cancelListening()
            concurrentTasks[index].conversation.disconnect()
            concurrentTasks.remove(at: index)
            rememberTaskSessions()
        }
        conversation?.deleteSession(id)
        return true
    }

    func selectTask(_ id: String) {
        guard let task = concurrentTasks.first(where: { $0.id == id }) else { return }
        if conversation !== task.conversation {
            voice?.cancelListening()
            conversation?.setForeground(false)
        }
        conversation = task.conversation
        voice = task.voice
        speaker = task.speaker
        task.conversation.settings = settings
        task.speaker.configure(credentials: credentials, engine: settings.speechEngine, style: settings.speechStyle)
        task.conversation.setForeground(true)
        taskNotice = nil
        rememberTaskSessions()
    }

    private func rememberTaskSessions() {
        UserDefaults.standard.set(concurrentTasks.map(\.id), forKey: "ernie.parallelSessions")
    }

    private func stopTaskWorkspaces() {
        taskResolution?.cancel(); taskResolution = nil
        pendingTaskInput = nil; queuedTaskInputs = []; resolvingTask = false
        for task in concurrentTasks { task.voice.cancelListening(); task.conversation.disconnect() }
        concurrentTasks = []
        conversation?.disconnect()
    }

    @discardableResult private func makeTask(sessionId: String) -> ConcurrentTask? {
        guard let creds = credentials, canStartParallelTask else { return nil }
        if concurrentTasks.count >= 3,
           let disposable = concurrentTasks.firstIndex(where: { !$0.isRunning && !protectedTaskIDs.contains($0.id) && $0.id != conversation?.sessionId })
            ?? concurrentTasks.firstIndex(where: { !$0.isRunning && !protectedTaskIDs.contains($0.id) }) {
            concurrentTasks[disposable].voice.cancelListening()
            concurrentTasks[disposable].conversation.disconnect()
            concurrentTasks.remove(at: disposable)
        }
        let taskSpeaker = Speaker()
        taskSpeaker.configure(credentials: creds, engine: settings.speechEngine, style: settings.speechStyle)
        let store = ConversationStore(credentials: creds, speaker: taskSpeaker, inbox: inbox,
                                      settings: settings, transcript: taskTranscript ?? TranscriptStore(),
                                      initialSessionId: sessionId, observeInbox: false)
        store.setForeground(false)
        wireTask(store)
        let task = ConcurrentTask(conversation: store, speaker: taskSpeaker,
                                  voice: VoiceController(conversation: store, speaker: taskSpeaker))
        concurrentTasks.append(task)
        if connectTaskTransports { store.connect() }
        rememberTaskSessions()
        return task
    }

    private func wireTask(_ store: ConversationStore) {
        store.onConcurrentInput = { [weak self, weak store] text, mode, attachments in
            guard let self, let store else { return }
            self.acceptTaskInput(.init(sourceId: store.sessionId, text: text, inputMode: mode, attachments: attachments))
        }
        store.onFeedback = { [weak store] sound, key in
            if store?.isForeground == true { ErnieSoundPlayer.shared.play(sound, key: key) }
        }
        store.onFamilyMessage = { [urgent] m in urgent.note(m) }
        store.onBlock = { [shopping, reminders, todoStore] block in
            if case .todoList(let b) = block { todoStore.apply(b.list); Task { await reminders.refresh() } }
            shopping.apply(block); reminders.apply(block)
        }
    }

    private func acceptTaskInput(_ input: PendingTaskInput) {
        voice?.cancelListening()
        if pendingTaskInput != nil { queuedTaskInputs.append(input); saveTaskInputs(); return }
        pendingTaskInput = input
        saveTaskInputs()
        let candidates = concurrentTasks.filter(\.isRunning).map {
            TaskIntentRequest.Candidate(id: $0.id, title: String($0.conversation.activeTaskTitle.prefix(1000)))
        }
        let snapshot = Dictionary(uniqueKeysWithValues: concurrentTasks.compactMap { task in
            task.conversation.activeCorrelationId.map { (task.id, $0) }
        })
        guard !candidates.isEmpty else { resolvePendingTask(targetId: input.sourceId); return }
        guard input.attachments.isEmpty, input.text.count <= 4000, let api else { return }
        resolvingTask = true
        let token = lifecycle
        let resolve = taskIntentResolver ?? { request in try await api.resolveTask(request) }
        taskResolution = Task { [weak self] in
            let decision = try? await resolve(.init(text: input.text, tasks: candidates))
            guard let self, !Task.isCancelled, self.lifecycle == token, self.pendingTaskInput?.id == input.id else { return }
            self.resolvingTask = false
            let current = Dictionary(uniqueKeysWithValues: self.concurrentTasks.compactMap { task in
                task.conversation.activeCorrelationId.map { (task.id, $0) }
            })
            guard current == snapshot else { return } // A result may only route the exact turns it classified.
            if let target = decision?.destination(in: candidates) { self.resolvePendingTask(targetId: target) }
            else if decision?.isIndependent == true, self.canStartParallelTask { self.resolvePendingTaskAsNew() }
            // Timeout, unsupported backend, doubtful intent or full capacity: visible choices remain.
        }
    }

    private func saveTaskInputs() {
        guard let credentials else { return }
        PendingTaskInput.save((pendingTaskInput.map { [$0] } ?? []) + queuedTaskInputs,
                              owner: ErnieTRIXSession.storageID(for: credentials))
    }

    private func consumeTaskInput() -> PendingTaskInput? {
        taskResolution?.cancel(); taskResolution = nil; resolvingTask = false
        let input = pendingTaskInput; pendingTaskInput = nil
        saveTaskInputs()
        return input
    }

    private func nextTaskInput() {
        if !queuedTaskInputs.isEmpty { let next = queuedTaskInputs.removeFirst(); acceptTaskInput(next) }
    }

    func resolvePendingTask(targetId: String) {
        guard let task = concurrentTasks.first(where: { $0.id == targetId }), let input = consumeTaskInput() else { return }
        selectTask(targetId)
        task.conversation.send(input.text, inputMode: input.inputMode, attachments: input.attachments, resolveConcurrent: false)
        nextTaskInput()
    }

    func resolvePendingTaskAsNew() {
        guard let pending = pendingTaskInput, let task = makeTask(sessionId: Ids.new()) else { return }
        _ = consumeTaskInput()
        selectTask(task.id)
        task.conversation.send(pending.text, inputMode: pending.inputMode, attachments: pending.attachments, resolveConcurrent: false)
        nextTaskInput()
    }

    func queuePendingTask() {
        guard let pending = pendingTaskInput,
              let task = concurrentTasks.first(where: { $0.id == pending.sourceId }),
              let input = consumeTaskInput() else { return }
        task.conversation.send(input.text, inputMode: input.inputMode, attachments: input.attachments,
                               resolveConcurrent: false, asNewTurn: true)
        nextTaskInput()
    }

    func editPendingTask() {
        guard let pending = pendingTaskInput, concurrentTasks.contains(where: { $0.id == pending.sourceId }) else { return }
        guard let input = consumeTaskInput() else { return }
        selectTask(input.sourceId)
        conversation?.composerSuggestion = input.text
        nextTaskInput()
    }

    /// Voce accesa/spenta: vale subito; spegnendola, se Ernie sta parlando, si zittisce senza interrompere il turno.
    func setVoiceOutput(_ on: Bool) {
        settings.voiceOutput = on
        settings.save()
        for task in concurrentTasks { task.conversation.settings = settings }
        if !on { conversation?.muteSpeech() }
    }

    func setSpeech(engine: SpeechEngine? = nil, style: SpeechStyle? = nil) {
        conversation?.muteSpeech()
        if let engine { settings.speechEngine = engine }
        if let style { settings.speechStyle = style }
        settings.save()
        conversation?.settings = settings
        speaker.configure(credentials: credentials, engine: settings.speechEngine, style: settings.speechStyle)
    }

    /// Impostazioni aggiornate dal server (PATCH /v1/me/settings).
    func applySettings(_ settings: [String: JSONValue]) {
        profile = profile?.with(settings: settings)
    }

    func refreshProfile() async {
        guard let api else { return }
        let token = lifecycle
        if let me = try? await api.me(), lifecycle == token, !Task.isCancelled { profile = me }
    }

    func setKillSwitch(_ on: Bool) async -> Bool {
        guard let api else { return false }
        let token = lifecycle
        do {
            let settings = try await api.updateSettings(["killSwitch": .bool(on)])
            guard lifecycle == token, !Task.isCancelled else { return false }
            profile = profile?.with(settings: settings)
            return true
        } catch {
            return false
        }
    }

    func registerDevice(token: String) async {
        pushToken = token
        UserDefaults.standard.set(token, forKey: "ernie.apnsToken")
        guard let api else { return }
        let generation = lifecycle
        let previous = deviceOperation
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        let operation = Task {
            await previous?.value
            guard lifecycle == generation else { return }
            do {
                try await api.registerDevice(token: token, environment: environment)
                Log.push.info("dispositivo registrato per le notifiche push")
            } catch {
                Log.push.warning("registrazione dispositivo fallita: \(Self.describe(error), privacy: .public)")
            }
        }
        deviceOperation = operation
        await operation.value
    }

    // MARK: - condivisioni

    /// Elabora la coda del foglio «Condividi con Ernie»: link e testi vanno al server; al più un'immagine o un PDF
    /// per volta entra nel documento della barra di scrittura, con la richiesta già pronta da inviare.
    /// Gli elementi non riusciti restano in coda per la prossima apertura.
    /// Messaggi in famiglia nuovi dal server (avvio, primo piano, notifica).
    /// `urgentId`: notifica di un urgente; se la sincronizzazione non lo porta (già visto in chat), lo si cerca.
    func syncFamilyMessages(urgentId: String? = nil) async {
        let token = lifecycle
        let currentAPI = api
        await FamilyMessageSync.sync(api: currentAPI, conversation: conversation)
        guard token == lifecycle, !Task.isCancelled else { return }
        if let urgentId, !urgent.pending.contains(where: { $0.id == urgentId }),
           let recent = try? await currentAPI?.familyMessages(since: nil, limit: 30),
           let m = recent.first(where: { $0.id == urgentId }), token == lifecycle, !Task.isCancelled {
            urgent.note(m)
        }
    }

    func processShareInbox() async {
        guard !isProcessingShares, let credentials, let conversation else { return }
        isProcessingShares = true
        defer { isProcessingShares = false }
        var startedDocument = false
        for item in ShareInbox.pending() {
            guard conversation.isAttached, !Task.isCancelled else { return }
            switch item.kind {
            case .chatArchive(let url, let owner):
                guard pendingChatArchiveImport == nil,
                      owner == ShareInbox.ownerScope(serverURL: credentials.serverURL, apiKey: credentials.apiKey) else { continue }
                pendingChatArchiveImport = PendingChatArchiveImport(id: item.id, url: url, owner: owner, item: item)

            case .link(let url, let title, let note):
                if await deliverShare(url: url, text: nil, title: title, note: note, credentials: credentials) {
                    ShareInbox.remove(item)
                }
            case .text(let text, let note):
                if await deliverShare(url: nil, text: text, title: nil, note: note, credentials: credentials) {
                    ShareInbox.remove(item)
                }
            case .images(let urls, let note):
                guard !startedDocument, !documents.isActive else { continue }
                startedDocument = true
                documents.importPhotos(count: urls.count, source: "photo") { index in
                    try MediaImportPhoto(data: Data(contentsOf: urls[index]))
                }
                await attachSharedDocument(item, note: note, conversation: conversation)
            case .pdf(let url, let note):
                guard !startedDocument, !documents.isActive else { continue }
                startedDocument = true
                documents.importPDF(url)
                await attachSharedDocument(item, note: note, conversation: conversation)
            }
        }
    }

    /// Invia link o testo: `true` se il server l'ha salvato (l'elemento va tolto dalla coda).
    private func deliverShare(url: URL?, text: String?, title: String?, note: String?, credentials: Credentials) async -> Bool {
        do {
            _ = try await ShareUpload.post(url: url, text: text, title: title, note: note,
                                           serverURL: credentials.serverURL, apiKey: credentials.apiKey)
            Log.app.info("condivisione salvata nel second brain")
            return true
        } catch {
            Log.app.warning("condivisione ancora in coda: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    /// Attende la lettura del documento condiviso; se è pronto lo lascia nella barra con la richiesta di metterlo
    /// nel second brain. Se la lettura fallisce l'elemento resta in coda.
    private func attachSharedDocument(_ item: ShareInbox.Item, note: String?, conversation: ConversationStore) async {
        guard await documentReady(), conversation.isAttached, !Task.isCancelled else { return }
        ShareInbox.remove(item)
        if documents.ready == nil {
            if let note { conversation.composerSuggestion = note }
            return
        }
        let request = "Metti questo documento nel second brain"
        conversation.composerSuggestion = note.map { "\(request): \($0)" } ?? request
    }

    /// Aspetta che il documento in lettura sia pronto (`true`) o fallito/annullato (`false`); al massimo dieci minuti.
    private func documentReady() async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(600))
        while ContinuousClock.now < deadline, !Task.isCancelled {
            switch documents.phase {
            case .ready, .mediaReady: return true
            case .failed, .idle: return false
            case .reading, .uploading: try? await Task.sleep(for: .milliseconds(200))
            }
        }
        return false
    }

    // MARK: - privato

    private func activate(_ creds: Credentials) async {
        lifecycle = UUID()
        let token = lifecycle
        voice?.cancelListening()
        stopTaskWorkspaces()
        if let old = credentials, old != creds { pendingChatArchiveImport = nil; resetLocalState() }
        credentials = creds
        mediaUploads.configure(creds)
        speaker.configure(credentials: creds, engine: settings.speechEngine, style: settings.speechStyle)
        let api = ApiClient(credentials: creds)
        if profile == nil {
            // A background visit launch must restore an existing device lease even before /me can respond.
            Task { [weak self] in
                guard let self, token == self.lifecycle else { return }
                await self.habits.activate(credentials: creds, userID: nil)
            }
            let fetched = try? await api.me()
            guard token == lifecycle, !Task.isCancelled else { return }
            profile = fetched
        }
        // Lo scope del diario si ricorda per queste credenziali: senza rete il diario locale si apre lo stesso.
        if let userID = profile?.userId { _ = DiaryIdentity.scope(for: creds, userID: userID) }
        Task { [weak self] in
            guard let self, token == self.lifecycle else { return }
            await self.habits.activate(credentials: creds, userID: self.profile?.userId)
        }
        inbox.configure(api: api)
        let store = ConversationStore(credentials: creds, speaker: speaker, inbox: inbox, settings: settings, observeInbox: false)
        inbox.onCards = { [weak self] cards in self?.conversation?.receiveNotifications(cards) }
        store.onFeedback = { sound, key in ErnieSoundPlayer.shared.play(sound, key: key) }
        store.onFamilyMessage = { [urgent] m in urgent.note(m) }
        conversation = store
        voice = VoiceController(conversation: store, speaker: speaker)
        wireTask(store)
        if let voice { concurrentTasks = [.init(conversation: store, speaker: speaker, voice: voice)] }
        let previousTasks = UserDefaults.standard.stringArray(forKey: "ernie.parallelSessions") ?? []
        let selectedID = store.sessionId
        for id in previousTasks.prefix(3) where id != selectedID { makeTask(sessionId: id) }
        selectTask(selectedID)
        let pendingInputs = PendingTaskInput.load(owner: ErnieTRIXSession.storageID(for: creds))
        if let first = pendingInputs.first {
            pendingTaskInput = first; queuedTaskInputs = Array(pendingInputs.dropFirst())
        }
        documents.configure(api: api)
        todoStore.configure(api: api)
        sshStore.configure(api: api)
        todoStore.onChanged = { [weak self] in await self?.reminders.refresh() }
        shopping.configure(api: api)
        shopping.onFeedback = { sound in ErnieSoundPlayer.shared.play(sound) }
        todoStore.onFeedback = { sound in ErnieSoundPlayer.shared.play(sound) }
        reminders.configure(api: api)
        store.onBlock = { [shopping, reminders, todoStore] block in
            if case .todoList(let b) = block {
                todoStore.apply(b.list)
                Task { await reminders.refresh() }
            }
            shopping.apply(block)
            reminders.apply(block)
        }
        Task { await self.reminders.refresh() }
        // Messaggi in famiglia arrivati mentre l'app era chiusa.
        Task { await self.syncFamilyMessages() }
        // Modello vocale italiano scaricato in anticipo: il primo tocco sul microfono non deve aspettare.
        Task { await self.voice?.prewarm() }
        store.connect()
        await inbox.refresh()
        guard token == lifecycle, !Task.isCancelled else { return }
        await requestPushAuthorization()
        guard token == lifecycle, !Task.isCancelled else { return }
        // Ora e posizione per il contesto dei turni: il permesso si chiede una volta, dopo quello delle notifiche.
        DeviceContextProvider.shared.start()
        // Condivisioni fatte dal foglio «Ernie» mentre l'app era chiusa o in secondo piano.
        Task { await self.processShareInbox() }
        #if DEBUG
        // Test automatici: invia un messaggio appena connesso (SIMCTL_CHILD_ERNIE_DEBUG_SEND="…").
        if let text = ProcessInfo.processInfo.environment["ERNIE_DEBUG_SEND"], !text.isEmpty {
            for _ in 0..<50 where store.connection != .connected {
                try? await Task.sleep(for: .milliseconds(100))
            }
            store.send(text, inputMode: "text")
        }
        // Test della skill «Documenti» nel simulatore: legge un PDF o un .txt dal percorso dato e lo invia.
        if let path = ProcessInfo.processInfo.environment["ERNIE_DEBUG_DOC"], !path.isEmpty {
            for _ in 0..<50 where store.connection != .connected {
                try? await Task.sleep(for: .milliseconds(100))
            }
            documents.importPDF(URL(fileURLWithPath: path))
            for _ in 0..<600 {
                if case .ready = documents.phase { break }
                if case .failed = documents.phase { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if let ref = documents.ready {
                documents.clear()
                store.send(ProcessInfo.processInfo.environment["ERNIE_DEBUG_DOC_TEXT"] ?? "", inputMode: "text", attachments: [ref])
            }
        }
        #endif
    }

    private func requestPushAuthorization() async {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        if status == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    nonisolated static func describe(_ error: Error) -> String {
        if let e = error as? ApiError { return e.message }
        return error.localizedDescription
    }
}

/// Preferenze locali (non segrete): voce accesa/spenta, lettura vocale delle risposte scritte.
struct LocalSettings: Codable, Sendable, Equatable {
    /// Interruttore della voce (pulsante in alto): spento, Ernie risponde solo per iscritto, anche alle domande dette a voce.
    var voiceOutput = true
    /// Con la voce accesa, legge anche le risposte alle domande scritte (non solo a quelle dette a voce).
    var speakTextReplies = false
    /// Conversazione continua (M8): un tocco sul microfono apre un dialogo a mani libere, finché non si tocca ✕.
    var continuousVoice = false
    var speechEngine: SpeechEngine = .drama
    var speechStyle: SpeechStyle = .warm
    /// Avatar galleggiante: dove è agganciato, quanto è grande, se è ridotto a badge o nascosto nella linguetta.
    var avatarAnchor: AvatarAnchor = .top
    var avatarSize: Double = 132
    var avatarCompact = false
    var avatarHidden = false
    /// Nuova interfaccia: l'orso sta nella capsula in alto durante la conversazione; acceso, torna l'avatar
    /// galleggiante di prima (trascinabile, ridimensionabile).
    var avatarFloating = false

    static let key = "ernie.localSettings"

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        voiceOutput = try c.decodeIfPresent(Bool.self, forKey: .voiceOutput) ?? true
        speakTextReplies = try c.decodeIfPresent(Bool.self, forKey: .speakTextReplies) ?? false
        continuousVoice = try c.decodeIfPresent(Bool.self, forKey: .continuousVoice) ?? false
        speechEngine = try c.decodeIfPresent(SpeechEngine.self, forKey: .speechEngine) ?? .drama
        speechStyle = try c.decodeIfPresent(SpeechStyle.self, forKey: .speechStyle) ?? .warm
        avatarAnchor = try c.decodeIfPresent(AvatarAnchor.self, forKey: .avatarAnchor) ?? .top
        avatarSize = try c.decodeIfPresent(Double.self, forKey: .avatarSize) ?? 132
        avatarCompact = try c.decodeIfPresent(Bool.self, forKey: .avatarCompact) ?? false
        avatarHidden = try c.decodeIfPresent(Bool.self, forKey: .avatarHidden) ?? false
        avatarFloating = try c.decodeIfPresent(Bool.self, forKey: .avatarFloating) ?? false
    }

    static func load() -> LocalSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(LocalSettings.self, from: data) else { return LocalSettings() }
        return s
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
