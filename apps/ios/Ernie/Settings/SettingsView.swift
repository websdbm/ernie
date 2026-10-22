import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var killSwitch = false
    @State private var confirmSignOut = false
    @State private var busy = false
    @State private var message: String?

    @State private var email = ""
    @State private var emailNotifications = false
    @State private var emailError: String?
    @State private var showChangeServer = false
    @State private var alarmReminders = ReminderAlarms.enabled
    @State private var useLocation = DeviceContextProvider.locationEnabled
    @State private var previewingVoice = false

    // Gate della proattività (M9 A3): messaggi spontanei, ore di quiete, tetto giornaliero.
    @State private var proactive = true
    @State private var quietOn = true
    @State private var quietStart = SettingsView.time("22:00")
    @State private var quietEnd = SettingsView.time("07:30")
    @State private var dailyCap = 4
    @State private var proactiveError: String?
    /// Evita che il caricamento iniziale (che imposta i selettori) salvi di nuovo le impostazioni.
    @State private var proactiveLoaded = false

    static func styleTitle(_ id: String?) -> String {
        switch id {
        case "scherzoso": "Scherzoso"
        case "essenziale": "Essenziale"
        case "antico": "Antico"
        default: "Neutro"
        }
    }

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
                Section {
                    NavigationLink {
                        ProfileView()
                    } label: {
                        Label("La tua scheda", systemImage: "person.text.rectangle")
                    }
                } footer: {
                    Text("Nome, come vuoi essere chiamato, compleanno, famiglia: Ernie la compila mentre parlate e puoi correggerla.")
                }
                Section {
                    NavigationLink {
                        StyleView()
                    } label: {
                        LabeledContent {
                            Text(Self.styleTitle(model.profile?.settings["conversationStyle"]?.stringValue))
                        } label: {
                            Label("Come parla Ernie", systemImage: "text.quote")
                        }
                    }
                } footer: {
                    Text("Lo stile (neutro, scherzoso, essenziale, antico) e le parole che Ernie impara da te.")
                }
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
                    Picker("Voce di Ernie", selection: Binding(
                        get: { model.settings.speechEngine },
                        set: { model.setSpeech(engine: $0) }
                    )) {
                        ForEach(SpeechEngine.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    if model.settings.speechEngine == .drama {
                        Picker("Interpretazione", selection: Binding(
                            get: { model.settings.speechStyle },
                            set: { model.setSpeech(style: $0) }
                        )) {
                            ForEach(SpeechStyle.allCases, id: \.self) { Text($0.title).tag($0) }
                        }
                        Text("Una voce espressiva per Ernie. Richiede internet; se non disponibile, la frase viene letta dalla voce di iOS. L’interpretazione cambia il modo di parlare.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    SpeechVolumeControl()
                    Button {
                        if previewingVoice {
                            _ = model.speaker.stop()
                            previewingVoice = false
                        } else {
                            model.speaker.beginTurn()
                            model.speaker.flush(fullText: "Ciao, sono Ernie. Sono qui per darti una mano, con un po’ di buonumore.")
                            previewingVoice = true
                        }
                    } label: {
                        Label(previewingVoice ? "Ferma l’esempio" : "Ascolta un esempio", systemImage: previewingVoice ? "stop.fill" : "play.fill")
                    }
                    .disabled(!previewingVoice && (model.conversation?.isBusy == true || model.voice?.isActive == true))
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
                    TextField("Email (anche nella tua scheda)", text: $email)
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
                    Text("È la stessa email della tua scheda anagrafica: cambiandola qui si aggiorna anche lì.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Promemoria come sveglia", isOn: Binding(
                        get: { alarmReminders },
                        set: { value in
                            alarmReminders = value
                            ReminderAlarms.enabled = value
                            model.reminders.sync()
                        }
                    ))
                    if alarmReminders, ReminderAlarms.authorization == .denied {
                        Text("Permesso sveglie negato: attivalo in Impostazioni › Ernie › Sveglie. Intanto arriva una notifica normale.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Text("Come sveglia, il promemoria suona anche con il telefono in silenzioso, con «Posticipa» di \(ReminderAlarmConfig.snoozeMinutes) minuti. Le notifiche arrivano comunque sul telefono (schermata di blocco e widget); l'email è un'aggiunta per quando il telefono non è a portata.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Toggle("Usa la mia posizione", isOn: Binding(
                        get: { useLocation },
                        set: { value in
                            useLocation = value
                            DeviceContextProvider.locationEnabled = value
                            if value { DeviceContextProvider.shared.start() } else { DeviceContextProvider.shared.forget() }
                        }
                    ))
                    if useLocation, [.denied, .restricted].contains(DeviceContextProvider.shared.authorization) {
                        Button("Permesso negato: apri le Impostazioni di iOS") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                        .font(.caption)
                    }
                } header: {
                    Text("Posizione")
                } footer: {
                    Text("Ernie riceve l'ora del telefono e, se lo consenti, la città e una posizione approssimata (circa 1 km), solo mentre usi l'app. Servono per meteo, luoghi vicini e orari. Non finiscono nella cronologia né nella memoria.")
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
                Section("Preferenze operative") {
                    NavigationLink("Come lavora Ernie") { OperatingPreferencesView() }
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
                    Button("Esci", role: .destructive) { confirmSignOut = true }
                        .confirmationDialog("Uscire dall’account?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                            Button("Esci", role: .destructive) {
                                model.signOut()
                                dismiss()
                            }
                            Button("Annulla", role: .cancel) {}
                        } message: {
                            Text("Dal telefono si tolgono le conversazioni, i promemoria programmati e le sveglie di questo account. Per rientrare servirà di nuovo la chiave.")
                        }
                }
                if let message { Section { Text(message).font(.footnote).foregroundStyle(.secondary) } }
            }
            .navigationTitle("Impostazioni")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .sheet(isPresented: $showChangeServer) { ChangeServerView() }
            .onChange(of: model.speaker.isSpeaking) { _, speaking in
                if !speaking { previewingVoice = false }
            }
            .onDisappear {
                if previewingVoice { _ = model.speaker.stop(); previewingVoice = false }
            }
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
