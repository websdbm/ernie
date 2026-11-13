import SwiftUI
import AuthenticationServices

struct RaindropView: View {
    @Environment(AppModel.self) private var model
    @State private var status: RaindropStatus?
    @State private var owner: Credentials?
    @State private var token = ""
    @State private var collections: [RaindropCollection] = []
    @State private var items: [RaindropBookmark] = []
    @State private var query = ""
    @State private var collectionId = 0
    @State private var nextPage: Int?
    @State private var busy = false
    @State private var searching = false
    @State private var error: String?
    @State private var searchGeneration = UUID()
    @State private var confirmDisconnect = false
    @State private var authorization = RaindropWebAuthorization()
    @State private var authorizationGeneration = UUID()
    @State private var authorizationTask: Task<Void, Never>?

    var body: some View {
        List {
            Section {
                Label("La tua libreria di segnalibri", systemImage: "bookmark.fill")
                    .font(.headline)
                Text("Cerca e consulta i contenuti salvati su Raindrop. Restano separati dal Second Brain: Ernie li trasferisce soltanto quando glielo chiedi.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            if owner == model.credentials, let status {
                Section {
                    Toggle("Skill Raindrop", isOn: Binding(get: { status.enabled }, set: { value in Task { await setEnabled(value) } }))
                        .disabled(busy)
                    if let account = status.account {
                        LabeledContent(account.name, value: account.pro ? "Pro" : "Gratuito")
                        if !status.enabled {
                            Text("Collegamento conservato. Ernie non può consultare la libreria finché la skill è spenta.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Button("Scollega account", role: .destructive) { confirmDisconnect = true }
                            .disabled(busy)
                    } else if !status.configured {
                        Text("Il server deve essere aggiornato e configurato prima del collegamento.")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else if status.enabled {
                        if status.oauthConfigured == true {
                            Button { authorizationTask = Task { await connectOAuth() } } label: {
                                Label("Accedi con Raindrop", systemImage: "person.crop.circle.badge.checkmark")
                            }
                            .buttonStyle(.borderedProminent).disabled(busy)
                            Text("Accedi sul sito Raindrop e autorizza Ernie. Tornerai automaticamente qui.")
                                .font(.footnote).foregroundStyle(.secondary)
                            DisclosureGroup("Collegamento manuale con token") { manualConnection }
                        } else { manualConnection }
                    } else {
                        Text("Attiva la skill per collegare il tuo account.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } header: { Text("Collegamento") } footer: {
                    Text("Scollegare elimina la credenziale da Ernie e lascia intatta la libreria. Puoi revocare il token anche nelle integrazioni Raindrop.")
                }
                if status.connected && status.enabled {
                    library
                }
            } else if busy { ProgressView() }
        }
        .navigationTitle("Raindrop")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.credentials) {
            clear()
            await load()
        }
        .onDisappear { token = ""; searchGeneration = UUID(); authorizationTask?.cancel(); authorization.cancel() }
        .confirmationDialog("Scollegare Raindrop?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Scollega account", role: .destructive) { Task { await disconnect() } }
        } message: { Text("La credenziale sarà rimossa da Ernie. I tuoi segnalibri resteranno su Raindrop.") }
    }

    @ViewBuilder private var manualConnection: some View {
        Link("Apri le integrazioni di Raindrop", destination: URL(string: "https://app.raindrop.io/settings/integrations")!)
        Text("Crea un’app personale nelle integrazioni Raindrop, aprine le impostazioni e copia il «Test token». Incollalo qui: verrà verificato e conservato cifrato nel tuo account Ernie. Non inviarlo in chat.")
            .font(.footnote).foregroundStyle(.secondary)
        SecureField("Token personale Raindrop", text: $token)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
        Button("Collega account") { Task { await connect() } }
            .buttonStyle(.borderedProminent)
            .disabled(busy || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private func connectOAuth() async {
        guard let api = model.api, !busy else { return }
        let attempt = UUID()
        authorizationGeneration = attempt
        busy = true; error = nil
        defer { if model.credentials == api.credentials && authorizationGeneration == attempt { busy = false } }
        do {
            let verifier = try makeRaindropVerifier()
            let start = try await api.raindropOAuthStart(verifier: verifier)
            try Task.checkCancellation()
            guard model.credentials == api.credentials, authorizationGeneration == attempt else { return }
            let code = try await authorization.authorize(start)
            try Task.checkCancellation()
            guard model.credentials == api.credentials, authorizationGeneration == attempt else { return }
            let value = try await api.raindropOAuthComplete(state: start.state, verifier: verifier, code: code)
            guard model.credentials == api.credentials, authorizationGeneration == attempt else { return }
            status = value
            token = ""
            await loadLibrary(api)
        } catch is CancellationError { /* Closing the panel cancels the local flow. */
        } catch let err as ASWebAuthenticationSessionError where err.code == .canceledLogin {
        } catch {
            if model.credentials == api.credentials, authorizationGeneration == attempt { self.error = Self.describe(error) }
        }
    }

    @ViewBuilder private var library: some View {
        Section {
            Text("Se chiedi un’analisi a Ernie, i contenuti pertinenti sono inviati al modello AI configurato.")
                .font(.footnote).foregroundStyle(.secondary)
            Picker("Raccolta", selection: $collectionId) {
                Text("Tutte").tag(0)
                Text("Non organizzati").tag(-1)
                ForEach(collections) { c in Text(c.title).tag(c.id) }
            }
            .onChange(of: collectionId) { _, _ in Task { await search() } }
            HStack {
                TextField("Cerca parole o #tag", text: $query)
                    .submitLabel(.search)
                    .onSubmit { Task { await search() } }
                Button { Task { await search() } } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel("Cerca in Raindrop")
                    .disabled(searching)
            }
            if searching { ProgressView() }
            if !searching && items.isEmpty { Text("Nessun segnalibro trovato.").foregroundStyle(.secondary) }
            ForEach(items) { item in
                NavigationLink {
                    RaindropBookmarkView(item: item, owner: owner)
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.body.weight(.semibold)).lineLimit(2)
                        if !item.excerpt.isEmpty { Text(item.excerpt).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                        if !item.tags.isEmpty { Text(item.tags.map { "#\($0)" }.joined(separator: " ")).font(.caption).foregroundStyle(Color.accentColor).lineLimit(1) }
                        if let host = item.safeURL?.host { Text(host).font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 3)
                }
            }
            if let page = nextPage {
                Button("Mostra altri") { Task { await search(page: page) } }.disabled(searching)
            }
        } header: { Text("La tua libreria") } footer: {
            Text("Qui cerchi i segnalibri. Puoi chiedere a Ernie di confrontare o riassumere i risultati; ricerca semantica e lettura integrale dipendono dalle funzioni disponibili nel tuo piano Raindrop.")
        }
    }

    private func clear() {
        authorizationGeneration = UUID(); authorizationTask?.cancel(); authorization.cancel()
        searchGeneration = UUID(); token = ""; status = nil; owner = nil; collections = []; items = []
        query = ""; collectionId = 0; nextPage = nil; error = nil; busy = false; searching = false
    }
    private func load() async {
        guard let api = model.api else { return }
        busy = true
        defer { if model.credentials == api.credentials { busy = false } }
        do {
            let value = try await api.raindropStatus()
            guard model.credentials == api.credentials, !Task.isCancelled else { return }
            status = value; owner = api.credentials; error = nil
            if value.enabled && value.connected { await loadLibrary(api) }
        } catch {
            guard model.credentials == api.credentials else { return }
            self.error = Self.describe(error)
        }
    }
    private func loadLibrary(_ api: ApiClient) async {
        do {
            let value = try await api.raindropCollections()
            guard model.credentials == api.credentials, !Task.isCancelled else { return }
            collections = value
            await search()
        } catch { if model.credentials == api.credentials { self.error = Self.describe(error) } }
    }
    private func setEnabled(_ value: Bool) async {
        guard let api = model.api else { return }; busy = true
        do {
            _ = try await api.setSkill(id: "raindrop", enabled: value, available: value ? true : nil)
            guard model.credentials == api.credentials else { return }
            searchGeneration = UUID(); items = []; collections = []; nextPage = nil; token = ""
            await load()
        } catch { if model.credentials == api.credentials { busy = false; self.error = Self.describe(error) } }
    }
    private func connect() async {
        guard let api = model.api else { return }; busy = true
        let credential = token.trimmingCharacters(in: .whitespacesAndNewlines); token = ""
        defer { if model.credentials == api.credentials { busy = false } }
        do {
            let value = try await api.raindropConnect(token: credential)
            guard model.credentials == api.credentials else { return }
            status = value; owner = api.credentials; error = nil
            await loadLibrary(api)
        } catch { if model.credentials == api.credentials { self.error = Self.describe(error) } }
    }
    private func disconnect() async {
        guard let api = model.api else { return }; busy = true; searchGeneration = UUID()
        defer { if model.credentials == api.credentials { busy = false } }
        do {
            let value = try await api.raindropDisconnect()
            guard model.credentials == api.credentials else { return }
            status = value; items = []; collections = []; nextPage = nil; error = nil; token = ""
        } catch { if model.credentials == api.credentials { self.error = Self.describe(error) } }
    }
    private func search(page: Int = 0) async {
        guard status?.enabled == true, status?.connected == true, let api = model.api else { return }
        let generation = UUID(); searchGeneration = generation; searching = true
        if page == 0 { items = []; nextPage = nil }
        defer { if searchGeneration == generation { searching = false } }
        do {
            let result = try await api.raindropSearch(query: query, collectionId: collectionId, page: page)
            guard model.credentials == api.credentials, searchGeneration == generation, !Task.isCancelled else { return }
            let seen = Set(items.map(\.id)); items += result.items.filter { !seen.contains($0.id) }
            nextPage = result.nextPage; error = nil
        } catch {
            if model.credentials == api.credentials, searchGeneration == generation { self.error = Self.describe(error) }
        }
    }
    static func describe(_ error: any Error) -> String {
        if let api = error as? ApiError, api.status == 404 { return "Questo server non dispone ancora della skill Raindrop. Serve l’aggiornamento del backend." }
        return AppModel.describe(error)
    }
}

private struct RaindropBookmarkView: View {
    @Environment(AppModel.self) private var model
    let item: RaindropBookmark
    let owner: Credentials?
    @State private var detail: RaindropBookmark?
    @State private var error: String?
    @State private var loading = false
    var body: some View {
        let item = detail ?? self.item
        Group {
          if owner == model.credentials, owner != nil {
           List {
            if loading { ProgressView() }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
            Section {
                Text(item.title).font(.title2.weight(.semibold)).textSelection(.enabled)
                if let url = item.safeURL { Link("Apri la pagina originale", destination: url) }
                if !item.tags.isEmpty { Text(item.tags.map { "#\($0)" }.joined(separator: " ")).font(.footnote).foregroundStyle(.secondary) }
            }
            if !item.excerpt.isEmpty { Section("Estratto") { Text(item.excerpt).textSelection(.enabled) } }
            if !item.note.isEmpty { Section("Le tue note") { Text(item.note).textSelection(.enabled) } }
            if !item.highlights.isEmpty {
                Section("Evidenziazioni") {
                    ForEach(Array(item.highlights.enumerated()), id: \.offset) { _, value in Text(value).textSelection(.enabled) }
                }
            }
            Section { Text("Contenuto consultato da Raindrop. Nessun salvataggio nel Second Brain.").font(.footnote).foregroundStyle(.secondary) }
           }
          } else {
            ContentUnavailableView("Account cambiato", systemImage: "person.crop.circle", description: Text("Apri i segnalibri dell’account corrente."))
          }
        }.navigationTitle("Segnalibro").navigationBarTitleDisplayMode(.inline)
          .task(id: model.credentials) {
              guard let api = model.api, api.credentials == owner else { detail = nil; return }
              loading = true
              defer { loading = false }
              do {
                  let value = try await api.raindropBookmark(id: item.id)
                  guard model.credentials == owner, !Task.isCancelled else { return }
                  detail = value; error = nil
              } catch {
                  if model.credentials == owner { self.error = RaindropView.describe(error) }
              }
          }
    }
}
