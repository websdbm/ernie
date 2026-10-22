import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct SSHHomeView: View {
    @Bindable var store: SSHStore
    @Environment(\.dismiss) private var dismiss
    @State private var tab = 0
    @State private var serverSearch = ""
    @State private var siteSearch = ""
    @State private var siteServerFilter: String?
    @State private var creatingServer = false
    @State private var creatingSite = false
    @State private var importing = false
    @State private var provider: SshProvider?
    @State private var keyAction: SSHKeyAction?
    private enum SSHKeyAction: String, Identifiable { case rotate, revoke; var id: String { rawValue } }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("I tuoi server e siti").font(.title2.bold()).foregroundStyle(Theme.ink)
                    Text("Diagnosi, proposta, approvazione, esecuzione e verifica. Un timeout SSH non avvia riavvii automatici.")
                        .font(.callout).foregroundStyle(Theme.inkSecondary)
                    if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
                    if store.loading || store.busy { ProgressView(store.busy ? "Operazione in corso…" : "Carico…") }
                    if let snapshot = store.snapshot {
                        Picker("Sezione", selection: $tab) {
                            Text("Server").tag(0); Text("Siti").tag(1); Text("Operazioni").tag(2)
                        }.pickerStyle(.segmented)
                        switch tab {
                        case 0: servers(snapshot)
                        case 1: sites(snapshot)
                        default: operations(snapshot)
                        }
                    } else if !store.loading {
                        Button("Ricarica configurazione") { Task { await store.load() } }.buttonStyle(.bordered)
                    }
                }.padding(16).frame(maxWidth: 700, alignment: .leading).frame(maxWidth: .infinity)
            }
            .background(Theme.ground).navigationTitle("SSH")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .refreshable { await store.load() }
            .task { await store.load() }
            .sheet(isPresented: $creatingServer) { SSHServerEditor(store: store, input: .init(name: "", host: "")) }
            .sheet(isPresented: $creatingSite) { SSHSiteEditor(store: store, input: .init(serverId: store.snapshot?.servers.first?.id ?? "", name: "", url: "")) }
            .sheet(isPresented: $importing) { SSHImportView(store: store) }
            .sheet(item: $provider) { SSHProviderForm(store: store, provider: $0) }
            .confirmationDialog("Cambiare la chiave SSH?", isPresented: Binding(get: { keyAction != nil }, set: { if !$0 { keyAction = nil } }), titleVisibility: .visible) {
                if let action = keyAction {
                    Button(action == .rotate ? "Ruota la chiave" : "Revoca la chiave", role: .destructive) {
                        keyAction = nil
                        Task { await store.mutate(action == .rotate ? .key(rotate: true) : .revokeKey) }
                    }
                }
            } message: {
                Text("Ernie perderà l’accesso con la chiave attuale. Dopo una rotazione devi installare la nuova pubblica sui server. La vecchia pubblica va rimossa dai file authorized_keys dei server tramite un accesso amministrativo.")
            }
        }
    }
    @ViewBuilder private func servers(_ snapshot: SshSnapshot) -> some View {
        let filtered = SSHInventoryFilter.servers(snapshot.servers, query: serverSearch)
        keySection(snapshot.key)
        HStack {
            Text("Server (\(snapshot.servers.count))").font(.headline)
            Spacer()
            Button("Aggiungi", systemImage: "plus") { creatingServer = true }.buttonStyle(.bordered)
        }
        SSHSearchField(title: "Cerca nome o host", text: $serverSearch)
        Text("\(filtered.count) di \(snapshot.servers.count) server").font(.caption).foregroundStyle(Theme.inkSecondary)
        if snapshot.servers.isEmpty { Text("Aggiungi un server o importa il tuo inventario JSON.").foregroundStyle(Theme.inkSecondary) }
        else if filtered.isEmpty {
            Text("Nessun server trovato. Prova un altro nome o host.").foregroundStyle(Theme.inkSecondary)
            Button("Azzera ricerca") { serverSearch = "" }.buttonStyle(.bordered)
        }
        ForEach(filtered) { server in
            NavigationLink { SSHServerDetail(store: store, serverId: server.id) } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(server.name).font(.headline).foregroundStyle(Theme.ink)
                    Text("\(server.username)@\(server.host):\(String(server.port))").font(.caption.monospaced()).foregroundStyle(Theme.inkSecondary)
                    Label(server.fingerprint == nil ? "Identità host da verificare" : "Impronta host registrata", systemImage: server.fingerprint == nil ? "exclamationmark.shield" : "checkmark.shield")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                    if let status = server.displayLastStatus { Text(status).font(.caption).foregroundStyle(Theme.inkSecondary) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
            }.buttonStyle(.plain)
        }
        Button("Importa inventario JSON", systemImage: "square.and.arrow.down") { importing = true }.buttonStyle(.bordered)
        Text("Provider").font(.headline)
        Text("Ogni account collega le proprie credenziali. Il collegamento API è indipendente dalla chiave SSH.")
            .font(.footnote).foregroundStyle(Theme.inkSecondary)
        ForEach(SshProvider.allCases) { value in
            SSHProviderCard(provider: value, connected: snapshot.providers.first { $0.provider == value }?.connected == true,
                            checkedAt: snapshot.providers.first { $0.provider == value }?.lastCheckedAt,
                            connect: { provider = value })
        }
    }
    @ViewBuilder private func keySection(_ key: SshKeyInfo?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Chiave SSH del tuo account", systemImage: "key").font(.headline)
            if let key {
                Text("La privata resta cifrata nel backend. Questa è la pubblica da installare sui server.")
                    .font(.footnote).foregroundStyle(Theme.inkSecondary)
                Text(key.publicKey).font(.caption.monospaced()).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Copia chiave pubblica", systemImage: "doc.on.doc") { UIPasteboard.general.string = key.publicKey }
                    .buttonStyle(.bordered)
                Text("Impronta: \(key.fingerprint)").font(.caption.monospaced()).textSelection(.enabled)
                DisclosureGroup("Come installarla") {
                    Text("Accedi al server con un accesso amministrativo già funzionante. Nell’account Linux indicato nel server, crea ~/.ssh se manca, con permessi 700; aggiungi la pubblica su una riga di ~/.ssh/authorized_keys, con permessi 600. Conserva le altre chiavi e controlla proprietario e permessi. Poi confronta l’impronta host tramite una fonte attendibile e prova la connessione da Ernie.")
                        .font(.footnote).fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Button("Ruota", role: .destructive) { keyAction = .rotate }
                    Spacer()
                    Button("Revoca", role: .destructive) { keyAction = .revoke }
                }.disabled(store.busy)
            } else {
                Text("Genera una chiave personale. Ernie mostrerà soltanto la pubblica da installare; nessuna password SSH viene richiesta.")
                    .font(.callout).foregroundStyle(Theme.inkSecondary)
                Button("Genera chiave SSH", systemImage: "key.fill") { Task { await store.mutate(.key(rotate: false)) } }
                    .buttonStyle(.borderedProminent).disabled(store.busy)
            }
        }.padding(16).background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
    }
    @ViewBuilder private func sites(_ snapshot: SshSnapshot) -> some View {
        let filtered = SSHInventoryFilter.sites(snapshot.sites, servers: snapshot.servers, query: siteSearch, serverId: siteServerFilter)
        Button("Aggiungi sito", systemImage: "plus") { creatingSite = true }.buttonStyle(.bordered)
            .disabled(snapshot.servers.isEmpty)
        SSHSearchField(title: "Cerca nome, URL, host o percorso", text: $siteSearch)
        Picker("Filtra per server", selection: $siteServerFilter) {
            Text("Tutti i server").tag(nil as String?)
            if let selectedId = siteServerFilter, !snapshot.servers.contains(where: { $0.id == selectedId }) {
                Text("Server non più disponibile").tag(Optional(selectedId))
            }
            ForEach(snapshot.servers.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }) { server in
                Text(server.name).tag(Optional(server.id))
            }
        }
        Text("\(filtered.count) di \(snapshot.sites.count) siti").font(.caption).foregroundStyle(Theme.inkSecondary)
        if snapshot.sites.isEmpty { Text("Collega i siti ai tuoi server e completa percorso WordPress ed eventuale container.").foregroundStyle(Theme.inkSecondary) }
        else if filtered.isEmpty {
            Text("Nessun sito corrisponde ai filtri.").foregroundStyle(Theme.inkSecondary)
            Button("Azzera filtri") { siteSearch = ""; siteServerFilter = nil }.buttonStyle(.bordered)
        }
        ForEach(filtered) { site in
            NavigationLink { SSHSiteDetail(store: store, siteId: site.id) } label: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(site.name).font(.headline).foregroundStyle(Theme.ink)
                    Text(site.url).font(.caption).foregroundStyle(Theme.inkSecondary)
                    Text(snapshot.servers.first { $0.id == site.serverId }?.name ?? "Server da verificare")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                    if site.path.isEmpty { Label("Percorso WordPress mancante", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(Theme.inkSecondary) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
            }.buttonStyle(.plain)
        }
    }
    @ViewBuilder private func operations(_ snapshot: SshSnapshot) -> some View {
        if snapshot.operations.isEmpty { Text("Le proposte di intervento compariranno qui, prima dell’esecuzione.").foregroundStyle(Theme.inkSecondary) }
        ForEach(snapshot.operations) { operation in
            SSHOperationView(operation: operation, canDecide: store.canDecide(operation), busy: store.busy,
                             approve: { Task { await store.decide(operation, approve: true) } },
                             reject: { Task { await store.decide(operation, approve: false) } },
                             refresh: { Task { await store.refreshOperation(operation.id) } })
        }
    }
}

private struct SSHSearchField: View {
    let title: String
    @Binding var text: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.inkSecondary).accessibilityHidden(true)
            TextField(title, text: $text).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel(title)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.plain).foregroundStyle(Theme.inkSecondary).accessibilityLabel("Cancella ricerca")
            }
        }.padding(.horizontal, 12).padding(.vertical, 4)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct SSHNotice: View {
    let text: String
    var symbol = "info.circle"
    init(_ text: String, symbol: String = "info.circle") { self.text = text; self.symbol = symbol }
    var body: some View {
        Label(text, systemImage: symbol).font(.callout).foregroundStyle(Theme.inkSecondary)
            .fixedSize(horizontal: false, vertical: true).padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceMuted, in: RoundedRectangle(cornerRadius: 12))
    }
}

struct SSHProviderCard: View {
    let provider: SshProvider
    let connected: Bool
    let checkedAt: String?
    var connect: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(provider.title).font(.headline)
            Label(connected ? "Account collegato" : "Non collegato", systemImage: connected ? "checkmark.circle" : "link")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
            if let checkedAt { Text("Ultima verifica: \(SSHFormatting.timestamp(checkedAt))").font(.caption).foregroundStyle(Theme.inkSecondary) }
            Button(connected ? "Gestisci collegamento" : "Collega account", action: connect).buttonStyle(.bordered)
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
    }
}

struct SSHOperationView: View {
    let operation: SshOperation
    let canDecide: Bool
    let busy: Bool
    var approve: () -> Void
    var reject: () -> Void
    var refresh: () -> Void
    @State private var confirmingApproval = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(operation.title).font(.headline)
            Label(operation.status.title, systemImage: operation.status == .uncertain ? "questionmark.circle" : "circle.fill")
                .font(.caption.weight(.semibold)).foregroundStyle(operation.status == .succeeded ? Theme.positive : Theme.inkSecondary)
            Text("\(operation.serverName) · \(operation.host)").font(.subheadline).textSelection(.enabled)
            Text(operation.kind.title).font(.caption).foregroundStyle(Theme.inkSecondary)
            Text(operation.reason).font(.callout)
            if operation.kind == .providerReboot { SSHNotice("Riavvio fuori banda del server associato: tutti i servizi ospitati possono subire un’interruzione.") }
            field("Comando", value: operation.command.isEmpty ? "Azione strutturata del provider" : operation.command, code: true)
            field("Verifica", value: operation.verificationCommand.isEmpty ? "Controllo strutturato dello stato" : operation.verificationCommand, code: true)
            field("Backup", value: operation.backup)
            field("Rollback / recupero", value: operation.rollback)
            Text("Scade: \(SSHFormatting.timestamp(operation.expiresAt))").font(.caption).foregroundStyle(Theme.inkSecondary)
            if operation.status == .uncertain { SSHNotice(SSHFormatting.uncertain, symbol: "exclamationmark.triangle") }
            if let output = operation.output, !output.isEmpty {
                DisclosureGroup("Esito e verifica") { Text(output).font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                if canDecide && operation.canDecide(now: context.date) {
                    ViewThatFits(in: .horizontal) {
                        HStack { decisionButtons }
                        VStack(alignment: .leading) { decisionButtons }
                    }.disabled(busy)
                } else if operation.status == .pending && !operation.canDecide(now: context.date) {
                    Text("Scadenza raggiunta: verifica lo stato e prepara una nuova proposta se necessaria.").font(.footnote).foregroundStyle(Theme.inkSecondary)
                }
            }
            Button("Verifica stato", systemImage: "arrow.clockwise", action: refresh).buttonStyle(.bordered).disabled(busy)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
            .confirmationDialog("Approvare l’intervento mostrato?", isPresented: $confirmingApproval, titleVisibility: .visible) {
                Button("Approva ed esegui", role: operation.kind == .providerReboot ? .destructive : nil, action: approve)
            } message: { Text("Bersaglio: \(operation.serverName) (\(operation.host)). L’approvazione riguarda questa proposta, con questi comandi, backup e recupero.") }
    }
    @ViewBuilder private var decisionButtons: some View {
        Button("Approva", systemImage: "checkmark.shield") { confirmingApproval = true }.buttonStyle(.borderedProminent)
        Button("Rifiuta", role: .destructive, action: reject).buttonStyle(.bordered)
    }
    private func field(_ title: String, value: String, code: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(Theme.inkSecondary)
            Text(value).font(code ? .caption.monospaced() : .callout).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
}
