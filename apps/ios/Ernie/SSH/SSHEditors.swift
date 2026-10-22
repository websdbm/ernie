import SwiftUI

struct SSHServerEditor: View {
    @Bindable var store: SSHStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft: SshServerInput
    init(store: SSHStore, input: SshServerInput) { self.store = store; _draft = State(initialValue: input) }
    private var connected: Bool { store.snapshot?.providers.contains { $0.provider == draft.provider && $0.connected } == true }
    private var valid: Bool {
        !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.name.count <= 200
        && draft.host.range(of: "^[a-zA-Z0-9:.\\-]{1,253}$", options: .regularExpression) != nil
        && draft.username.range(of: "^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$", options: .regularExpression) != nil
        && (1...65535).contains(draft.port)
    }
    var body: some View {
        NavigationStack {
            Form {
                if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                Section("Accesso SSH") {
                    TextField("Nome", text: $draft.name)
                    TextField("Hostname o IP", text: $draft.host).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Porta", value: $draft.port, format: .number.grouping(.never)).keyboardType(.numberPad)
                    TextField("Utente Linux", text: $draft.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Installa la pubblica Ernie in authorized_keys per questo utente. La password SSH non viene acquisita dall’app.").font(.footnote)
                }
                Section("Istanza del provider") {
                    Picker("Provider", selection: $draft.provider) {
                        Text("Nessuno").tag(nil as SshProvider?)
                        ForEach(SshProvider.allCases) { Text($0.title).tag(Optional($0)) }
                    }.onChange(of: draft.provider) { _, _ in draft.providerInstanceId = nil }
                    if let provider = draft.provider {
                        if connected {
                            Button("Carica istanze e stato") { Task { await store.loadInstances(provider) } }
                                .disabled(store.instancesLoading.contains(provider))
                            if store.instancesLoading.contains(provider) { ProgressView() }
                            Picker("Istanza associata", selection: $draft.providerInstanceId) {
                                Text("Da associare").tag(nil as String?)
                                if let current = draft.providerInstanceId, !(store.instances[provider] ?? []).contains(where: { $0.id == current }) {
                                    Text("ID attuale: \(current)").tag(Optional(current))
                                }
                                ForEach(store.instances[provider] ?? []) { instance in
                                    Text("\(instance.name) · \(instance.ip) · \(instance.displayStatus) · ID \(instance.id)").tag(Optional(instance.id))
                                }
                            }
                        } else { Text("Collega prima il tuo account \(provider.title) nel pannello Server.").font(.footnote) }
                        Text("L’associazione usa provider e ID istanza. L’IP da solo non identifica il bersaglio di un riavvio.")
                            .font(.footnote).foregroundStyle(Theme.inkSecondary)
                    }
                }
                if !valid { Text("Controlla nome, hostname/IP, porta e utente Linux.").font(.footnote).foregroundStyle(.red) }
            }
            .navigationTitle(draft.id == nil ? "Nuovo server" : "Modifica server")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(store.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salva") {
                        draft.name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task { if await store.mutate(.server(draft)) { dismiss() } }
                    }.disabled(!valid || store.busy)
                }
            }.interactiveDismissDisabled(store.busy)
        }
    }
}

struct SSHSiteEditor: View {
    @Bindable var store: SSHStore
    @Environment(\.dismiss) private var dismiss
    @State private var draft: SshSiteInput
    init(store: SSHStore, input: SshSiteInput) { self.store = store; _draft = State(initialValue: input) }
    private var valid: Bool {
        guard let url = URL(string: draft.url), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
              url.user == nil, url.password == nil else { return false }
        return !draft.serverId.isEmpty && !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && draft.name.count <= 200 && draft.path.count <= 500
        && draft.container.range(of: "^[a-zA-Z0-9_.-]{0,100}$", options: .regularExpression) != nil
    }
    var body: some View {
        NavigationStack {
            Form {
                if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                Section("Sito") {
                    TextField("Nome", text: $draft.name)
                    TextField("URL HTTPS o HTTP", text: $draft.url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Server", selection: $draft.serverId) {
                        ForEach(store.snapshot?.servers ?? []) { Text($0.name).tag($0.id) }
                    }
                }
                Section("WordPress") {
                    TextField("Percorso WordPress", text: $draft.path).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Container Docker (facoltativo)", text: $draft.container).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Se usi Docker, indica il container e il percorso WordPress visto al suo interno. Completa e verifica questi campi prima delle operazioni WP-CLI.").font(.footnote)
                }
            }.navigationTitle(draft.id == nil ? "Nuovo sito" : "Modifica sito")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(store.busy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Salva") { Task { if await store.mutate(.site(draft)) { dismiss() } } }.disabled(!valid || store.busy)
                    }
                }.interactiveDismissDisabled(store.busy)
        }
    }
}

struct SSHProviderForm: View {
    @Bindable var store: SSHStore
    let provider: SshProvider
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var apiKey = ""
    @State private var clientId = ""
    @State private var clientSecret = ""
    @State private var username = ""
    @State private var password = ""
    @State private var disconnecting = false
    private var connected: Bool { store.snapshot?.providers.contains { $0.provider == provider && $0.connected } == true }
    private var valid: Bool {
        if provider == .vultr { return (10...2000).contains(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).count) }
        return !clientId.isEmpty && clientId.count <= 200 && !clientSecret.isEmpty && clientSecret.count <= 2000
        && username.contains("@") && !password.isEmpty && password.count <= 2000
    }
    var body: some View {
        NavigationStack {
            Form {
                if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                Section {
                    Text("Le credenziali sono verificate in sola lettura prima del salvataggio cifrato nel backend del tuo account. I campi vengono svuotati dopo l’invio o quando chiudi questa schermata.")
                        .font(.footnote)
                    if provider == .vultr {
                        SecureField("Chiave API Vultr", text: $apiKey).textContentType(.password)
                        Text("Abilita l’accesso API nel tuo account e, quando possibile, limita gli IP autorizzati agli IP di uscita del backend Ernie.").font(.footnote)
                    } else {
                        TextField("Client ID", text: $clientId).privacySensitive()
                        SecureField("Client secret", text: $clientSecret).textContentType(.password)
                        TextField("Email utente API", text: $username).keyboardType(.emailAddress).privacySensitive()
                        SecureField("Password API", text: $password).textContentType(.password)
                        Text("Usa le credenziali API Contabo; non rigenerare un client secret già usato da altri collegamenti.").font(.footnote)
                    }
                    Button("Verifica e salva collegamento") { connect() }.disabled(!valid || store.busy)
                }.textInputAutocapitalization(.never).autocorrectionDisabled()
                if connected {
                    Section("Collegamento attuale") {
                        Label("Account collegato", systemImage: "checkmark.circle")
                        Button("Verifica connessione e leggi istanze") { Task { await store.loadInstances(provider) } }
                            .disabled(store.instancesLoading.contains(provider) || store.busy)
                        if store.instancesLoading.contains(provider) { ProgressView() }
                        ForEach(store.instances[provider] ?? []) { instance in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(instance.name).font(.headline)
                                Text("\(instance.ip) · \(instance.displayStatus)").font(.caption)
                                Text("ID \(instance.id)").font(.caption.monospaced()).textSelection(.enabled)
                            }
                        }
                        Button("Disconnetti \(provider.title)", role: .destructive) { disconnecting = true }.disabled(store.busy)
                    }
                }
            }.navigationTitle(provider.title)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { clear(); dismiss() } } }
                .confirmationDialog("Disconnettere il provider?", isPresented: $disconnecting, titleVisibility: .visible) {
                    Button("Disconnetti", role: .destructive) { clear(); Task { if await store.mutate(.disconnect(provider)) { dismiss() } } }
                } message: { Text("Ernie non potrà leggere lo stato o eseguire riavvii con questo collegamento. La chiave SSH resta indipendente.") }
                .onDisappear { clear() }
                .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
        }.privacySensitive()
    }
    private func connect() {
        let credentials: SshProviderCredentials = provider == .vultr
            ? .vultr(apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines))
            : .contabo(clientId: clientId, clientSecret: clientSecret, username: username, password: password)
        clear()
        Task { await store.mutate(.connect(credentials)) }
    }
    private func clear() { apiKey = ""; clientId = ""; clientSecret = ""; username = ""; password = "" }
}

struct SSHPlanEditor: View {
    @Bindable var store: SSHStore
    let server: SshServer
    let site: SshSite?
    @Environment(\.dismiss) private var dismiss
    @State private var kind: SshPlanInput.Kind
    @State private var title = ""
    @State private var reason = ""
    @State private var command = ""
    @State private var verification = ""
    @State private var backup = ""
    @State private var rollback = ""
    init(store: SSHStore, server: SshServer, site: SshSite? = nil, kind: SshPlanInput.Kind = .ssh) {
        self.store = store; self.server = server; self.site = site; _kind = State(initialValue: kind)
    }
    private var valid: Bool {
        [title, reason, backup, rollback].allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        && title.count <= 200 && reason.count <= 2000 && backup.count <= 2000 && rollback.count <= 2000
        && command.count <= 4000 && verification.count <= 4000
        && (kind == .providerReboot ? server.provider != nil && server.providerInstanceId != nil : !command.isEmpty && !verification.isEmpty)
    }
    var body: some View {
        NavigationStack {
            Form {
                if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                Section("Bersaglio") {
                    Text(server.name).font(.headline)
                    Text("\(server.username)@\(server.host):\(String(server.port))").font(.caption.monospaced())
                    Text(kind.title)
                    if let site { Text(site.name) }
                }
                if kind == .providerReboot {
                    SSHNotice("Questa azione prepara una proposta di riavvio tramite \(server.provider?.title ?? "provider"). L’istanza associata è \(server.providerInstanceId ?? "mancante"). Non viene eseguita finché non approvi la proposta.")
                }
                Section("Proposta") {
                    TextField("Titolo", text: $title, axis: .vertical)
                    TextField("Motivo e diagnosi", text: $reason, axis: .vertical)
                    if kind != .providerReboot {
                        TextField("Comando circoscritto", text: $command, axis: .vertical).font(.body.monospaced())
                        TextField("Comando di verifica", text: $verification, axis: .vertical).font(.body.monospaced())
                    }
                }
                Section("Recupero") {
                    TextField("Backup controllato / come preservare i dati", text: $backup, axis: .vertical)
                    TextField("Rollback o recupero", text: $rollback, axis: .vertical)
                }
                Text("Creare una proposta non esegue comandi. Potrai controllare tutti i dettagli e approvare o rifiutare dalla sezione Operazioni.").font(.footnote)
            }.navigationTitle("Proponi intervento")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(store.busy) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Proponi") {
                            let input = SshPlanInput(serverId: server.id, kind: kind, title: title, reason: reason, command: kind == .providerReboot ? "" : command,
                                                     verificationCommand: kind == .providerReboot ? "" : verification, backup: backup, rollback: rollback, siteId: site?.id)
                            Task { if await store.plan(input) { dismiss() } }
                        }.disabled(!valid || store.busy)
                    }
                }.interactiveDismissDisabled(store.busy)
        }
    }
}
