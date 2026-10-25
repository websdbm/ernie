import SwiftUI
import UniformTypeIdentifiers

/// Only a locked entrance belongs to Second Brain. Content never joins its index.
struct DiaryEntrance: View {
    @Environment(AppModel.self) private var model
    var incoming: String = ""
    var body: some View {
        // Senza profilo (avvio senza rete) vale lo scope ricordato per queste credenziali: il diario è locale.
        if let credentials = model.credentials, let scope = DiaryIdentity.scope(for: credentials, userID: model.profile?.userId) {
            PrivateDiaryView(scope: scope, api: ApiClient(credentials: credentials), incoming: incoming)
                .id(scope)
                .onAppear { model.voice?.cancelListening(); model.conversation?.muteSpeech() }
        } else {
            ContentUnavailableView("Account non disponibile", systemImage: "lock.fill", description: Text("Accedi al tuo account prima di aprire il diario."))
        }
    }
}

struct PrivateDiaryView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isSceneCaptured) private var isCaptured
    @Environment(\.dismiss) private var dismiss
    @State private var store: DiaryStore
    @State private var incoming: String
    @State private var backup = false
    @State private var capabilities: DiaryCapabilities?
    @State private var unlockTask: Task<Void, Never>?
    @State private var confirmDelete = false
    private let api: ApiClient
    init(scope: String, api: ApiClient, incoming: String = "") {
        self.api = api
        _store = State(initialValue: DiaryStore(scope: scope))
        _incoming = State(initialValue: incoming)
    }
    /// L'avviso di permesso della dettatura rende l'app inattiva: le pagine restano aperte (e il foglio della bozza
    /// pure), il passaggio in background blocca comunque.
    private var showsPages: Bool { store.isUnlocked && (scenePhase == .active || store.permissionPrompt) && !isCaptured }
    var body: some View {
        NavigationStack {
            Group {
                if showsPages {
                    DiaryLibrary(store: store, api: api, capabilities: $capabilities, pending: $incoming)
                        .id(store.generation)
                } else {
                    locked
                }
            }
            .navigationTitle("Diario personale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { store.lock(); incoming = ""; dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if store.isUnlocked { Button("Blocca diario", systemImage: "lock.fill") { store.lock() } }
                        Button("Copia cifrata e ripristino", systemImage: "externaldrive.badge.person.crop") { backup = true }
                        // Solo a diario sbloccato (o con la chiave ormai invalidata): nessuno elimina il diario altrui.
                        if store.isUnlocked || store.keyInvalidated {
                            Button("Elimina diario…", systemImage: "trash", role: .destructive) { confirmDelete = true }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .disabled(store.deleting)
                }
            }
        }
        .privacySensitive()
        .writingToolsBehavior(.disabled)
        .sheet(isPresented: $backup) { DiaryBackupView(store: store) }
        .alert("Eliminare il diario?", isPresented: $confirmDelete) {
            Button("Elimina diario", role: .destructive) {
                incoming = ""
                Task {
                    do { try await store.deleteDiary() }
                    catch { store.error = "Eliminazione non completata. Riprova; le pagine rimaste restano cifrate." }
                }
            }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("Pagine, bozza, riepiloghi e la chiave di questo diario saranno cancellati dal telefono. Non si può annullare. Le copie cifrate che hai esportato restano dove le hai salvate.")
        }
        .onChange(of: store.isUnlocked) { _, unlocked in
            if unlocked {
                if store.appendIncoming(incoming) { incoming = "" }
                Task { capabilities = try? await api.request("GET", "/v1/private-diary/capabilities") }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { store.sceneBecameActive() }
            if phase == .background || (phase == .inactive && store.isUnlocked && !store.permissionPrompt) {
                unlockTask?.cancel(); store.lock(); incoming = ""; backup = false
            }
        }
        .onChange(of: isCaptured) { _, captured in if captured { unlockTask?.cancel(); store.lock(); incoming = ""; backup = false } }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            if store.isUnlocked && !store.permissionPrompt { store.lock(); incoming = "" }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            if store.isUnlocked { unlockTask?.cancel(); store.lock(); incoming = ""; backup = false }
        }
        .onDisappear { unlockTask?.cancel(); store.lock(); incoming = "" }
    }
    private var locked: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "book.closed.fill").font(.system(size: 46)).foregroundStyle(.tint)
                Text("Uno spazio solo tuo").font(.title2.bold())
                Text("Pagine cifrate su questo dispositivo. Nessun contenuto nella chat, nelle ricerche generali o nelle condivisioni familiari.")
                Text("L’AI lavora solo dopo lo sblocco e la tua conferma per i testi selezionati. L’originale rimane sempre conservato.").foregroundStyle(.secondary)
                if isCaptured { Label("Interrompi la registrazione o condivisione dello schermo per aprire il diario.", systemImage: "lock.shield") }
                Button {
                    let epoch = store.generation
                    unlockTask = Task {
                        let creating = !store.exists
                        guard !Task.isCancelled, epoch == store.generation, scenePhase == .active, !isCaptured else { return }
                        await store.unlock()
                        if creating && store.isUnlocked && !Task.isCancelled {
                            _ = try? await api.setSkill(id: "diario_personale", enabled: true, available: true)
                            capabilities = try? await api.request("GET", "/v1/private-diary/capabilities")
                        }
                    }
                } label: {
                    Label(store.unlocking ? "Sblocco…" : store.exists ? "Sblocca diario" : "Attiva e crea diario", systemImage: "faceid")
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                }.buttonStyle(.borderedProminent).disabled(store.unlocking || store.deleting || isCaptured || scenePhase != .active)
                if let error = store.error { Text(error).foregroundStyle(.red).font(.callout) }
                if store.lostUnsavedChanges { Text("Non è stato possibile salvare le ultime modifiche prima del blocco: la bozza potrebbe essere incompleta.").foregroundStyle(.red) }
                Text("Accesso con Face ID o Touch ID attualmente registrati. Se cambi telefono o biometria, occorre una copia cifrata con la sua password: Ernie non può recuperarla al posto tuo.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("Per dettare contenuti riservati, dì prima solo «Apri diario», sbloccalo e usa «Detta sul dispositivo». La voce della chat segue le impostazioni generali e può usare servizi remoti.")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("Il diario si blocca quando lasci l’app. A diario aperto, iOS non impedisce gli screenshot manuali.")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(24)
        }
    }
}

private struct DiaryLibrary: View {
    @Bindable var store: DiaryStore
    let api: ApiClient
    @Binding var capabilities: DiaryCapabilities?
    @Binding var pending: String
    @State private var query = ""
    @State private var composing = false
    @State private var period = false
    @State private var selection: UUID?
    private var entries: [DiaryEntry] {
        (store.document?.entries ?? []).filter { entry in
            query.isEmpty || ([entry.original] + entry.revisions.flatMap { [$0.normalized] + $0.bullets }).contains { $0.localizedStandardContains(query) }
        }.sorted { $0.createdAt > $1.createdAt }
    }
    var body: some View {
        List {
            if !pending.isEmpty {
                Section("Testo in attesa, non ancora salvato") {
                    TextEditor(text: $pending).frame(minHeight: 160).autocorrectionDisabled().writingToolsBehavior(.disabled)
                    Button("Salva nel diario") { if store.appendIncoming(pending) { pending = "" } }
                    Text("Riduci il testo a 50.000 caratteri e riprova. Se chiudi o lasci l’app, questo testo non salvato sarà scartato.").font(.footnote)
                }
            }
            if store.lostUnsavedChanges { Text("Durante l’ultimo blocco alcune modifiche non salvate sono state scartate. Verifica l’ultima bozza.").foregroundStyle(.red) }
            Section {
                Button { composing = true } label: { Label("Scrivi una pagina", systemImage: "square.and.pencil") }
                if !(store.document?.draft.text.isEmpty ?? true) {
                    Button("Riprendi la bozza salvata") { composing = true }
                }
                Button { period = true } label: { Label("Riepilogo di un periodo", systemImage: "calendar") }
                    .disabled(store.document?.entries.isEmpty ?? true)
            } footer: { Text("Salvataggio cifrato locale. Usa «Copia cifrata e ripristino» per conservare una copia recuperabile su un altro dispositivo.") }
            if let error = store.error { Section { Text(error).font(.callout).foregroundStyle(.red) } }
            if store.busy { Section { ProgressView("Riordino e sintesi in corso…") } }
            if let status = capabilities, !status.enabled {
                Section {
                    Button("Attiva l’elaborazione AI del diario") {
                        Task {
                            do {
                                _ = try await api.setSkill(id: "diario_personale", enabled: true, available: true)
                                capabilities = try await api.request("GET", "/v1/private-diary/capabilities")
                            } catch { store.error = "Attivazione AI non completata. Le pagine locali restano disponibili." }
                        }
                    }
                } footer: { Text("L’attivazione non invia nessun testo. Ogni elaborazione richiede ancora la tua conferma.") }
            }
            ForEach(entries) { entry in
                Section {
                    NavigationLink {
                        DiaryEntryView(store: store, entryID: entry.id, api: api)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.title).font(.headline).lineLimit(2)
                            Label(entry.revisions.isEmpty ? "Originale conservato" : "Originale, testo riordinato e punti", systemImage: "lock.doc")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    }
                } header: { Text(entry.createdAt.formatted(date: .complete, time: .shortened)) }
            }
            if !query.isEmpty && entries.isEmpty { Text("Nessuna pagina corrispondente.").foregroundStyle(.secondary) }
            if let summaries = store.document?.summaries, !summaries.isEmpty {
                Section("Riepiloghi salvati") {
                    ForEach(summaries) { summary in
                        NavigationLink {
                            ScrollView { DiaryRevisionView(revision: summary).padding() }.navigationTitle("Riepilogo privato")
                        } label: {
                            VStack(alignment: .leading) {
                                Text("\(summary.sourceIDs.count) pagine")
                                Text(summary.createdAt.formatted()).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Cerca solo nel diario sbloccato")
        .sheet(isPresented: $composing) { DiaryComposer(store: store) }
        .sheet(isPresented: $period) { DiaryPeriodView(store: store, api: api) }
        .onAppear { if !(store.document?.draft.text.isEmpty ?? true) { composing = true } }
    }
}

private struct DiaryComposer: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: DiaryStore
    @State private var dictation = DiaryDictation()
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text((store.document?.draft.createdAt ?? .now).formatted(date: .complete, time: .shortened))
                    .font(.subheadline).foregroundStyle(.secondary)
                // Durante la dettatura il testo non si modifica a mano: la trascrizione riscrive la parte dettata e
                // cancellava quanto scritto nel frattempo.
                TextEditor(text: Binding(get: { store.document?.draft.text ?? "" }, set: { store.updateDraft($0) }))
                    .autocorrectionDisabled().writingToolsBehavior(.disabled).accessibilityLabel("Testo originale del diario")
                    .disabled(dictation.recording)
                    .opacity(dictation.recording ? 0.75 : 1)
                if dictation.recording { Text("Dettatura in corso: per modificare il testo, termina la dettatura.").font(.footnote).foregroundStyle(.secondary) }
                if let error = store.error ?? dictation.error { Text(error).font(.footnote).foregroundStyle(.red) }
                Button {
                    if dictation.recording { dictation.stop() }
                    else { dictation.start(store: store) }
                } label: { Label(dictation.recording ? "Termina dettatura" : "Detta sul dispositivo", systemImage: dictation.recording ? "stop.circle" : "mic") }
                Text(store.hasUnsavedChanges ? "Salvataggio in corso. Se compare un errore, le ultime modifiche non sono ancora al sicuro." : "Bozza salvata cifrata. «Conserva originale» chiude la pagina senza riscriverla; riordino e sintesi richiedono un consenso separato.")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding()
            .navigationTitle("Scrivi nel diario")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Chiudi bozza") { dictation.stop(); store.flush(); dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Conserva originale") { dictation.stop(); if store.saveEntry() != nil { dismiss() } }.disabled(store.document?.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) }
            }
        }
        .writingToolsBehavior(.disabled)
        .onDisappear { dictation.stop(); store.flush() }
    }
}

struct DiaryEntryView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: DiaryStore
    let entryID: UUID
    let api: ApiClient
    @State private var tab = 0
    @State private var confirmDelete = false
    var body: some View {
        if let entry = store.document?.entries.first(where: { $0.id == entryID }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(entry.createdAt.formatted(date: .complete, time: .shortened)).font(.subheadline).foregroundStyle(.secondary)
                    Picker("Versione", selection: $tab) {
                        Text("Originale").tag(0); Text("Riordinato").tag(1); Text("Punti").tag(2)
                    }.pickerStyle(.segmented)
                    if tab == 0 { Text(entry.original).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    else if let latest = entry.revisions.last {
                        if tab == 1 { Text(latest.normalized).textSelection(.enabled) }
                        else { ForEach(Array(latest.bullets.enumerated()), id: \.offset) { _, point in Text("• " + point).frame(maxWidth: .infinity, alignment: .leading) } }
                        Text("Elaborazione AI · \(latest.createdAt.formatted())").font(.caption).foregroundStyle(.secondary)
                    } else { Text("Non ancora elaborato. L’originale è già al sicuro nel diario.").foregroundStyle(.secondary) }
                    Button("Riordina e sintetizza con AI") {
                        do { try store.prepareAI(ids: [entryID], operation: "entry") } catch { store.error = (error as? DiaryError)?.errorDescription }
                    }.buttonStyle(.borderedProminent).disabled(store.busy)
                    if entry.revisions.count > 1 {
                        DisclosureGroup("Elaborazioni precedenti (\(entry.revisions.count - 1))") {
                            ForEach(entry.revisions.dropLast().reversed()) { DiaryRevisionView(revision: $0) }
                        }
                    }
                }.padding().lineSpacing(5)
            }.navigationTitle("Pagina privata").navigationBarTitleDisplayMode(.inline)
                .writingToolsBehavior(.disabled)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Elimina pagina", systemImage: "trash", role: .destructive) { confirmDelete = true }
                            .disabled(store.busy)
                    }
                }
                .confirmationDialog("Eliminare questa pagina?", isPresented: $confirmDelete, titleVisibility: .visible) {
                    Button("Elimina pagina", role: .destructive) { store.deleteEntry(entryID); dismiss() }
                    Button("Annulla", role: .cancel) {}
                } message: {
                    Text("L’originale, le sue elaborazioni AI e i riepiloghi che la includono saranno cancellati da questo telefono. Non si può annullare.")
                }
                .modifier(DiaryConsentPrompt(store: store, api: api))
        }
    }
}
private struct DiaryRevisionView: View {
    let revision: DiaryRevision
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(revision.createdAt.formatted()).font(.caption).foregroundStyle(.secondary)
            Text("Testo riordinato").font(.headline)
            Text(revision.normalized).textSelection(.enabled)
            Text("Punti chiave").font(.headline)
            ForEach(Array(revision.bullets.enumerated()), id: \.offset) { _, point in Text("• " + point) }
            Text("AI: \(revision.model) · \(revision.sourceIDs.count) pagine di origine").font(.caption).foregroundStyle(.secondary)
        }.lineSpacing(5)
    }
}
private struct DiaryPeriodView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: DiaryStore
    let api: ApiClient
    @State private var from = Calendar.current.date(byAdding: .day, value: -7, to: .now) ?? .now
    @State private var through = Date.now
    private var selected: [DiaryEntry] {
        let start = Calendar.current.startOfDay(for: from)
        let end = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: through)) ?? through
        return (store.document?.entries ?? []).filter { $0.createdAt >= start && $0.createdAt < end }.sorted { $0.createdAt < $1.createdAt }
    }
    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Dal", selection: $from, displayedComponents: .date)
                DatePicker("Al", selection: $through, in: from..., displayedComponents: .date)
                Text("\(selected.count) pagine selezionate")
                Button("Prepara il riepilogo") {
                    do { try store.prepareAI(ids: selected.map(\.id), operation: "period") }
                    catch { store.error = (error as? DiaryError)?.errorDescription; dismiss() }
                }.disabled(selected.isEmpty || selected.count > 31 || store.busy)
                Text("Dopo la selezione ti verrà chiesto il consenso all’invio. Massimo 31 pagine e 60.000 caratteri.").font(.footnote)
            }.navigationTitle("Riepilogo privato")
                .onChange(of: from) { _, value in if through < value { through = value } }
                .modifier(DiaryConsentPrompt(store: store, api: api, authorized: { dismiss() }))
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } } }
        }
        .writingToolsBehavior(.disabled)
    }
}

private struct DiaryBackupFile: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
private struct DiaryBackupView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: DiaryStore
    @State private var password = ""
    @State private var confirmation = ""
    @State private var file: DiaryBackupFile?
    @State private var exporting = false
    @State private var importing = false
    @State private var error: String?
    @State private var busy: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Almeno 12 caratteri", text: $password)
                    SecureField("Ripeti password", text: $confirmation)
                } header: { Text("Password della copia") } footer: { Text("Scegli una password lunga e diversa da quelle abituali. Ernie non la memorizza e non può recuperarla. Il file contiene solo dati cifrati.") }
                if store.isUnlocked {
                    Button("Esporta copia cifrata") {
                        // PBKDF2 e cifratura nello store, fuori dal main.
                        let pass = password; error = nil; busy = "Cifro la copia…"
                        Task {
                            do {
                                file = DiaryBackupFile(data: try await store.exportBackup(password: pass))
                                exporting = true; password = ""; confirmation = ""
                            } catch { self.error = (error as? DiaryError)?.errorDescription ?? "Esportazione non riuscita. Riprova." }
                            busy = nil
                        }
                    }.disabled(password.count < 12 || password != confirmation || busy != nil)
                }
                Button("Importa copia cifrata") { importing = true }.disabled(password.isEmpty || busy != nil)
                Text(store.isUnlocked ? "L’importazione aggiunge le pagine mancanti e conserva quelle già presenti." : "Ripristino di recupero: dopo la password servirà Face ID. La copia sostituirà il diario locale non accessibile; le pagine successive alla copia non saranno recuperate.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let busy { ProgressView(busy) }
                if let error { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Copia cifrata")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { password = ""; confirmation = ""; dismiss() } } }
        }
        .writingToolsBehavior(.disabled)
        .fileExporter(isPresented: $exporting, document: file, contentType: .data, defaultFilename: "diario-personale.erniediary") { _ in file = nil }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.data]) { result in
            guard case .success(let url) = result else { return }
            let allowed = url.startAccessingSecurityScopedResource()
            defer { if allowed { url.stopAccessingSecurityScopedResource() } }
            do {
                guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 23_000_000 else { throw DiaryError.invalidArchive }
                let data = try Data(contentsOf: url)
                let pass = password; password = ""; confirmation = ""; busy = "Ripristino…"; error = nil
                Task {
                    do { try await store.restoreBackup(data, password: pass); busy = nil; dismiss() }
                    catch {
                        // Il messaggio dice cosa è successo: password o file, Face ID annullato, limiti superati, disco.
                        self.error = (error as? DiaryError)?.errorDescription ?? DiaryError.invalidArchive.errorDescription
                        busy = nil
                    }
                }
            } catch { self.error = DiaryError.invalidArchive.errorDescription }
        }
        .onDisappear { password = ""; confirmation = ""; file = nil }
    }
}

private struct DiaryConsentPrompt: ViewModifier {
    @Bindable var store: DiaryStore
    let api: ApiClient
    var authorized: () -> Void = {}
    func body(content: Content) -> some View {
        content
        .alert("Autorizzi l’elaborazione AI?", isPresented: Binding(get: { store.consent != nil }, set: { if !$0 { store.cancelConsent() } })) {
            if let consent = store.consent {
                Button("Invia questa selezione") { do { try store.authorize(consent.id, client: PrivateDiaryAI(credentials: api.credentials)); authorized() } catch { store.error = DiaryError.consentRequired.errorDescription } }
            }
            Button("Annulla", role: .cancel) { store.cancelConsent() }
        } message: {
            Text("Solo le \(store.consent?.ids.count ?? 0) pagine selezionate (\(store.consent?.characters ?? 0) caratteri) saranno decifrate e inviate al server Ernie e al provider AI tramite OpenRouter. Non entreranno nella chat o nella memoria. Si applicano anche le impostazioni privacy del provider. Il consenso vale soltanto per questa elaborazione.")
        }
    }
}
