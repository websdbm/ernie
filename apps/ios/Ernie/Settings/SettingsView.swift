import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var killSwitch = false
    @State private var busy = false
    @State private var message: String?

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
                Section("Skill") {
                    NavigationLink("Accendi e spegni le skill") { SkillsView() }
                }
                Section("Diagnostica") {
                    NavigationLink("Latenza, voce e spike") { DiagnosticsView() }
                }
                Section("Account") {
                    LabeledContent("Server", value: model.credentials?.serverURL.host() ?? "—")
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
            .task {
                await model.refreshProfile()
                killSwitch = model.profile?.killSwitch ?? false
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
