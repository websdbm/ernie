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
                    NavigationLink("Persone collegate e inviti") { FamilyView() }
                } header: {
                    Text("Famiglia")
                } footer: {
                    Text("Collega l'installazione di un familiare: potrai dire «ricorda a Giorgio di …» e il promemoria arriverà sul suo telefono.")
                }
                Section("Skill") {
                    NavigationLink("Scegli le skill disponibili") { SkillsView(mode: .available) }
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
