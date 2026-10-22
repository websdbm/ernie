import SwiftUI

struct SSHServerDetail: View {
    @Bindable var store: SSHStore
    let serverId: String
    @State private var editing = false
    @State private var proposing = false
    @State private var rebooting = false
    @State private var confirmTrust = false
    @State private var compared = false
    var body: some View {
        ScrollView {
            if let server = store.snapshot?.servers.first(where: { $0.id == serverId }) {
                VStack(alignment: .leading, spacing: 18) {
                    Text(server.name).font(.title2.bold())
                    Text("\(server.username)@\(server.host):\(String(server.port))").font(.caption.monospaced()).textSelection(.enabled)
                    if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                    Button("Modifica server", systemImage: "pencil") { editing = true }.buttonStyle(.bordered)
                    Text("Identità del server").font(.headline)
                    if let fingerprint = server.fingerprint {
                        Text("Registrata: \(fingerprint)").font(.caption.monospaced()).textSelection(.enabled)
                    } else { SSHNotice("L’impronta host non è ancora verificata. La lettura dell’impronta non implica fiducia automatica.") }
                    Button("Leggi impronta host", systemImage: "fingerprint") {
                        compared = false
                        Task { await store.probe(serverId) }
                    }.buttonStyle(.bordered).disabled(store.probing.contains(serverId) || store.busy)
                    if store.probing.contains(serverId) { ProgressView("Leggo l’impronta…") }
                    if let fingerprint = store.fingerprints[serverId] {
                        Text(fingerprint).font(.caption.monospaced()).textSelection(.enabled)
                        SSHNotice("Confronta questa impronta con quella ottenuta dalla console del provider o da un accesso già fidato. Non basta che il server abbia risposto.")
                        Toggle("Ho confrontato l’impronta tramite una fonte attendibile", isOn: $compared)
                        Button("Approva questa impronta", systemImage: "checkmark.shield") { confirmTrust = true }
                            .buttonStyle(.borderedProminent).disabled(!compared || store.busy)
                    }
                    SSHDiagnostics(store: store, serverId: serverId, siteId: nil, trusted: server.fingerprint != nil)
                    Button("Proponi intervento SSH", systemImage: "terminal") { proposing = true }
                        .buttonStyle(.bordered).disabled(server.fingerprint == nil)
                    Button("Proponi riavvio tramite provider", systemImage: "restart", role: .destructive) { rebooting = true }
                        .buttonStyle(.bordered).disabled(server.provider == nil || server.providerInstanceId?.isEmpty != false)
                    Text("SSH non raggiungibile non significa server spento. Il riavvio richiede diagnosi, piano e approvazione espliciti.")
                        .font(.footnote).foregroundStyle(Theme.inkSecondary)
                    ForEach(store.snapshot?.operations.filter { $0.serverId == serverId } ?? []) { operation in
                        SSHOperationView(operation: operation, canDecide: store.canDecide(operation), busy: store.busy,
                                         approve: { Task { await store.decide(operation, approve: true) } },
                                         reject: { Task { await store.decide(operation, approve: false) } },
                                         refresh: { Task { await store.refreshOperation(operation.id) } })
                    }
                }.padding(16).frame(maxWidth: 700).frame(maxWidth: .infinity)
                    .sheet(isPresented: $editing) { SSHServerEditor(store: store, input: server.input) }
                    .sheet(isPresented: $proposing) { SSHPlanEditor(store: store, server: server) }
                    .sheet(isPresented: $rebooting) { SSHPlanEditor(store: store, server: server, kind: .providerReboot) }
                    .confirmationDialog("Registrare l’impronta verificata?", isPresented: $confirmTrust, titleVisibility: .visible) {
                        if let fingerprint = store.fingerprints[serverId] {
                            Button("Registra impronta") { Task { if await store.mutate(.trust(serverId: serverId, fingerprint: fingerprint)) { compared = false } } }
                        }
                    } message: { Text("Bersaglio: \(server.host):\(String(server.port)). Un’impronta diversa in futuro bloccherà l’accesso finché non sarà verificata.") }
            }
        }.background(Theme.ground).navigationTitle("Server")
    }
}

struct SSHSiteDetail: View {
    @Bindable var store: SSHStore
    let siteId: String
    @State private var editing = false
    @State private var proposing = false
    var body: some View {
        ScrollView {
            if let site = store.snapshot?.sites.first(where: { $0.id == siteId }),
               let server = store.snapshot?.servers.first(where: { $0.id == site.serverId }) {
                VStack(alignment: .leading, spacing: 16) {
                    Text(site.name).font(.title2.bold())
                    Text(site.url).textSelection(.enabled)
                    Text("Server: \(server.name) · \(server.host)").font(.subheadline)
                    Text("Percorso: \(site.path.isEmpty ? "da completare" : site.path)").font(.caption.monospaced())
                    if !site.container.isEmpty { Text("Container: \(site.container)").font(.caption.monospaced()) }
                    if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                    Button("Modifica sito", systemImage: "pencil") { editing = true }.buttonStyle(.bordered)
                    SSHDiagnostics(store: store, serverId: server.id, siteId: site.id, trusted: server.fingerprint != nil && !site.path.isEmpty)
                    Button("Proponi intervento WP-CLI", systemImage: "terminal") { proposing = true }
                        .buttonStyle(.bordered).disabled(site.path.isEmpty || server.fingerprint == nil)
                }.padding(16).frame(maxWidth: 700).frame(maxWidth: .infinity)
                    .sheet(isPresented: $editing) { SSHSiteEditor(store: store, input: site.input) }
                    .sheet(isPresented: $proposing) { SSHPlanEditor(store: store, server: server, site: site, kind: .wpCli) }
            }
        }.background(Theme.ground).navigationTitle("Sito")
    }
}

struct SSHDiagnostics: View {
    @Bindable var store: SSHStore
    let serverId: String
    let siteId: String?
    let trusted: Bool
    @State private var selected: SshDiagnosticInput.Check = .overview
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Diagnostica in sola lettura").font(.headline)
            Picker("Controllo", selection: $selected) {
                ForEach(SshDiagnosticInput.Check.allCases.filter { siteId != nil || $0 != .wordpress }) { Text($0.title).tag($0) }
            }
            if !trusted { SSHNotice("Completa i dati del sito e verifica l’impronta host prima della connessione.") }
            Button("Esegui controllo", systemImage: "stethoscope") {
                Task { await store.diagnose(.init(serverId: serverId, check: selected, siteId: siteId)) }
            }.buttonStyle(.bordered).disabled(!trusted || store.diagnosticLoading || store.busy)
            if store.diagnosticLoading { ProgressView("Controllo in corso…") }
            if store.diagnosticInput?.serverId == serverId, store.diagnosticInput?.siteId == siteId, let output = store.diagnosticOutput {
                Text(output).font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }.padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    }
}
