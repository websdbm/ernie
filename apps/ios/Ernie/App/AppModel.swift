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
    var settings = LocalSettings.load()

    var api: ApiClient? { credentials.map { ApiClient(credentials: $0) } }
    var companionName: String { profile?.companionName ?? "Ernie" }

    func start() async {
        if let saved = Credentials.load() {
            await activate(saved)
            return
        }
        #if DEBUG
        // Accesso automatico per i test (simulatore): SIMCTL_CHILD_ERNIE_API_KEY=… xcrun simctl launch … com.websdbm.ernie
        let env = ProcessInfo.processInfo.environment
        if let key = env["ERNIE_API_KEY"], let url = URL(string: env["ERNIE_SERVER_URL"] ?? "http://localhost:3000") {
            _ = await signIn(serverURL: url, apiKey: key)
        }
        #endif
    }

    /// Verifica le credenziali su `/v1/me`, le salva nel Keychain e avvia la conversazione.
    func signIn(serverURL: URL, apiKey: String) async -> Bool {
        signInError = nil
        let candidate = Credentials(serverURL: serverURL, apiKey: apiKey)
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

    // MARK: - privato

    private func activate(_ creds: Credentials) async {
        credentials = creds
        let api = ApiClient(credentials: creds)
        if profile == nil { profile = try? await api.me() }
        inbox.configure(api: api)
        let store = ConversationStore(credentials: creds, speaker: speaker, inbox: inbox, settings: settings)
        conversation = store
        voice = VoiceController(conversation: store, speaker: speaker)
        store.connect()
        await inbox.refresh()
        await requestPushAuthorization()
        #if DEBUG
        // Test automatici: invia un messaggio appena connesso (SIMCTL_CHILD_ERNIE_DEBUG_SEND="…").
        if let text = ProcessInfo.processInfo.environment["ERNIE_DEBUG_SEND"], !text.isEmpty {
            for _ in 0..<50 where store.connection != .connected {
                try? await Task.sleep(for: .milliseconds(100))
            }
            store.send(text, inputMode: "text")
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

/// Preferenze locali (non segrete): lettura vocale delle risposte scritte, URL del server mostrato nelle impostazioni.
struct LocalSettings: Codable, Sendable, Equatable {
    var speakTextReplies = false

    static let key = "ernie.localSettings"

    static func load() -> LocalSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(LocalSettings.self, from: data) else { return LocalSettings() }
        return s
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
