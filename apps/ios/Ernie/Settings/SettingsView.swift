import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var killSwitch = false
    @State private var busy = false
    @State private var message: String?

    @State private var email = ""
    @State private var emailNotifications = false
    @State private var emailError: String?
    @State private var showChangeServer = false

    // Gate della proattività (M9 A3): messaggi spontanei, ore di quiete, tetto giornaliero.
    @State private var proactive = true
    @State private var quietOn = true
    @State private var quietStart = SettingsView.time("22:00")
    @State private var quietEnd = SettingsView.time("07:30")
    @State private var dailyCap = 4
    @State private var proactiveError: String?
    /// Evita che il caricamento iniziale (che imposta i selettori) salvi di nuovo le impostazioni.
    @State private var proactiveLoaded = false

    static func time(_ hhmm: String) -> Date {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        var c = DateComponents()
        c.hour = parts.first ?? 0
        c.minute = parts.count > 1 ? parts[1] : 0
        return Calendar.current.date(from: c) ?? .now
    }

    static func hhmm(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    private func loadProactive() {
        let s = model.profile?.settings
        proactive = s?["proactive"]?.boolValue ?? true
        if case .null? = s?["quietHours"] { quietOn = false } else {
            quietOn = true
            quietStart = Self.time(s?["quietHours"]?["start"]?.stringValue ?? "22:00")
            quietEnd = Self.time(s?["quietHours"]?["end"]?.stringValue ?? "07:30")
        }
        if let cap = s?["proactiveDailyCap"]?.intValue { dailyCap = cap }
    }

    private func saveProactive() async {
        guard proactiveLoaded, let api = model.api else { return }
        let quiet: JSONValue = quietOn
            ? .object(["start": .string(Self.hhmm(quietStart)), "end": .string(Self.hhmm(quietEnd))])
            : .null
        do {
            let settings = try await api.updateSettings([
                "proactive": .bool(proactive),
                "quietHours": quiet,
                "proactiveDailyCap": .number(Double(dailyCap)),
            ])
            model.applySettings(settings)
            proactiveError = nil
        } catch {
            proactiveError = AppModel.describe(error)
        }
    }

    private func loadEmail() {
        let s = model.profile?.settings
        email = s?["email"]?.stringValue ?? ""
        emailNotifications = s?["emailNotifications"]?.boolValue ?? false
    }

    private func saveEmail() async {
        guard let api = model.api else { return }
        let clean = email.trimmingCharacters(in: .whitespaces)
        do {
            let settings = try await api.updateSettings(["email": .string(clean), "emailNotifications": .bool(emailNotifications && !clean.isEmpty)])
            model.applySettings(settings)
            emailError = nil
        } catch {
            emailError = AppModel.describe(error)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Voce") {
                    Toggle("Risposte a voce", isOn: Binding(
                        get: { model.settings.voiceOutput },
                        set: { model.setVoiceOutput($0) }
                    ))
                    Toggle("Leggi a voce anche le risposte scritte", isOn: Binding(
                        get: { model.settings.speakTextReplies },
                        set: { value in
                            model.settings.speakTextReplies = value
                            model.settings.save()
                            model.conversation?.settings = model.settings
                        }
                    ))
                    .disabled(!model.settings.voiceOutput)
                    Toggle("Conversazione continua", isOn: Binding(
                        get: { model.settings.continuousVoice },
                        set: { value in
                            model.settings.continuousVoice = value
                            model.settings.save()
                            model.conversation?.settings = model.settings
                        }
                    ))
                    Text("Un tocco sul microfono apre un dialogo a mani libere: la frase parte da sola quando fai una pausa, Ernie risponde e torna ad ascoltarti; ✕ chiude. Senza questa opzione, tieni il microfono premuto a lungo per lo stesso effetto una volta sola.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("Voce", value: model.speaker.voiceDescription)
                }
                Section {
                    Toggle("Interruttore di emergenza", isOn: $killSwitch)
                        .disabled(busy)
                        .onChange(of: killSwitch) { _, value in
                            guard value != model.profile?.killSwitch else { return }
                            Task { await toggleKillSwitch(value) }
                        }
                } header: {
                    Text("Sicurezza")
                } footer: {
                    Text("Con l'interruttore attivo le automazioni non vengono eseguite finché non lo disattivi. La modifica richiede Face ID o il codice.")
                }
                Section("Notifiche") {
                    TextField("Email per i promemoria", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await saveEmail() } }
                    Toggle("Promemoria e notifiche anche via email", isOn: Binding(
                        get: { emailNotifications },
                        set: { value in emailNotifications = value; Task { await saveEmail() } }
                    ))
                    .disabled(email.trimmingCharacters(in: .whitespaces).isEmpty)
                    if let emailError { Text(emailError).font(.caption).foregroundStyle(.red) }
                    Text("Le notifiche arrivano sempre sul telefono (schermata di blocco e widget); l'email è un'aggiunta per quando il telefono non è a portata.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Toggle("Messaggi di Ernie di sua iniziativa", isOn: Binding(
                        get: { proactive },
                        set: { proactive = $0; Task { await saveProactive() } }
                    ))
                    if proactive {
                        Toggle("Ore di silenzio", isOn: Binding(
                            get: { quietOn },
                            set: { quietOn = $0; Task { await saveProactive() } }
                        ))
                        if quietOn {
                            DatePicker("Dalle", selection: $quietStart, displayedComponents: .hourAndMinute)
                                .onChange(of: quietStart) { Task { await saveProactive() } }
                            DatePicker("Alle", selection: $quietEnd, displayedComponents: .hourAndMinute)
                                .onChange(of: quietEnd) { Task { await saveProactive() } }
                        }
                        Stepper("Al massimo \(dailyCap) al giorno", value: $dailyCap, in: 0...10)
                            .onChange(of: dailyCap) { Task { await saveProactive() } }
                    }
                    if let proactiveError { Text(proactiveError).font(.caption).foregroundStyle(.red) }
                } header: {
                    Text("Proattività")
                } footer: {
                    Text("Ernie ti scrive per primo solo per motivi precisi (una conferma che sta per scadere, un promemoria messo da un familiare), mai nelle ore di silenzio: in quel caso aspetta. I promemoria che chiedi tu suonano sempre all'ora scelta.")
                }
                Section {
                    NavigationLink("Persone collegate e inviti") { FamilyView() }
                } header: {
                    Text("Famiglia")
                } footer: {
                    Text("Collega l'installazione di un familiare: potrai dire «ricorda a Giorgio di …» e il promemoria arriverà sul suo telefono.")
                }
                Section("Skill") {
                    NavigationLink("Scegli le skill disponibili") { SkillsView(mode: .available) }
                }
                Section {
                    NavigationLink("Azioni consentite sempre") { SecurityView() }
                } header: {
                    Text("Conferme")
                } footer: {
                    Text("Le azioni per cui hai scelto «Consenti sempre». Gli invii verso l'esterno chiedono sempre conferma.")
                }
                Section("Diagnostica") {
                    NavigationLink("Latenza, voce e spike") { DiagnosticsView() }
                }
                Section("Account") {
                    LabeledContent("Server", value: model.credentials?.serverURL.host() ?? "—")
                    Button("Cambia server") { showChangeServer = true }
                    LabeledContent("Companion", value: model.companionName)
                    LabeledContent("Ruolo", value: model.profile?.role ?? "—")
                    if let v = model.profile?.server?.version { LabeledContent("Versione server", value: v) }
                    LabeledContent("Versione app", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                    Button("Esci", role: .destructive) {
                        model.signOut()
                        dismiss()
                    }
                }
                if let message { Section { Text(message).font(.footnote).foregroundStyle(.secondary) } }
            }
            .navigationTitle("Impostazioni")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .sheet(isPresented: $showChangeServer) { ChangeServerView() }
            .task {
                await model.refreshProfile()
                killSwitch = model.profile?.killSwitch ?? false
                loadEmail()
                loadProactive()
                try? await Task.sleep(for: .milliseconds(300))
                proactiveLoaded = true
            }
        }
    }

    private func toggleKillSwitch(_ value: Bool) async {
        busy = true
        defer { busy = false }
        guard await StepUp.authenticate(reason: value ? "Sospendi le automazioni" : "Riattiva le automazioni") else {
            killSwitch = !value
            return
        }
        if await model.setKillSwitch(value) {
            message = value ? "Automazioni sospese." : "Automazioni riattivate."
        } else {
            killSwitch = !value
            message = "Modifica non riuscita."
        }
    }
}
