import SwiftUI

struct SSHServerDetail: View {
    @Bindable var store: SSHStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatPalette) private var palette
    let serverId: String
    @State private var editing = false
    @State private var proposing = false
    @State private var rebooting = false
    @State private var confirmTrust = false
    @State private var compared = false
    @State private var deletion: SSHDeletionRequest?
    @State private var deleted = false
    var body: some View {
        ScrollView {
            if let server = store.snapshot?.servers.first(where: { $0.id == serverId }) {
                VStack(alignment: .leading, spacing: 18) {
                    Text(server.name).font(.title2.bold())
                    Text("\(server.username)@\(server.host):\(String(server.port))").font(.caption.monospaced()).textSelection(.enabled)
                    if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                    Text("Identità del server").font(.headline)
                    if let fingerprint = server.fingerprint {
                        Text("Registrata: \(fingerprint)").font(.caption.monospaced()).textSelection(.enabled)
                    } else { SSHNotice("L’impronta host non è ancora verificata. La lettura dell’impronta non implica fiducia automatica.") }
                    Button("Leggi impronta host", systemImage: "fingerprint") {
                        compared = false
                        Task { await store.probe(serverId) }
                    }.buttonStyle(ErnieButtonStyle()).disabled(store.probing.contains(serverId) || store.busy)
                    if store.probing.contains(serverId) { ProgressView("Leggo l’impronta…") }
                    if let fingerprint = store.fingerprints[serverId] {
                        Text(fingerprint).font(.caption.monospaced()).textSelection(.enabled)
                        SSHNotice("Confronta questa impronta con quella ottenuta dalla console del provider o da un accesso già fidato. Non basta che il server abbia risposto.")
                        Toggle("Ho confrontato l’impronta tramite una fonte attendibile", isOn: $compared)
                        Button("Approva questa impronta", systemImage: "checkmark.shield") { confirmTrust = true }
                            .buttonStyle(ErnieButtonStyle(emphasis: .primary)).disabled(!compared || store.busy)
                    }
                    SSHDiagnostics(store: store, serverId: serverId, siteId: nil, trusted: server.fingerprint != nil)
                    Button("Proponi intervento SSH", systemImage: "terminal") { proposing = true }
                        .buttonStyle(ErnieButtonStyle()).disabled(server.fingerprint == nil || store.busy)
                    Button("Proponi riavvio tramite provider", systemImage: "restart", role: .destructive) { rebooting = true }
                        .buttonStyle(ErnieButtonStyle()).disabled(server.provider == nil || server.providerInstanceId?.isEmpty != false || store.busy)
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
            else if store.snapshot != nil { ContentUnavailableView("Server non più disponibile", systemImage: "server.rack") }
        }.background(palette.ground).foregroundStyle(palette.ink).navigationTitle("Server")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Modifica server", systemImage: "pencil") { editing = true }
                        Button("Rimuovi da Ernie…", systemImage: "trash", role: .destructive) {
                            store.clearError(); deletion = store.deletionRequest(for: .server(serverId))
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").frame(minWidth: 44, minHeight: 44)
                    }.accessibilityLabel("Azioni sul server").disabled(store.busy || store.snapshot?.servers.contains(where: { $0.id == serverId }) != true)
                }
            }
            .sheet(item: $deletion, onDismiss: { if deleted { dismiss() } }) { request in
                SSHDeletionSheet(store: store, request: request) { deleted = true; deletion = nil }
            }
            .onChange(of: store.snapshot == nil) { _, missing in if missing { deletion = nil; dismiss() } }
    }
}

struct SSHSiteDetail: View {
    @Bindable var store: SSHStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatPalette) private var palette
    let siteId: String
    @State private var editing = false
    @State private var proposing = false
    @State private var deletion: SSHDeletionRequest?
    @State private var deleted = false
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
                    SSHDiagnostics(store: store, serverId: server.id, siteId: site.id, trusted: server.fingerprint != nil && !site.path.isEmpty)
                    Button("Proponi intervento WP-CLI", systemImage: "terminal") { proposing = true }
                        .buttonStyle(ErnieButtonStyle()).disabled(site.path.isEmpty || server.fingerprint == nil || store.busy)
                }.padding(16).frame(maxWidth: 700).frame(maxWidth: .infinity)
                    .sheet(isPresented: $editing) { SSHSiteEditor(store: store, input: site.input) }
                    .sheet(isPresented: $proposing) { SSHPlanEditor(store: store, server: server, site: site, kind: .wpCli) }
            }
            else if store.snapshot != nil { ContentUnavailableView("Sito non più disponibile", systemImage: "globe") }
        }.background(palette.ground).foregroundStyle(palette.ink).navigationTitle("Sito")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Modifica sito", systemImage: "pencil") { editing = true }
                        Button("Rimuovi da Ernie…", systemImage: "trash", role: .destructive) {
                            store.clearError(); deletion = store.deletionRequest(for: .site(siteId))
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").frame(minWidth: 44, minHeight: 44)
                    }.accessibilityLabel("Azioni sul sito").disabled(store.busy || store.snapshot?.sites.contains(where: { $0.id == siteId }) != true)
                }
            }
            .sheet(item: $deletion, onDismiss: { if deleted { dismiss() } }) { request in
                SSHDeletionSheet(store: store, request: request) { deleted = true; deletion = nil }
            }
            .onChange(of: store.snapshot == nil) { _, missing in if missing { deletion = nil; dismiss() } }
    }
}

private struct SSHDeletionSheet: View {
    @Bindable var store: SSHStore
    let request: SSHDeletionRequest
    let onDeleted: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatPalette) private var palette
    @State private var attempted = false
    var body: some View {
        NavigationStack {
            ScrollView {
                SSHDeletionContent(request: request, problem: store.deletionProblem(request),
                                   error: attempted ? store.error : nil,
                                   working: store.deleting == request.target,
                                   canDelete: store.canDelete(request), attempted: attempted,
                                   remove: {
                                       attempted = true
                                       Task { if await store.delete(request) { onDeleted() } }
                                   }, refresh: {
                                       Task { await store.load(); dismiss() }
                                   })
                    .padding(16).frame(maxWidth: 700).frame(maxWidth: .infinity)
            }
            .background(palette.ground).navigationTitle("Rimuovi dall’inventario")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Chiudi") { dismiss() }.disabled(store.deleting == request.target)
                }
            }
            .interactiveDismissDisabled(store.deleting == request.target)
        }
    }
}

/// Contenuto senza I/O condiviso con le prove di leggibilità della conferma distruttiva.
struct SSHDeletionContent: View {
    let request: SSHDeletionRequest
    var problem: String?
    var error: String?
    var working: Bool
    var canDelete: Bool
    var attempted = false
    var remove: () -> Void
    var refresh: () -> Void
    @Environment(\.chatPalette) private var palette
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(request.title).font(.title2.bold()).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 6) {
                Text(request.name).font(.headline)
                Text(request.location).font(.subheadline).foregroundStyle(palette.inkSecondary)
                    .textSelection(.enabled)
                if request.site == nil, !request.linkedSites.isEmpty {
                    Text("Siti collegati").font(.subheadline.weight(.semibold)).padding(.top, 6)
                    ForEach(request.linkedSites) { site in
                        Text("• \(site.name) · \(site.url)").font(.subheadline)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(16).ernieSurface()
            Text(request.consequences).font(.body)
            Label(request.remoteImpact, systemImage: "server.rack").font(.callout)
                .foregroundStyle(palette.inkSecondary)
            if let problem { SSHNotice(problem, symbol: "exclamationmark.circle") }
            if let error { SSHNotice(error, symbol: "exclamationmark.circle") }
            if working {
                ProgressView("Rimozione dall’inventario…").frame(maxWidth: .infinity)
            } else if attempted {
                Text("Controlla l’inventario aggiornato prima di riprovare.").font(.footnote).foregroundStyle(palette.inkSecondary)
                Button("Aggiorna inventario e chiudi", systemImage: "arrow.clockwise", action: refresh)
                    .buttonStyle(ErnieButtonStyle(fillsWidth: true))
            } else {
                Button("Rimuovi da Ernie", systemImage: "trash", role: .destructive, action: remove)
                    .buttonStyle(ErnieButtonStyle(emphasis: .destructive, fillsWidth: true))
                    .disabled(!canDelete)
            }
        }.foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
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
            }.buttonStyle(ErnieButtonStyle()).disabled(!trusted || store.diagnosticLoading || store.busy)
            if store.diagnosticLoading { ProgressView("Controllo in corso…") }
            if store.diagnosticInput?.serverId == serverId, store.diagnosticInput?.siteId == siteId, let output = store.diagnosticOutput {
                Text(output).font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }.padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    }
}
