import AVFoundation
import Observation
import UIKit
import SwiftUI
import UniformTypeIdentifiers

struct ChatArchiveLibraryView: View {
    @Environment(\.chatPalette) private var palette
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var archives: [ChatArchive] = []
    @State private var total = 0
    @State private var search = ""
    @State private var loading = false
    @State private var error: String?
    @State private var importFile = false
    @State private var manageSkills = false
    @State private var importJob: ChatArchiveImportJob?
    @State private var report: ChatArchiveImportResult?
    @State private var generation = UUID()

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).foregroundStyle(.red); Button("Riprova") { Task { await load() } }; Button("Gestisci skill") { manageSkills = true } }
                }
                if let report {
                    Section("Importazione completata") {
                        Text(report.archive.name).font(.headline)
                        Text("\(report.insertedCount) nuovi · \(report.duplicateCount) già presenti")
                        if report.unparsedCount > 0 { Text("\(report.unparsedCount) righe da verificare").foregroundStyle(.orange) }
                        ForEach(Array(report.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.footnote) }
                    }
                }
                if archives.isEmpty && !loading && error == nil {
                    ContentUnavailableView("Le tue chat archiviate", systemImage: "bubble.left.and.text.bubble.right",
                        description: Text("Esporta una chat WhatsApp senza media e importa il TXT o lo ZIP. I testi restano sul tuo backend Ernie."))
                    Button("Importa chat", systemImage: "square.and.arrow.down") { importFile = true }
                }
                ForEach(archives) { archive in
                    NavigationLink {
                        ChatArchiveDetailView(id: archive.id).onDisappear { Task { await load() } }
                    } label: {
                        ChatArchiveCatalogRow(archive: archive)
                    }
                }
                if loading { ProgressView().frame(maxWidth: .infinity) }
                if archives.count < total && !loading { Button("Carica altre chat") { Task { await load(more: true) } } }
            }
            .navigationTitle("Archivio chat")
            .searchable(text: $search, prompt: "Cerca chat, categoria o tag")
            .refreshable { await load() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fine") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("Importa", systemImage: "plus") { importFile = true } }
            }
            .sheet(isPresented: $manageSkills, onDismiss: { Task { await load() } }) { SkillsSheet() }
            .fileImporter(isPresented: $importFile, allowedContentTypes: [.plainText, .zip], allowsMultipleSelection: false) { result in
                if case .success(let files) = result, let file = files.first { importJob = .init(url: file, queued: nil) }
                if case .failure(let failure) = result { error = ChatArchivePresentation.error(failure) }
            }
            .sheet(item: $importJob) { job in
                ChatArchiveImportView(job: job) { result in
                    report = result
                    Task { await load() }
                }
            }
            .task(id: search) {
                if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
                guard !Task.isCancelled else { return }; await load()
            }
            .task(id: model.credentials) {
                generation = UUID(); archives = []; report = nil; error = nil
                await load(); await model.processShareInbox(); consumePendingImport()
            }
            .onChange(of: model.pendingChatArchiveImport?.id) { consumePendingImport() }
        }
        .tint(palette.accentText)
    }

    private func consumePendingImport() {
        guard importJob == nil, let job = model.pendingChatArchiveImport,
              job.owner == model.credentials.map({ ShareInbox.ownerScope(serverURL: $0.serverURL, apiKey: $0.apiKey) }) else { return }
        importJob = .init(url: job.url, queued: job.item)
        model.pendingChatArchiveImport = nil
    }
    private func load(more: Bool = false) async {
        guard let api = model.api else { archives = []; return }
        let token = UUID(); generation = token
        loading = true; error = nil
        let offset = more ? archives.count : 0
        do {
            let page = try await api.chatArchives(query: search, offset: offset)
            guard generation == token, model.credentials == api.credentials, !Task.isCancelled else { return }
            if more { archives += page.archives } else { archives = page.archives }
            total = page.total
        } catch {
            guard generation == token, model.credentials == api.credentials, !Task.isCancelled else { return }
            self.error = ChatArchivePresentation.error(error)
        }
        if generation == token { loading = false }
    }
}

struct ChatArchiveImportJob: Identifiable {
    let id = UUID()
    var url: URL
    var queued: ShareInbox.Item?
}
struct PendingChatArchiveImport: Identifiable {
    let id: String
    let url: URL
    let owner: String
    let item: ShareInbox.Item
}

struct ChatArchiveImportView: View {
    let job: ChatArchiveImportJob
    var onImported: (ChatArchiveImportResult) -> Void
    @Environment(\.chatPalette) private var palette
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var input: ChatArchiveImportInput?
    @State private var preview: ChatArchivePreview?
    @State private var selection = "new"
    @State private var otherSelection: ChatArchive?
    @State private var name = ""
    @State private var kind = "direct"
    @State private var busy = false
    @State private var error: String?
    @State private var owner: Credentials?
    @State private var showDiscard = false
    var body: some View {
        NavigationStack {
            Form {
                if busy { ProgressView(preview == nil ? "Leggo il testo e cerco la chat…" : "Importazione in corso…") }
                if let error { Text(error).foregroundStyle(.red) }
                if let preview {
                    Section("Testo rilevato") {
                        Text("\(preview.parsedCount) messaggi · \(preview.participants.count) mittenti")
                        Text("Da \(ChatArchivePresentation.date(preview.firstMessageAt)) a \(ChatArchivePresentation.date(preview.latestMessageAt))")
                            .font(.footnote).foregroundStyle(.secondary)
                        Text("Vengono importati solo i testi, senza foto, video e vocali.").font(.footnote)
                    }
                    Section("Dove importare") {
                        Picker("Conversazione", selection: $selection) {
                            Text("Crea una nuova chat").tag("new")
                            if let otherSelection, !preview.candidates.contains(where: { $0.id == otherSelection.id }) { Text(otherSelection.name).tag(otherSelection.id) }
                            ForEach(preview.candidates) { candidate in
                                Text("\(candidate.archive.name) · \(candidate.newCount) nuovi").tag(candidate.id)
                            }
                        }
                        if selection == "new" {
                            TextField("Nome della chat", text: $name)
                            Picker("Tipo", selection: $kind) { Text("Conversazione privata").tag("direct"); Text("Gruppo").tag("group") }
                        }
                        if preview.candidates.isEmpty { Text("Non ho trovato sovrapposizioni certe. Puoi scegliere una chat dall’elenco completo.").font(.footnote).foregroundStyle(.secondary) }
                        ChatArchiveDestinationPicker(selection: $selection, selectedArchive: $otherSelection, known: preview.candidates.map(\.archive))
                    }
                    if preview.warningCount > 0 || preview.unparsedCount > 0 {
                        Section("Da verificare") {
                            if preview.unparsedCount > 0 { Text("\(preview.unparsedCount) righe non riconosciute, conservate nell’import.") }
                            ForEach(Array(preview.warnings.enumerated()), id: \.offset) { _, warning in Text(warning).font(.footnote) }
                        }
                    }
                    Section {
                        Text("Il file e i testi vengono conservati nel tuo account sul backend Ernie. Questa importazione non avvia l’AI.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Conferma importazione") { Task { await commit() } }
                            .disabled(busy || (selection == "new" && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                    }
                } else if !busy { Button("Riprova") { Task { await prepare() } } }
            }
            .navigationTitle("Importa chat").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { dismiss() }.disabled(busy) }
                if job.queued != nil { ToolbarItem(placement: .destructiveAction) { Button("Scarta", role: .destructive) { showDiscard = true }.disabled(busy) } }
            }
            .confirmationDialog("Scartare il file condiviso?", isPresented: $showDiscard, titleVisibility: .visible) {
                Button("Scarta file", role: .destructive) { if let item = job.queued { ShareInbox.remove(item) }; dismiss() }
            }
            .task { await prepare() }
            .onChange(of: model.credentials) { input = nil; preview = nil; dismiss() }
            .interactiveDismissDisabled(busy)
        }.tint(palette.accentText)
    }
    private func prepare() async {
        guard let api = model.api else { return }
        owner = api.credentials; busy = true; error = nil
        do {
            let input = try await ChatArchiveImportInput.read(job.url)
            let result = try await api.previewChatArchive(input)
            guard owner == model.credentials, !Task.isCancelled else { return }
            self.input = input; preview = result; name = result.name; kind = result.kind
            selection = result.suggestedArchiveId ?? "new"
        } catch {
            guard owner == model.credentials, !Task.isCancelled else { return }
            self.error = ChatArchivePresentation.error(error)
        }
        busy = false
    }
    private func commit() async {
        guard let api = model.api, api.credentials == owner, let input else { return }
        busy = true; error = nil
        do {
            let result = try await api.importChatArchive(input.choosing(archiveId: selection == "new" ? nil : selection, newName: name, kind: kind))
            guard api.credentials == model.credentials, !Task.isCancelled else { return }
            if let item = job.queued { ShareInbox.remove(item) }
            self.input = nil; onImported(result); dismiss()
        } catch {
            guard api.credentials == model.credentials, !Task.isCancelled else { return }
            self.error = ChatArchivePresentation.error(error)
        }
        busy = false
    }
}

private struct ChatArchiveDestinationPicker: View {
    @Binding var selection: String
    @Binding var selectedArchive: ChatArchive?
    var known: [ChatArchive]
    @Environment(\.chatPalette) private var palette
    @Environment(AppModel.self) private var model
    @State private var all: [ChatArchive] = []
    @State private var search = ""
    @State private var error: String?
    var body: some View {
        DisclosureGroup("Scegli un’altra chat esistente") {
            TextField("Cerca una chat", text: $search)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            ForEach(all.filter { item in !known.contains { $0.id == item.id } }) { archive in
                Button { selectedArchive = archive; selection = archive.id } label: {
                    VStack(alignment: .leading, spacing: 4) { HStack { Text(archive.name); Spacer(); if selection == archive.id { Image(systemName: "checkmark") } }; if let summary = archive.summary { Text(summary).font(.caption).lineLimit(2) }; Text("\(archive.kind == "group" ? "Gruppo" : "Privata") · ultimo import \(ChatArchivePresentation.date(archive.lastImportedAt))").font(.caption).foregroundStyle(.secondary) }
                }
            }
        }
        .task(id: search) {
            guard let api = model.api else { return }
            if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            do {
                let result = try await api.chatArchives(query: search)
                guard model.credentials == api.credentials, !Task.isCancelled else { return }; all = result.archives; error = nil
            } catch { if !Task.isCancelled { self.error = ChatArchivePresentation.error(error) } }
        }
    }
}

struct ChatArchiveDetailView: View {
    let id: String
    var initialQuestion: String? = nil
    @Environment(\.chatPalette) private var palette
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var detail: ChatArchiveDetail?
    @State private var messages: [ChatArchiveMessage] = []
    @State private var messageTotal = 0
    @State private var messageQuery = ""
    @State private var senderId = ""
    @State private var dateFilter = false
    @State private var from = Calendar.current.startOfDay(for: .now)
    @State private var through = Date()
    @State private var tab = "ask"
    @State private var loading = false
    @State private var asking = false
    @State private var error: String?
    @State private var question = ""
    @State private var mode = "question"
    @State private var answeredMode = "question"
    @State private var askGeneration = UUID()
    @State private var result: ChatArchiveAnswer?
    @State private var source: ChatArchiveMessage?
    @State private var consent = false
    @State private var editing = false
    @State private var deleting = false
    @State private var compose = false
    @State private var brainExport = false
    @State private var generation = UUID()
    @State private var aiTask: Task<Void, Never>?
    @State private var dictation = ChatArchiveDictation()
    @State private var speech = ChatArchiveSpeech()
    @State private var followups: [ChatArchiveAskInput.History] = []
    private var observedContent: some View {
        VStack(spacing: 0) {
            if let archive = detail?.archive {
                Picker("Contenuto", selection: $tab) {
                    Text("Chiedi").tag("ask"); Text("Messaggi").tag("messages"); Text("Persone").tag("people")
                }.pickerStyle(.segmented).padding()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let summary = archive.summary, !summary.isEmpty { Text(summary).font(.subheadline).foregroundStyle(.secondary) }
                        freshness(archive)
                        if let error { Text(error).foregroundStyle(.red) }
                        if tab == "ask" { askArea(archive) }
                        else if tab == "people" { people }
                        else { messageArea }
                    }.padding()
                }.refreshable { await load() }
            } else if loading { ProgressView() }
            else { ContentUnavailableView("Chat non disponibile", systemImage: "bubble.left", description: Text(error ?? "Riprova tra poco.")); Button("Riprova") { Task { await load() } } }
        }
        .navigationTitle(detail?.archive.name ?? "Chat").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Modifica scheda", systemImage: "pencil") { editing = true }
                    Button("Apri o scrivi su WhatsApp", systemImage: "arrow.up.forward.app") { compose = true }
                    Button("Elimina archivio", systemImage: "trash", role: .destructive) { deleting = true }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .task { if question.isEmpty { question = initialQuestion ?? "" }; await load() }
        .onChange(of: senderId) { invalidateSelection() }
        .onChange(of: dateFilter) { invalidateSelection() }
        .onChange(of: from) { invalidateSelection() }
        .onChange(of: through) { invalidateSelection() }
        .onChange(of: tab) { if tab == "messages" { Task { await loadMessages() } } }
        .onChange(of: model.credentials) { aiTask?.cancel(); dictation.stop(); speech.stop(); detail = nil; messages = []; result = nil; followups = []; dismiss() }
        .onChange(of: scenePhase) { if scenePhase != .active { if !dictation.requestingPermission { dictation.stop() }; speech.stop() } }
        .onDisappear { aiTask?.cancel(); dictation.stop(); speech.stop() }
    }
    var body: some View {
        observedContent
        .confirmationDialog("Inviare questa domanda e gli estratti pertinenti al modello AI configurato in Ernie?", isPresented: $consent, titleVisibility: .visible) {
            Button("Analizza questa chat") { aiTask = Task { await ask() } }
        } message: { Text("L’analisi usa token. I testi di altre chat e la memoria generale non vengono inclusi.") }
        .confirmationDialog("Eliminare questa chat e tutti i suoi messaggi dal tuo archivio Ernie?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Elimina archivio", role: .destructive) { Task { await remove() } }
        } message: { Text("La conversazione originale su WhatsApp resta disponibile.") }
        .sheet(item: $source) { ChatArchiveSourceView(archiveId: id, message: $0) }
        .sheet(isPresented: $editing, onDismiss: { Task { await load() } }) { if let archive = detail?.archive { ChatArchiveEditor(archive: archive) } }
        .sheet(isPresented: $compose) { if let archive = detail?.archive { ChatArchiveWhatsAppView(archive: archive) } }
        .sheet(isPresented: $brainExport) { if let archive = detail?.archive, let result { ChatArchiveBrainExportView(archive: archive, answer: result) } }
        .tint(palette.accentText)
    }
    private func freshness(_ archive: ChatArchive) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(archive.indexReady ? "Indice aggiornato" : "Indice in aggiornamento", systemImage: archive.indexReady ? "checkmark.circle" : "clock")
                .font(.subheadline.weight(.semibold)).foregroundStyle(archive.indexReady ? palette.positive : .orange)
            Text("Ultimo import: \(ChatArchivePresentation.date(archive.lastImportedAt))")
            Text("Ultimo messaggio disponibile: \(ChatArchivePresentation.date(archive.latestMessageAt))")
            Text("Indice: \(ChatArchivePresentation.date(archive.indexedAt)) · revisione \(archive.indexedRevision)")
            Text("\(archive.messageCount) messaggi · fuso \(archive.timeZone)")
        }.font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding().ernieSurface()
    }
    private var people: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Partecipanti osservati nell’archivio").font(.headline)
            Text("I nomi provengono dai messaggi importati; non rappresentano necessariamente i membri attuali del gruppo.").font(.footnote).foregroundStyle(.secondary)
            ForEach(detail?.participants ?? []) { participant in
                VStack(alignment: .leading, spacing: 4) {
                    Text(participant.name).font(.headline)
                    Text("\(participant.messageCount) messaggi").font(.subheadline)
                    Text("Dal \(ChatArchivePresentation.date(participant.firstMessageAt)) al \(ChatArchivePresentation.date(participant.lastMessageAt))")
                        .font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding().ernieSurface()
            }
        }
    }
    private var filters: some View {
        VStack(alignment: .leading, spacing: 9) {
            Picker("Mittente", selection: $senderId) {
                Text("Tutti i mittenti").tag("")
                ForEach(detail?.participants ?? []) { Text($0.name).tag($0.id) }
            }
            Toggle("Limita il periodo", isOn: $dateFilter)
            if dateFilter {
                DatePicker("Dal", selection: $from, displayedComponents: .date)
                DatePicker("Al", selection: $through, in: from..., displayedComponents: .date)
            }
        }.font(.subheadline)
    }
    private func askArea(_ archive: ChatArchive) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Chiedi a Ernie su questa chat").font(.headline)
            Text("Le risposte si basano solo su «\(archive.name)» e indicano i messaggi usati.").font(.footnote).foregroundStyle(.secondary)
            filters
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach([( "24h", "Ultime 24 ore"), ("7d", "Ultimi 7 giorni"), ("decisions", "Decisioni"), ("tasks", "Da fare"), ("dates", "Date e orari"), ("brief", "Brief")], id: \.0) { key, label in
                        Button(label) { mode = key; question = label; dictation.stop(); consent = true }.buttonStyle(.bordered).disabled(asking)
                    }
                }
            }
            TextField("Che cosa vuoi sapere?", text: $question, axis: .vertical).lineLimit(2...6).textFieldStyle(.roundedBorder)
                .disabled(asking).accessibilityLabel("Domanda sulla chat selezionata")
            HStack {
                Button(dictation.recording ? "Ferma dettatura" : "Detta", systemImage: dictation.recording ? "stop.circle" : "mic") {
                    if dictation.recording { dictation.stop() } else { speech.stop(); dictation.start(prefix: question) { question = $0 } }
                }.disabled(asking)
                Spacer()
                if asking {
                    Button("Annulla") { aiTask?.cancel(); askGeneration = UUID(); asking = false }
                } else {
                    Button("Chiedi a Ernie", systemImage: "arrow.up.circle.fill") { mode = "question"; dictation.stop(); consent = true }
                        .buttonStyle(.borderedProminent).disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || question.count > 4000)
                }
            }
            if let error = dictation.error { Text(error).font(.footnote).foregroundStyle(.red) }
            if asking { ProgressView("Ernie legge le fonti…") }
            if let result {
                Divider()
                Text(result.answer).textSelection(.enabled)
                if result.coverage.partial { Label("Risposta basata su una selezione dei messaggi disponibili", systemImage: "info.circle").font(.footnote).foregroundStyle(.orange) }
                ForEach(Array(result.uncertainties.enumerated()), id: \.offset) { _, text in Text(text).font(.footnote).foregroundStyle(.secondary) }
                Text("Fonti dell’archivio fino al \(ChatArchivePresentation.date(result.coverage.latestMessageAt)) · \(result.coverage.usedCount) messaggi usati")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button(speech.speaking ? "Ferma lettura" : "Ascolta", systemImage: speech.speaking ? "stop.circle" : "speaker.wave.2") {
                        dictation.stop(); if speech.speaking { speech.stop() } else { speech.read(result.answer) }
                    }
                    if speech.speaking { Button(speech.paused ? "Riprendi" : "Pausa") { speech.togglePause() } }
                }
                if !result.sources.isEmpty {
                    Text("Messaggi citati").font(.headline)
                    ForEach(result.sources) { message in
                        Button { source = message } label: { ChatArchiveMessageRow(message: message).contentShape(Rectangle()) }.buttonStyle(.plain)
                    }
                }
                if answeredMode == "brief" { Button("Usa come descrizione della chat") { Task { await saveBrief(result.answer) } } }
                Button("Salva nel Second Brain…", systemImage: "brain.head.profile") { brainExport = true }
                Text("Modello: \(result.model)").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
    private var messageArea: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Cerca nei messaggi", text: $messageQuery).textFieldStyle(.roundedBorder)
            filters
            Button("Applica filtri") { Task { await loadMessages() } }
            if loading { ProgressView() }
            Text("\(messageTotal) messaggi trovati").font(.caption).foregroundStyle(.secondary)
            ForEach(messages) { message in ChatArchiveMessageRow(message: message) }
            if messages.count < messageTotal { Button("Carica altri messaggi") { Task { await loadMessages(more: true) } }.disabled(loading) }
        }
    }
    private func dates() -> (String?, String?) {
        guard dateFilter else { return (nil, nil) }
        return (Calendar.current.startOfDay(for: from).ISO8601Format(), Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: through))?.ISO8601Format())
    }
    private func load() async {
        guard let api = model.api else { return }
        let token = UUID(); generation = token; loading = true; error = nil
        do {
            let value = try await api.chatArchive(id)
            guard generation == token, api.credentials == model.credentials, !Task.isCancelled else { return }
            if let previous = detail?.archive,
               previous.revision != value.archive.revision || previous.lastImportedAt != value.archive.lastImportedAt {
                invalidateSelection()
            }
            if let result, result.coverage.revision != value.archive.revision { invalidateSelection() }
            detail = value
        } catch { if generation == token, api.credentials == model.credentials { self.error = ChatArchivePresentation.error(error) } }
        if generation == token { loading = false }
    }
    private func loadMessages(more: Bool = false) async {
        guard let api = model.api else { return }
        let token = UUID(); generation = token; loading = true; error = nil
        let dates = dates()
        do {
            let page = try await api.chatArchiveMessages(id, query: messageQuery, senderId: senderId.isEmpty ? nil : senderId,
                from: dates.0, to: dates.1, offset: more ? messages.count : 0)
            guard generation == token, api.credentials == model.credentials, !Task.isCancelled else { return }
            if more { messages += page.messages } else { messages = page.messages }; messageTotal = page.total
        } catch { if generation == token, api.credentials == model.credentials { self.error = ChatArchivePresentation.error(error) } }
        if generation == token { loading = false }
    }
    private func ask() async {
        guard let api = model.api else { return }
        let token = UUID(); askGeneration = token
        asking = true; error = nil; dictation.stop(); speech.stop()
        defer { if askGeneration == token { asking = false } }
        let dates = dates(), sent = question, sentMode = mode
        let request = ChatArchiveAskInput(question: sent, mode: sentMode, from: dates.0, to: dates.1,
            senderId: senderId.isEmpty ? nil : senderId, history: followups)
        do {
            let value = try await api.askChatArchive(id, input: request)
            guard askGeneration == token, api.credentials == model.credentials, !Task.isCancelled else { return }
            result = value; answeredMode = sentMode
            followups = Array((followups + [.init(question: sent, answer: value.answer)]).suffix(4))
        } catch { if askGeneration == token, !Task.isCancelled, api.credentials == model.credentials { self.error = ChatArchivePresentation.error(error) } }
    }
    private func invalidateSelection() {
        aiTask?.cancel(); askGeneration = UUID(); asking = false
        result = nil; followups = []; speech.stop()
    }
    private func saveBrief(_ text: String) async {
        guard let api = model.api, let archive = detail?.archive else { return }
        do {
            let updated = try await api.updateChatArchive(id, input: .init(name: archive.name,
                summary: String(text.prefix(600)), kind: archive.kind, category: archive.category, tags: archive.tags,
                whatsappPhone: archive.whatsappPhone, whatsappUrl: archive.whatsappUrl))
            guard api.credentials == model.credentials else { return }; detail?.archive = updated
        } catch { self.error = ChatArchivePresentation.error(error) }
    }
    private func remove() async {
        guard let api = model.api else { return }
        do { try await api.deleteChatArchive(id); guard api.credentials == model.credentials else { return }; dismiss() }
        catch { self.error = ChatArchivePresentation.error(error) }
    }
}

struct ChatArchiveMessageRow: View {
    var message: ChatArchiveMessage
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message.sender ?? "Messaggio di sistema").font(.subheadline.weight(.semibold))
            Text(ChatArchivePresentation.date(message.at)).font(.caption).foregroundStyle(.secondary)
            Text(message.type == "media" ? "Allegato non importato: \(message.text)" : message.rawText)
                .font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading).padding().ernieSurface()
    }
}

private struct ChatArchiveSourceView: View {
    let archiveId: String
    let message: ChatArchiveMessage
    @Environment(\.chatPalette) private var palette
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var nearby: [ChatArchiveMessage] = []
    @State private var error: String?
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if let error { Text(error).foregroundStyle(.red) }
                        ForEach(nearby.isEmpty ? [message] : nearby) { item in
                            ChatArchiveMessageRow(message: item).id(item.id)
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(item.id == message.id ? Theme.accent : .clear, lineWidth: 2))
                        }
                    }.padding()
                }
                .task {
                    guard let api = model.api else { return }
                    do {
                        let page = try await api.chatArchiveMessages(archiveId, aroundId: message.id)
                        guard model.credentials == api.credentials, !Task.isCancelled else { return }; nearby = page.messages
                        try? await Task.sleep(for: .milliseconds(100)); proxy.scrollTo(message.id, anchor: .center)
                    } catch { self.error = ChatArchivePresentation.error(error) }
                }
            }
            .navigationTitle("Messaggio originale").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
        }.tint(palette.accentText)
    }
}

private struct ChatArchiveEditor: View {
    let archive: ChatArchive
    @Environment(\.chatPalette) private var palette
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
@State private var summary = ""
@State private var kind = "direct"
@State private var category = ""
@State private var tags = ""
@State private var phone = ""
@State private var url = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Scheda") {
                    TextField("Nome", text: $name)
                    TextField("Breve descrizione della chat", text: $summary, axis: .vertical).lineLimit(2...5)
                    Text("\(summary.count)/600 caratteri").font(.caption).foregroundStyle(.secondary)
                    Picker("Tipo", selection: $kind) { Text("Conversazione privata").tag("direct"); Text("Gruppo").tag("group") }
                    TextField("Categoria", text: $category)
                    TextField("Tag separati da virgole", text: $tags)
                }
                Section("Collegamento a WhatsApp") {
                    if kind == "direct" { TextField("Numero internazionale, es. +393331234567", text: $phone).keyboardType(.phonePad) }
                    TextField("Link ufficiale del gruppo o canale", text: $url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Per i gruppi puoi salvare il link d’invito. Il nome dell’archivio non permette di ricavare un collegamento diretto.").font(.footnote).foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Modifica chat").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) { Button("Salva") { Task { await save() } }.disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || summary.count > 600) }
            }
            .onAppear { name = archive.name; summary = archive.summary ?? ""; kind = archive.kind; category = archive.category ?? ""; tags = archive.tags.joined(separator: ", "); phone = archive.whatsappPhone ?? ""; url = archive.whatsappUrl ?? "" }
        }
    }
    private func save() async {
        guard let api = model.api else { return }
        let rawPhone = phone.trimmingCharacters(in: .whitespacesAndNewlines), rawURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawPhone.isEmpty && ChatArchiveWhatsApp.phone(rawPhone) == nil { error = ChatArchiveInputError.invalidLink.localizedDescription; return }
        if !rawURL.isEmpty && ChatArchiveWhatsApp.safeURL(rawURL) == nil { error = ChatArchiveInputError.invalidLink.localizedDescription; return }
        busy = true
        do {
            _ = try await api.updateChatArchive(archive.id, input: .init(name: name, summary: summary.isEmpty ? nil : summary, kind: kind,
                category: category.isEmpty ? nil : category, tags: RecipePresentation.tags(tags),
                whatsappPhone: rawPhone.isEmpty || kind != "direct" ? nil : ChatArchiveWhatsApp.phone(rawPhone), whatsappUrl: rawURL.isEmpty ? nil : rawURL))
            guard model.credentials == api.credentials else { return }; dismiss()
        } catch { self.error = ChatArchivePresentation.error(error) }
        busy = false
    }
}

private struct ChatArchiveWhatsAppView: View {
    let archive: ChatArchive
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var draft = ""
    @State private var share = false
    var body: some View {
        NavigationStack {
            Form {
                Section(archive.name) {
                    if let link = ChatArchiveWhatsApp.compose(phone: archive.kind == "direct" ? archive.whatsappPhone : nil)
                        ?? ChatArchiveWhatsApp.safeURL(archive.whatsappUrl) {
                        Button("Apri in WhatsApp", systemImage: "arrow.up.forward.app") { openURL(link) }
                    } else { Text("Aggiungi un numero o un link WhatsApp in Modifica scheda.").foregroundStyle(.secondary) }
                }
                Section("Prepara un messaggio") {
                    TextField("Testo da scrivere", text: $draft, axis: .vertical).lineLimit(3...10)
                    if archive.kind == "direct", let link = ChatArchiveWhatsApp.compose(phone: archive.whatsappPhone, text: draft) {
                        Button("Apri la bozza su WhatsApp") { openURL(link) }.disabled(draft.isEmpty || draft.count > 4000)
                    }
                    Button("Condividi e scegli la chat", systemImage: "square.and.arrow.up") { share = true }.disabled(draft.isEmpty)
                    Button("Copia testo", systemImage: "doc.on.doc") { UIPasteboard.general.string = draft }.disabled(draft.isEmpty)
                    Text("Controlla la chat di destinazione e premi Invia in WhatsApp. Per gruppi e canali il link può aprire un invito o una pagina: scegli la destinazione nel foglio Condividi.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("WhatsApp").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .sheet(isPresented: $share) { ActivityView(items: [draft]) }
        }
    }
}

@MainActor @Observable final class ChatArchiveSpeech {
    @ObservationIgnored private let synth = AVSpeechSynthesizer()
    @ObservationIgnored private var completion: Task<Void, Never>?
    private(set) var speaking = false
    private(set) var paused = false
    func read(_ text: String) {
        stop()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "it-IT")
        synth.speak(utterance); speaking = true
        completion = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            while let self, !Task.isCancelled, self.synth.isSpeaking || self.synth.isPaused {
                try? await Task.sleep(for: .milliseconds(200))
            }
            guard !Task.isCancelled else { return }
            self?.speaking = false; self?.paused = false
        }
    }
    func stop() { completion?.cancel(); completion = nil; synth.stopSpeaking(at: .immediate); speaking = false; paused = false }
    func togglePause() {
        if paused { synth.continueSpeaking(); paused = false } else { synth.pauseSpeaking(at: .word); paused = true }
    }
}
