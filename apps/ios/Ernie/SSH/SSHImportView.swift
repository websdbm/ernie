import SwiftUI
import UniformTypeIdentifiers

struct SSHImportView: View {
    @Bindable var store: SSHStore
    @Environment(\.dismiss) private var dismiss
    @State private var choosing = false
    @State private var inventory: SshImportInput?
    @State private var selectedServers: Set<String> = []
    @State private var selectedSites: Set<String> = []
    @State private var filename: String?
    @State private var localError: String?
    @State private var confirming = false
    private var selection: SshImportInput? { inventory?.selecting(servers: selectedServers, sites: selectedSites) }
    var body: some View {
        NavigationStack {
            Form {
                fileSection
                if let inventory {
                    Section("Fonte") { Text(inventory.source).font(.caption).textSelection(.enabled) }
                    serverSection(inventory)
                    siteSection(inventory)
                    previewButton
                }
                if let preview = store.importPreview { previewSection(preview) }
            }.navigationTitle("Importa inventario")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { dismiss() }.disabled(store.busy) } }
                .fileImporter(isPresented: $choosing, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in read(result) }
                .confirmationDialog("Importare nel tuo account?", isPresented: $confirming, titleVisibility: .visible) {
                    Button("Applica inventario selezionato") {
                        if let selection { Task { if await store.mutate(.importInventory(selection)) { dismiss() } } }
                    }
                } message: { Text("Verranno applicati solo server e siti selezionati. L’importazione non installa chiavi e non esegue comandi sui server.") }
                .onAppear { store.clearImportPreview() }
                .onDisappear { inventory = nil; selectedServers = []; selectedSites = []; store.clearImportPreview() }
                .interactiveDismissDisabled(store.busy)
        }
    }
    private var fileSection: some View {
        Section {
            Text("Importa il tuo export JSON da HF o da un inventario compatibile. Vengono trasferiti server, siti e associazioni nel tuo account, senza chiavi o password.").font(.callout)
            Text("La scelta del file lo legge sul telefono. I dati selezionati saranno inviati solo premendo Anteprima.").font(.footnote)
            Button("Scegli file JSON", systemImage: "doc") { choosing = true }.disabled(store.busy)
            if let filename { Text(filename).font(.caption) }
            if let localError { SSHNotice(localError, symbol: "exclamationmark.circle") }
            if let error = store.error { SSHNotice(error, symbol: "exclamationmark.circle") }
        }
    }
    private func serverSection(_ inventory: SshImportInput) -> some View {
        Section("Server da importare") {
            ForEach(inventory.servers) { server in
                Toggle(isOn: selected(server.sourceId, servers: true)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(server.name)
                        Text("\(server.username)@\(server.host):\(String(server.port))").font(.caption.monospaced())
                    }.fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
    private func siteSection(_ inventory: SshImportInput) -> some View {
        Section {
            ForEach(inventory.sites) { site in siteRow(site, inventory: inventory) }
        } header: { Text("Siti da importare") }
        footer: { Text("Se scegli un sito viene incluso anche il suo server. Un’importazione ripetuta usa gli ID della fonte per aggiornare gli stessi record, senza cancellare gli elementi assenti.") }
    }
    private func siteRow(_ site: SshImportInput.Site, inventory: SshImportInput) -> some View {
        let name = serverName(site.serverSourceId, in: inventory)
        return Toggle(isOn: selected(site.sourceId, servers: false)) {
            VStack(alignment: .leading, spacing: 4) {
                Text(site.name)
                Text(site.url).font(.caption)
                Text("Server: " + name).font(.caption)
            }.fixedSize(horizontal: false, vertical: true)
        }
    }
    private func serverName(_ id: String, in inventory: SshImportInput) -> String {
        inventory.servers.first(where: { $0.sourceId == id })?.name ?? id
    }
    private var previewButton: some View {
        Section {
            Button("Anteprima dei dati selezionati") {
                if let selection { Task { await store.preview(selection) } }
            }.disabled(store.previewLoading || store.busy || selection?.servers.isEmpty != false)
            if store.previewLoading { ProgressView("Verifico l’inventario…") }
        }
    }
    private func previewSection(_ preview: SshImportPreview) -> some View {
        Section("Anteprima") {
            LabeledContent("Nuovi server", value: String(preview.serversNew))
            LabeledContent("Server da aggiornare", value: String(preview.serversUpdated))
            LabeledContent("Nuovi siti", value: String(preview.sitesNew))
            LabeledContent("Siti da aggiornare", value: String(preview.sitesUpdated))
            if !preview.missing.isEmpty {
                Text("Da completare").font(.headline)
                ForEach(Array(preview.missing.enumerated()), id: \.offset) { _, value in Text(value).font(.footnote) }
            }
            Button("Applica importazione") { confirming = true }.disabled(store.busy || store.previewLoading)
        }
    }
    private func selected(_ id: String, servers: Bool) -> Binding<Bool> {
        Binding(get: { servers ? selectedServers.contains(id) : selectedSites.contains(id) }, set: { selected in
            store.clearImportPreview()
            if servers {
                if selected { selectedServers.insert(id) } else { selectedServers.remove(id) }
            } else {
                if selected { selectedSites.insert(id) } else { selectedSites.remove(id) }
            }
        })
    }
    private func read(_ result: Result<[URL], any Error>) {
        store.clearImportPreview(); localError = nil
        do {
            guard let url = try result.get().first else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 8 * 1024 * 1024 else { localError = "Il file supera il limite di 8 MB."; return }
            let data = try Data(contentsOf: url)
            guard data.count <= 8 * 1024 * 1024 else { localError = "Il file supera il limite di 8 MB."; return }
            let value = try JSONDecoder().decode(SshImportInput.self, from: data)
            guard value.servers.count <= 2000, value.sites.count <= 10000,
                  Set(value.servers.map(\.sourceId)).count == value.servers.count,
                  Set(value.sites.map(\.sourceId)).count == value.sites.count else {
                localError = "L’inventario supera i limiti o contiene ID duplicati."; return
            }
            inventory = value; filename = url.lastPathComponent
            selectedServers = Set(value.servers.map(\.sourceId)); selectedSites = Set(value.sites.map(\.sourceId))
        } catch { localError = "File non leggibile o formato non valido. Usa un export JSON dell’inventario, senza chiavi o password." }
    }
}
