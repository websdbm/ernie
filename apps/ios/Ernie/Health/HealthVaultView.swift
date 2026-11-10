import PDFKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct HealthVaultView: View {
    @Bindable var store: HealthVaultStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.chatPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicType
    @State private var section = 0
    @State private var files = false
    @State private var scanner = false
    @State private var textEntry = false
    @State private var policy = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var deleteID: String?
    @State private var exportTarget: ExportTarget?
    private struct ExportTarget: Identifiable { let id = UUID(); var source: String?; var report: String? }

    var body: some View {
        NavigationStack {
            ScrollView {
                content.padding(20)
            }
            .background(palette.ground).foregroundStyle(palette.ink)
            .navigationTitle("Salute").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { store.scrub(); dismiss() } } }
            .task { await store.refresh() }
            .privacySensitive()
            .overlay { if scenePhase != .active { palette.ground.overlay { Label("Salute privata", systemImage: "lock.fill").foregroundStyle(palette.ink) }.ignoresSafeArea() } }
            .fileImporter(isPresented: $files, allowedContentTypes: [.pdf, .plainText], allowsMultipleSelection: false) { result in
                if case .success(let urls) = result, let url = urls.first { Task { await store.prepare { try await HealthVaultImporter.file(url) } } }
            }
            .onChange(of: photos) { _, selected in
                guard !selected.isEmpty else { return }
                photos = []
                Task {
                    await store.prepare {
                        var images: [UIImage] = []
                        for item in selected {
                            try Task.checkCancellation()
                            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { throw HealthVaultError.invalidImport }
                            images.append(image)
                        }
                        return try await HealthVaultImporter.images(images, source: .photo)
                    }
                }
            }
            .sheet(isPresented: $scanner) {
                DocumentScannerView(onFinish: { images in
                    scanner = false
                    Task { await store.prepare { try await HealthVaultImporter.images(images, source: .scan) } }
                }, onCancel: { scanner = false })
            }
            .sheet(isPresented: $textEntry) { HealthTextEntry { draft in store.draft = draft } }
            .sheet(isPresented: $policy) {
                NavigationStack {
                    ScrollView { VStack(alignment: .leading, spacing: 20) {
                        Text(store.capabilities?.policyText ?? "Consenso non disponibile.").fixedSize(horizontal: false, vertical: true)
                        Button("Autorizzo l’analisi AI") { policy = false; Task { await store.grantConsent() } }
                            .buttonStyle(ErnieButtonStyle(emphasis: .primary, fillsWidth: true))
                    }.padding() }.navigationTitle("Consenso AI")
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Annulla") { policy = false } } }
                }.presentationDetents([.medium, .large])
            }
            .sheet(item: Binding(get: { store.attachment }, set: { if $0 == nil { store.clearAttachment() } })) { attachment in
                HealthAttachmentPreview(attachment: attachment)
            }
            .sheet(item: Binding(get: { store.exportFile }, set: { if $0 == nil { store.clearExport() } }), onDismiss: { store.clearExport() }) { file in
                HealthExportSheet(url: file.url) { store.clearExport() }
            }
            .confirmationDialog("Eliminare il documento?", isPresented: Binding(get: { deleteID != nil }, set: { if !$0 { deleteID = nil } }), titleVisibility: .visible) {
                Button("Elimina documento e valori collegati", role: .destructive) { if let id = deleteID { Task { await store.remove(id) } }; deleteID = nil }
                Button("Annulla", role: .cancel) { deleteID = nil }
            } message: { Text("Questa operazione rimuove il documento, gli allegati e l’analisi dall’archivio Salute. Le copie che hai già esportato restano dove le hai salvate.") }
            .confirmationDialog("Esportare una copia?", isPresented: Binding(get: { exportTarget != nil }, set: { if !$0 { exportTarget = nil } }), titleVisibility: .visible) {
                Button("Prepara esportazione") { if let target = exportTarget { Task { await store.export(sourceId: target.source, reportId: target.report) } }; exportTarget = nil }
                Button("Annulla", role: .cancel) { exportTarget = nil }
            } message: { Text("La copia condivisa esce dall’archivio protetto. Scegli tu dove conservarla; Ernie elimina il file temporaneo quando chiudi la condivisione.") }
        }
    }
    var content: some View {
                VStack(alignment: .leading, spacing: 20) {
                    HealthPrivacyNotice()
                    consentSection
                    if let error = store.error {
                        Text(error).font(.callout).foregroundStyle(palette.ink).padding().frame(maxWidth: .infinity, alignment: .leading)
                            .background(palette.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
                    }
                    if store.busy { ProgressView("Operazione in corso…").frame(maxWidth: .infinity) }
                    if store.manualReady {
                        if let source = store.source { sourceDetail(source) }
                        else if let report = store.report {
                            backButton
                            HealthCard(block: report.block)
                            Button("Esporta questo referto", systemImage: "square.and.arrow.up") { exportTarget = .init(report: report.id) }.buttonStyle(ErnieButtonStyle())
                        } else {
                            sectionPicker
                            switch section { case 1: reportsSection; case 2: askSection; default: sourcesSection }
                        }
                    } else {
                        Text("L’archivio protetto sarà disponibile quando cifratura e preparazione dei dati saranno complete.")
                            .font(.callout).foregroundStyle(palette.inkSecondary)
                    }
                    Button("Aggiorna stato", systemImage: "arrow.clockwise") { Task { await store.refresh() } }
                        .buttonStyle(ErnieButtonStyle()).disabled(store.busy)
                }
    }
    @ViewBuilder private var sectionPicker: some View {
        if dynamicType.isAccessibilitySize {
            Picker("Sezione", selection: $section) { Text("Documenti").tag(0); Text("Valori").tag(1); Text("Chiedi").tag(2) }
                .pickerStyle(.menu).frame(minHeight: 44)
        } else {
            Picker("Sezione", selection: $section) { Text("Documenti").tag(0); Text("Valori").tag(1); Text("Chiedi").tag(2) }.pickerStyle(.segmented)
        }
    }
    private var consentSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(store.aiReady ? "Analisi AI autorizzata" : "Analisi AI disattivata", systemImage: "checkmark.shield").font(.headline)
            if !store.aiReady { Text("Puoi leggere e importare i documenti senza AI. L’analisi avviene solo quando la richiedi qui.").font(.callout).foregroundStyle(palette.inkSecondary) }
            if store.capabilities?.skillEnabled == false { Text("La skill Salute è disattivata. Attivala nelle skill per usare l’AI.").font(.callout) }
            if !store.aiReady {
                Button("Leggi e autorizza l’AI", systemImage: "sparkles") { policy = true }
                    .buttonStyle(ErnieButtonStyle()).disabled(store.capabilities?.policyVersion != 1 || store.capabilities?.available != true || store.capabilities?.skillEnabled != true || !store.manualReady || store.busy || store.revoking)
            }
            Button(store.revoking ? "Revoca in corso…" : "Revoca consenso AI", systemImage: "hand.raised") { Task { await store.revokeConsent() } }
                .buttonStyle(ErnieButtonStyle(emphasis: .destructive)).disabled(store.revoking)
        }.padding(16).background(palette.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 20))
    }
    private var sourcesSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let draft = store.draft {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Da salvare in Salute", systemImage: "lock.doc").font(.headline)
                    TextField("Titolo del documento", text: Binding(get: { store.draft?.title ?? "" }, set: { store.draft?.title = $0 }), axis: .vertical).lineLimit(1...4).font(.headline).textFieldStyle(.roundedBorder).autocorrectionDisabled()
                    Text("\(draft.pages.count) \(draft.pages.count == 1 ? "pagina" : "pagine") · \(draft.attachments.count) \(draft.attachments.count == 1 ? "allegato" : "allegati")").font(.callout)
                    Text("Il documento è ancora solo in memoria sul dispositivo. Non è stato inviato alla chat o a Media.").font(.callout).fixedSize(horizontal: false, vertical: true)
                    Button("Salva nell’archivio protetto", systemImage: "lock.fill") { Task { await store.upload() } }.buttonStyle(ErnieButtonStyle(emphasis: .primary, fillsWidth: true)).disabled(store.busy)
                    Button("Scarta bozza", role: .destructive) { store.draft = nil }.buttonStyle(ErnieButtonStyle(emphasis: .destructive)).disabled(store.busy)
                }.padding(16).background(palette.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
            }
            Button("Importa PDF o testo", systemImage: "doc.badge.plus") { files = true }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.busy)
            PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .images) { Label("Importa foto", systemImage: "photo.on.rectangle") }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.busy)
            if DocumentScannerView.isSupported {
                Button("Scansiona documento", systemImage: "doc.viewfinder") { scanner = true }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.busy)
            }
            Button("Scrivi una nota Salute", systemImage: "square.and.pencil") { textEntry = true }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.busy)
            if store.sources.isEmpty { Text("Nessun documento salvato.").foregroundStyle(palette.inkSecondary) }
            ForEach(store.sources) { source in
                Button { Task { await store.openSource(source.id) } } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(source.title).font(.headline)
                        Text("\(source.pages) \(source.pages == 1 ? "pagina" : "pagine") · \(source.status == "analyzed" ? "Analizzato" : "Da analizzare")").font(.callout)
                        Text(Self.date(source.createdAt)).font(.caption)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.busy)
            }
        }
    }
    private var reportsSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField("Cerca un parametro, es. glicemia", text: $store.parameterName).textFieldStyle(.roundedBorder).autocorrectionDisabled()
            Button("Cerca nei valori", systemImage: "magnifyingglass") { Task { await store.findParameter() } }.buttonStyle(ErnieButtonStyle()).disabled(store.parameterName.isEmpty || store.parameterName.count > 100 || store.busy)
            if let parameter = store.parameter { HealthCard(block: parameter.block) }
            if store.reports.isEmpty { Text("Non ci sono ancora analisi. Importa un documento, poi scegli Analizza con AI.").font(.callout) }
            ForEach(store.reports) { report in
                Button { Task { await store.openReport(report.id) } } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(report.lab ?? "Referto").font(.headline)
                        Text(report.takenOn.map(HealthFormat.shortDay) ?? "Data non disponibile").font(.callout)
                        Text("\(report.values) valori · \(report.outOfRange) fuori intervallo").font(.caption)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.busy)
            }
        }
    }
    private var askSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Chiedi sui tuoi referti").font(.headline)
            Text("La risposta resta in questa sezione e scompare alla chiusura. Puoi scegliere fino a 10 referti e 5 documenti. Senza selezione usa gli ultimi 10 referti; se non ci sono, gli ultimi 3 documenti.").font(.callout).foregroundStyle(palette.inkSecondary)
            ForEach(store.reports) { report in
                Toggle(isOn: Binding(get: { store.selectedReports.contains(report.id) }, set: { if $0 { store.selectedReports.insert(report.id) } else { store.selectedReports.remove(report.id) } })) {
                    Text("\(report.lab ?? "Referto") · \(report.takenOn.map(HealthFormat.shortDay) ?? "Data non disponibile")")
                }.disabled(store.aiBusy || (store.selectedReports.count >= 10 && !store.selectedReports.contains(report.id)))
            }
            ForEach(store.sources) { source in
                Toggle(isOn: Binding(get: { store.selectedSources.contains(source.id) }, set: { if $0 { store.selectedSources.insert(source.id) } else { store.selectedSources.remove(source.id) } })) {
                    Text("Documento: \(source.title)")
                }.disabled(store.aiBusy || (store.selectedSources.count >= 5 && !store.selectedSources.contains(source.id)))
            }
            TextField("La tua domanda", text: $store.question, axis: .vertical).lineLimit(3...8).textFieldStyle(.roundedBorder).autocorrectionDisabled().disabled(store.aiBusy)
            Button(store.aiBusy ? "Analisi in corso…" : "Chiedi a Ernie", systemImage: "sparkles") { Task { await store.ask() } }
                .buttonStyle(ErnieButtonStyle(emphasis: .primary, fillsWidth: true)).disabled(!store.aiReady || store.aiBusy || store.busy || store.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.question.count > 4000)
            if let answer = store.answer {
                Text(answer.answer).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                ForEach(answer.sources) { source in Text("Fonte: \(source.title)").font(.caption).foregroundStyle(palette.inkSecondary) }
            }
        }
    }
    private var backButton: some View {
        Button("Torna all’archivio", systemImage: "chevron.left") { store.clearDetail() }.buttonStyle(ErnieButtonStyle())
    }
    private func sourceDetail(_ source: HealthSourceDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            backButton
            Text(source.title).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
            Text(Self.date(source.createdAt)).font(.callout).foregroundStyle(palette.inkSecondary)
            ForEach(Array(source.pages.enumerated()), id: \.offset) { index, page in
                DisclosureGroup { Text(page).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8) } label: { Text("Pagina \(index + 1)").frame(minHeight: 44) }
            }
            ForEach(source.attachments) { attachment in
                Button("Apri \(attachment.name)", systemImage: "doc") { Task { await store.openAttachment(attachment.id, sourceId: source.id) } }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.busy)
            }
            Button("Fai una domanda su questo documento", systemImage: "bubble.left.and.text.bubble.right") {
                store.selectedSources = [source.id]; store.selectedReports = []; store.clearDetail(); section = 2
            }.buttonStyle(ErnieButtonStyle(fillsWidth: true)).disabled(store.aiBusy)
            Button(store.aiBusy ? "Analisi in corso…" : "Analizza con AI", systemImage: "sparkles") { Task { await store.analyze(source.id) } }.buttonStyle(ErnieButtonStyle(emphasis: .primary, fillsWidth: true)).disabled(!store.aiReady || store.busy || store.aiBusy)
            Button("Esporta documento", systemImage: "square.and.arrow.up") { exportTarget = .init(source: source.id) }.buttonStyle(ErnieButtonStyle()).disabled(store.busy)
            Button("Elimina documento", systemImage: "trash", role: .destructive) { deleteID = source.id }.buttonStyle(ErnieButtonStyle(emphasis: .destructive)).disabled(store.busy || store.aiBusy)
        }
    }
    static func date(_ raw: String) -> String { HealthFormat.shortDay(String(raw.prefix(10))) }
}

struct HealthPrivacyNotice: View {
    @Environment(\.chatPalette) private var palette
    @State private var expanded: Bool
    init(expanded: Bool = false) { _expanded = State(initialValue: expanded) }
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Documenti e valori sono cifrati sul backend Ernie, separati dal Second Brain. Qui non vengono salvate copie sul dispositivo, salvo un’esportazione che scegli tu.")
                Text("Questa protezione riguarda la sezione Salute. I testi che scrivi nella chat generale seguono le regole della chat.")
            }.padding(.top, 8)
        } label: {
            Label("Archivio cifrato", systemImage: "lock.shield").font(.headline).frame(minHeight: 44)
        }.font(.callout).foregroundStyle(palette.inkSecondary).fixedSize(horizontal: false, vertical: true)
    }
}
private struct HealthTextEntry: View {
    let save: (HealthVaultDraft) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var text = ""
    var body: some View {
        NavigationStack {
            Form {
                TextField("Titolo", text: $title).autocorrectionDisabled()
                TextField("Testo", text: $text, axis: .vertical).lineLimit(8...20).autocorrectionDisabled()
                Text("La bozza resta in memoria fino a quando scegli Salva nell’archivio protetto.").font(.footnote)
            }.navigationTitle("Nota Salute")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { text = ""; title = ""; dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Prepara") { save(.init(title: title, source: .text, pages: [text], attachments: [])); text = ""; title = ""; dismiss() }.disabled(title.isEmpty || title.count > 160 || text.isEmpty || text.utf16.count > HealthVaultDraft.maxCharacters) }
                }
        }.modifier(HealthPrivacyShield()).onDisappear { text = ""; title = "" }
    }
}
private struct HealthAttachmentPreview: View {
    let attachment: HealthAttachment
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Group {
                if let data = Data(base64Encoded: attachment.dataBase64) {
                    if attachment.mimeType == "application/pdf" { HealthPDFPreview(data: data) }
                    else if let image = UIImage(data: data) { ScrollView { Image(uiImage: image).resizable().scaledToFit() } }
                }
            }.navigationTitle(attachment.name).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
        }.modifier(HealthPrivacyShield())
    }
}
private struct HealthPDFPreview: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; view.document = PDFDocument(data: data); return view }
    func updateUIView(_ uiView: PDFView, context: Context) {}
    static func dismantleUIView(_ uiView: PDFView, coordinator: ()) { uiView.document = nil }
}
private struct HealthExportSheet: UIViewControllerRepresentable {
    let url: URL
    let close: () -> Void
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in close() }
        return controller
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

private struct HealthPrivacyShield: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.chatPalette) private var palette
    func body(content: Content) -> some View {
        content.privacySensitive().overlay {
            if scenePhase != .active {
                palette.ground.overlay { Label("Salute privata", systemImage: "lock.fill").foregroundStyle(palette.ink) }.ignoresSafeArea()
            }
        }
    }
}
