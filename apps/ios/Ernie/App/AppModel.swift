import Foundation
import Observation
import UIKit
import UserNotifications

/// Stato radice: credenziali, profilo, conversazione, voce, notifiche. Una sola conversazione attiva per volta.
@MainActor
@Observable
final class AppModel {
    private(set) var credentials: Credentials?
    private(set) var profile: Profile?
    private(set) var signInError: String?
    private(set) var conversation: ConversationStore?
    private(set) var voice: VoiceController?
    let inbox = InboxStore()
    let speaker = Speaker()
    /// Allegato in preparazione (skill «Documenti»): lettura sul telefono e caricamento del testo.
    let documents = DocumentComposer()
    /// Liste della spesa mostrate nelle schede (spunta, aggiungi, togli via REST).
    let shopping = ShoppingStore()
    /// Promemoria («Ricordami»): copia dei prossimi, notifiche locali, istantanea per il widget.
    let reminders = ReminderStore()
    var settings = LocalSettings.load()
    /// Coda delle condivisioni in elaborazione: una passata alla volta.
    @ObservationIgnored private var isProcessingShares = false

    var api: ApiClient? { credentials.map { ApiClient(credentials: $0) } }
    var companionName: String { profile?.companionName ?? "Ernie" }

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
        let candidate = Credentials(
            serverURL: serverURL,
            apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        do {
            let me = try await ApiClient(credentials: candidate).me()
            try candidate.save()
            profile = me
            await activate(candidate)
            return true
        } catch {
            signInError = Self.describe(error)
            return false
        }
    }

    /// Cambia solo l'indirizzo del server tenendo la chiave: verifica, salva e ricollega la conversazione.
    func changeServer(to url: URL) async -> Bool {
        guard let current = credentials else { return false }
        conversation?.disconnect()
        let ok = await signIn(serverURL: url, apiKey: current.apiKey)
        if !ok { await activate(current) }
        return ok
    }

    func signOut() {
        conversation?.disconnect()
        conversation = nil
        voice = nil
        profile = nil
        Credentials.clear()
        credentials = nil
        inbox.reset()
    }

    func newConversation() {
        conversation?.startNewSession()
    }

    /// Voce accesa/spenta: vale subito; spegnendola, se Ernie sta parlando, si zittisce senza interrompere il turno.
    func setVoiceOutput(_ on: Bool) {
        settings.voiceOutput = on
        settings.save()
        conversation?.settings = settings
        if !on { conversation?.muteSpeech() }
    }

    /// Impostazioni aggiornate dal server (PATCH /v1/me/settings).
    func applySettings(_ settings: [String: JSONValue]) {
        profile = profile?.with(settings: settings)
    }

    func refreshProfile() async {
        guard let api else { return }
        if let me = try? await api.me() { profile = me }
    }

    func setKillSwitch(_ on: Bool) async -> Bool {
        guard let api else { return false }
        do {
            let settings = try await api.updateSettings(["killSwitch": .bool(on)])
            profile = profile?.with(settings: settings)
            return true
        } catch {
            return false
        }
    }

    func registerDevice(token: String) async {
        guard let api else { return }
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif
        do {
            try await api.registerDevice(token: token, environment: environment)
            Log.push.info("dispositivo registrato per le notifiche push")
        } catch {
            Log.push.warning("registrazione dispositivo fallita: \(Self.describe(error), privacy: .public)")
        }
    }

    // MARK: - condivisioni

    /// Elabora la coda del foglio «Condividi con Ernie»: link e testi vanno al server; al più un'immagine o un PDF
    /// per volta entra nel documento della barra di scrittura, con la richiesta già pronta da inviare.
    /// Gli elementi non riusciti restano in coda per la prossima apertura.
    func processShareInbox() async {
        guard !isProcessingShares, let credentials, let conversation else { return }
        isProcessingShares = true
        defer { isProcessingShares = false }
        var startedDocument = false
        for item in ShareInbox.pending() {
            switch item.kind {
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
                let images = urls.compactMap { UIImage(contentsOfFile: $0.path) }
                guard !images.isEmpty else {
                    ShareInbox.remove(item)
                    continue
                }
                documents.importImages(images, source: "photo")
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
        guard await documentReady() else { return }
        ShareInbox.remove(item)
        let request = "Metti questo documento nel second brain"
        conversation.composerSuggestion = note.map { "\(request): \($0)" } ?? request
    }

    /// Aspetta che il documento in lettura sia pronto (`true`) o fallito/annullato (`false`); al massimo dieci minuti.
    private func documentReady() async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(600))
        while ContinuousClock.now < deadline {
            switch documents.phase {
            case .ready: return true
            case .failed, .idle: return false
            case .reading, .uploading: try? await Task.sleep(for: .milliseconds(200))
            }
        }
        return false
    }

    // MARK: - privato

    private func activate(_ creds: Credentials) async {
        credentials = creds
        let api = ApiClient(credentials: creds)
        if profile == nil { profile = try? await api.me() }
        inbox.configure(api: api)
        let store = ConversationStore(credentials: creds, speaker: speaker, inbox: inbox, settings: settings)
        conversation = store
        voice = VoiceController(conversation: store, speaker: speaker)
        documents.configure(api: api)
        shopping.configure(api: api)
        reminders.configure(api: api)
        store.onBlock = { [shopping, reminders] block in
            shopping.apply(block)
            reminders.apply(block)
        }
        Task { await self.reminders.refresh() }
        // Modello vocale italiano scaricato in anticipo: il primo tocco sul microfono non deve aspettare.
        Task { await self.voice?.prewarm() }
        store.connect()
        await inbox.refresh()
        await requestPushAuthorization()
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

    static func describe(_ error: Error) -> String {
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
