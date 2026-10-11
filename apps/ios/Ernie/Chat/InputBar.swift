import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Un campo, il pulsante ✦ delle skill e un solo pulsante d'azione: microfono (un tocco avvia l'ascolto), invio quando
/// c'è testo, stop mentre Ernie parla. In ascolto la barra mostra lo stato, il livello del microfono e la trascrizione
/// in tempo reale; ✕ annulla, ↑ invia.
struct InputBar: View {
    @Binding var draft: String
    var composing: FocusState<Bool>.Binding
    let conversation: ConversationStore
    let voice: VoiceController
    /// Apre il pannello delle skill (decisione dell'utente: accanto al microfono, non in alto).
    var onSkills: () -> Void = {}
    /// Allegato in preparazione (skill «Documenti»): «+» a sinistra del campo.
    var documents: DocumentComposer?
    @State private var showScanner = false
    @State private var showFiles = false
    @State private var photoItems: [PhotosPickerItem] = []

    private enum Mode { case mic, send, stop, voice }

    private var mode: Mode {
        if voice.isActive { return .voice }
        if !draft.trimmingCharacters(in: .whitespaces).isEmpty || documents?.ready != nil { return .send }
        if conversation.isBusy { return .stop }
        return .mic
    }

    var body: some View {
        VStack(spacing: 6) {
            if let error = voice.lastError ?? conversation.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
            }
            if let documents, documents.isActive {
                attachmentChip(documents)
            }
            HStack(alignment: .bottom, spacing: 10) {
                if mode == .voice {
                    Button { voice.cancelListening() } label: { icon("xmark", fill: .secondary) }
                        .accessibilityLabel("Annulla")
                    voicePanel
                    voiceButton
                } else {
                    if documents != nil { attachMenu }
                    TextField("Scrivi, o tocca il microfono", text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                        .focused(composing)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22))
                        .onSubmit(sendDraft)
                    Button(action: onSkills) {
                        Image(systemName: "sparkles")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 44, height: 44)
                            .background(.thinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Skill")
                    actionButton
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .animation(.easeInOut(duration: 0.15), value: voice.phase)
        .onChange(of: conversation.composerSuggestion) { _, suggestion in
            guard let suggestion else { return }
            draft = suggestion
            conversation.composerSuggestion = nil
            composing.wrappedValue = true
        }
        .fullScreenCover(isPresented: $showScanner) {
            DocumentScannerView(
                onFinish: { images in
                    showScanner = false
                    documents?.importImages(images, source: "scan")
                },
                onCancel: { showScanner = false }
            )
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .plainText, .image], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            if url.pathExtension.lowercased() == "pdf" || url.pathExtension.lowercased() == "txt" || url.pathExtension.lowercased() == "md" {
                documents?.importPDF(url)
            } else if let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                documents?.importImages([image], source: "photo")
            }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                var images: [UIImage] = []
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) { images.append(image) }
                }
                photoItems = []
                if !images.isEmpty { documents?.importImages(images, source: "photo") }
            }
        }
    }

    /// «+» a sinistra: scansione, foto, file. Il testo viene letto sul telefono; l'originale non parte mai.
    private var attachMenu: some View {
        Menu {
            if DocumentScannerView.isSupported {
                Button("Scansiona", systemImage: "doc.viewfinder") { showScanner = true }
            }
            PhotosPicker(selection: $photoItems, maxSelectionCount: 10, matching: .images) {
                Label("Foto", systemImage: "photo.on.rectangle")
            }
            Button("File (PDF)", systemImage: "folder") { showFiles = true }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 36, height: 44)
        }
        .accessibilityLabel("Allega un documento")
    }

    /// Anteprima dell'allegato sopra la barra: avanzamento della lettura, poi titolo e pagine; ✕ annulla.
    private func attachmentChip(_ documents: DocumentComposer) -> some View {
        HStack(spacing: 8) {
            switch documents.phase {
            case .ready: Image(systemName: "doc.text.fill").foregroundStyle(Color.accentColor)
            case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            default: ProgressView().controlSize(.small)
            }
            Text(documents.statusText)
                .font(.footnote)
                .foregroundStyle({ if case .failed = documents.phase { return Color.red } else { return Color.primary } }())
                .lineLimit(2)
            Spacer(minLength: 4)
            Button { documents.clear() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                .buttonStyle(.plain)
                .accessibilityLabel("Togli l'allegato")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 8)
    }

    /// Stato della voce al posto del campo di testo: cosa sta succedendo, livello del microfono, trascrizione.
    private var voicePanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(voice.statusText)
                .font(.callout)
                .foregroundStyle(voice.liveTranscript.isEmpty ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            if voice.isListening {
                LevelMeter(level: voice.inputLevel)
            } else if case .downloadingModel(let progress) = voice.phase {
                ProgressView(value: progress)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22))
    }

    @ViewBuilder
    private var voiceButton: some View {
        switch voice.phase {
        case .listening:
            Button { voice.finishListening() } label: { icon("arrow.up", fill: .red) }
                .accessibilityLabel("Invia quello che ho detto")
        default:
            ProgressView()
                .frame(width: 44, height: 44)
                .accessibilityLabel("Attendi")
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch mode {
        case .send:
            Button(action: sendDraft) { icon("arrow.up", fill: Color.accentColor) }
                .accessibilityLabel("Invia")
        case .stop:
            Button { conversation.bargeIn() } label: { icon("stop.fill", fill: .secondary) }
                .accessibilityLabel("Interrompi")
        case .mic, .voice:
            Button {
                composing.wrappedValue = false
                voice.startListening()
            } label: {
                icon("mic.fill", fill: Color.accentColor)
            }
            .accessibilityLabel("Parla: un tocco avvia l'ascolto")
        }
    }

    private func icon(_ name: String, fill: some ShapeStyle) -> some View {
        Image(systemName: name)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(fill, in: Circle())
    }

    private func sendDraft() {
        let text = draft
        draft = ""
        let refs = documents?.ready.map { [$0] } ?? []
        documents?.clear()
        conversation.send(text, inputMode: "text", attachments: refs)
    }
}

/// Barre che seguono il livello del microfono: se non si muovono, il microfono non sente.
struct LevelMeter: View {
    let level: Float
    private static let weights: [CGFloat] = [0.35, 0.6, 0.85, 1, 0.7, 0.5, 0.9, 0.65, 1, 0.8, 0.55, 0.4, 0.75, 0.5]

    var body: some View {
        HStack(alignment: .center, spacing: 3) {
            ForEach(Array(Self.weights.enumerated()), id: \.offset) { _, weight in
                Capsule()
                    .fill(Color.red.opacity(0.85))
                    .frame(width: 3, height: 4 + 18 * CGFloat(level) * weight)
            }
            Text(level > 0.35 ? "ti sento" : "silenzio")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.leading, 6)
                .contentTransition(.numericText())
        }
        .frame(height: 22, alignment: .center)
        .animation(.linear(duration: 0.06), value: level)
        .accessibilityHidden(true)
    }
}
