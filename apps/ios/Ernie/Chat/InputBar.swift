import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Un campo e un solo pulsante d'azione (le skill stanno nel pannello laterale, decisione dell'utente del 14 ott 2026): microfono (un tocco avvia l'ascolto; tenuto premuto,
/// o con l'impostazione «Conversazione continua», apre il dialogo a mani libere), invio quando c'è testo, stop mentre
/// Ernie parla. In ascolto la barra mostra lo stato, il livello del microfono e la trascrizione in tempo reale; ✕ annulla,
/// ↑ invia. Nella conversazione continua, mentre Ernie risponde, il microfono interrompe e riapre l'ascolto.
struct InputBar: View {
    @Environment(\.chatPalette) private var palette
    @State private var showMedia = false
    @Binding var draft: String
    @Binding var composing: Bool
    @FocusState private var classicFocused: Bool
    let conversation: ConversationStore
    let voice: VoiceController
    /// Allegato in preparazione (skill «Documenti»): «+» a sinistra del campo.
    var documents: DocumentComposer?
    var onCommand: (SlashCommand) -> Void = { _ in }
    @State private var showScanner = false
    @State private var showFiles = false
    @State private var showPhotos = false
    @State private var showFamilyComposer = false
    @State private var familyDraft = ""
    @State private var showCommandHelp = false
    @State private var helpSelection: SlashCommand?
    @State private var commandsDismissed = false
    @State private var commandError: String?
    @State private var commandSkills: [SkillInfo]?
    @State private var skillsOwner: Credentials?
    @State private var loadingCommandSkills = false
    @State private var commandLoadToken = UUID()
    @State private var photoItems: [PhotosPickerItem] = []

    private enum Mode { case mic, send, stop, voice }
    private var slashInput: SlashInput? { SlashInput(draft) }
    private var browsingCommands: Bool { slashInput != nil && mode != .voice && documents?.isActive != true }
    private var currentCommandSkills: [SkillInfo]? { skillsOwner == model.credentials ? commandSkills : nil }

    private var mode: Mode {
        if voice.isActive { return .voice }
        if !draft.trimmingCharacters(in: .whitespaces).isEmpty || documents?.ready != nil { return .send }
        if conversation.isBusy { return .stop }
        return .mic
    }

    var body: some View {
        VStack(spacing: 6) {
            if let error = commandError ?? voice.lastError ?? conversation.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
            }
            if let documents, documents.isActive {
                attachmentChip(documents)
            }
            if browsingCommands, !commandsDismissed, let input = slashInput {
                SlashCommandMenu(commands: input.suggestions(skills: currentCommandSkills), loading: loadingCommandSkills,
                                 onSelect: { performCommand($0, arguments: input.arguments) },
                                 onClose: { commandsDismissed = true })
                    .padding(.horizontal, 4)
            }
            // Barra in vetro che galleggia sul contenuto (bozzetti 1 e 2).
            HStack(alignment: .bottom, spacing: 8) {
                if mode == .voice {
                    Button { voice.cancelListening() } label: { icon("xmark", fill: .secondary) }
                        .accessibilityLabel("Annulla")
                    voicePanel
                    voiceButton
                } else {
                    if documents != nil { attachMenu }
                    if palette.terminal {
                        TerminalComposer(text: $draft, focused: $composing, placeholder: "Chiedi a \(conversationName)")
                            .overlay(alignment: .topLeading) {
                                if draft.isEmpty && !composing {
                                    Text("Chiedi a \(conversationName)…")
                                        .foregroundStyle(palette.inkSecondary)
                                        .padding(.top, 11).allowsHitTesting(false).accessibilityHidden(true)
                                }
                            }
                        .padding(.horizontal, 6)
                    } else {
                        TextField("Chiedi a \(conversationName)…", text: $draft, axis: .vertical)
                            .lineLimit(1...6)
                            .focused($classicFocused)
                            .font(.body)
                            .foregroundStyle(palette.ink)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 12)
                            .onSubmit(sendDraft)
                    }
                    actionButton
                }
            }
            .padding(6)
            .ernieGlass(in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            .shadow(color: palette.accent.opacity(0.10), radius: 14, y: 6)
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 6)
        // UIKit owns focus in Terminale; FocusState only belongs to the mounted SwiftUI field.
        .onChange(of: classicFocused) { _, focused in
            if !palette.terminal, composing != focused { composing = focused }
        }
        .onChange(of: composing) { _, focused in
            if !palette.terminal, classicFocused != focused { classicFocused = focused }
        }
        .onChange(of: palette.terminal) { _, terminal in
            classicFocused = terminal ? false : composing
        }
        .onAppear { if !palette.terminal { classicFocused = composing } }
        .onChange(of: draft) { commandError = nil; commandsDismissed = false }
        .onChange(of: model.credentials) { commandSkills = nil; skillsOwner = nil; commandError = nil; commandLoadToken = UUID(); loadingCommandSkills = false }
        .task(id: SlashCommandLoadKey(credentials: model.credentials, browsing: browsingCommands || showCommandHelp)) {
            guard browsingCommands || showCommandHelp, let api = model.api else { return }
            let token = UUID(); commandLoadToken = token
            commandSkills = nil; skillsOwner = api.credentials; loadingCommandSkills = true
            defer { if commandLoadToken == token { loadingCommandSkills = false } }
            let skills = try? await api.skills()
            guard !Task.isCancelled, commandLoadToken == token, model.credentials == api.credentials else { return }
            commandSkills = skills
        }
        .animation(.easeInOut(duration: 0.15), value: voice.phase)
        .onChange(of: conversation.composerSuggestion) { _, suggestion in
            guard let suggestion else { return }
            draft = suggestion
            conversation.composerSuggestion = nil
            composing = true
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
                documents?.importPhotos(count: 1, source: "photo") { _ in MediaImportPhoto(image: image, location: MediaLocation.read(data)) }
            }
        }
        .sheet(isPresented: $showFamilyComposer) { FamilyComposerSheet(initialText: familyDraft) }
        .sheet(isPresented: $showCommandHelp, onDismiss: {
            if let command = helpSelection { helpSelection = nil; performCommand(command) }
        }) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Scrivi / nella chat per trovare una scorciatoia. I comandi aprono le schermate senza usare l’AI.")
                        .font(.callout).foregroundStyle(palette.inkSecondary)
                    Text("Con /messaggio puoi aggiungere il testo: scegli poi a chi mandarlo e premi Invia.")
                        .font(.footnote).foregroundStyle(palette.inkSecondary)
                    SlashCommandMenu(commands: SlashInput("/")!.suggestions(skills: currentCommandSkills).filter { $0 != .help }, loading: loadingCommandSkills, expanded: true,
                                     onSelect: { helpSelection = $0; showCommandHelp = false })
                }
                .padding().background(palette.ground).foregroundStyle(palette.ink)
                .navigationTitle("Comandi rapidi").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { showCommandHelp = false } } }
            }
        }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .images, preferredItemEncoding: .current)
        .sheet(isPresented: $showMedia) { MediaLibraryView() }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty, conversation.isAttached else { return }
            photoItems = []
            documents?.importPhotos(count: items.count, source: "photo") { index in
                guard let data = try await items[index].loadTransferable(type: Data.self) else { throw DocumentReader.ReadError.unreadable }
                return try MediaImportPhoto(data: data)
            }
        }
    }

    /// «+» a sinistra: scansione, foto, file. Le nuove foto restano nella raccolta privata Media.
    private var attachMenu: some View {
        Menu {
            if DocumentScannerView.isSupported {
                Button("Scansiona", systemImage: "doc.viewfinder") { showScanner = true }
            }
            // Il selettore foto non si presenta da dentro un menu: lo apre un modificatore sulla barra.
            Button("Foto · raccolta Media", systemImage: "photo.on.rectangle") { showPhotos = true }
            Button("File (PDF)", systemImage: "folder") { showFiles = true }
            Divider()
            Button("Messaggio a un familiare", systemImage: "envelope") { familyDraft = ""; showFamilyComposer = true }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(palette.accentText)
                .frame(width: 44, height: 44)
                .background(palette.surfaceMuted, in: Circle())
        }
        .accessibilityLabel("Allega un documento")
    }

    /// Anteprima dell'allegato sopra la barra: avanzamento della lettura, poi titolo e pagine; ✕ annulla.
    private func attachmentChip(_ documents: DocumentComposer) -> some View {
        HStack(spacing: 8) {
            switch documents.phase {
            case .ready: Image(systemName: "doc.text.fill").foregroundStyle(Color.accentColor)
            case .mediaReady: Image(systemName: "photo.fill").foregroundStyle(Color.accentColor)
            case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            default: BearActivityIcon(status: .working, size: 22)
            }
            Text(documents.statusText)
                .font(.footnote)
                .foregroundStyle({ if case .failed = documents.phase { return Color.red } else { return Color.primary } }())
                .lineLimit(2)
            Spacer(minLength: 4)
            if documents.mediaSavedCount > 0 {
                Button { showMedia = true } label: { Image(systemName: "photo.on.rectangle") }
                    .accessibilityLabel("Apri le immagini salvate in Media")
            }
            if documents.ready != nil {
                // Riconoscimento automatico, con scelta facoltativa dello schema per lo studio.
                Menu {
                    Picker("Uso dell’allegato", selection: Binding(get: { documents.schemaChoice }, set: { documents.schemaChoice = $0 })) {
                        ForEach(DocumentComposer.SchemaChoice.allCases) { c in Label(c.title, systemImage: c.symbol).tag(c) }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: documents.schemaChoice.symbol)
                        Text(documents.schemaChoice == .auto ? "Auto" : documents.schemaChoice.title)
                        Image(systemName: "chevron.down").font(.caption2)
                    }
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                }
                .accessibilityLabel("Uso dell’allegato")
            }
            Button { documents.clear() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                .buttonStyle(.plain)
                .accessibilityLabel("Togli l'allegato")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .ernieSurface(radius: 16)
        .padding(.horizontal, 4)
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
                HStack(spacing: 8) {
                    LevelMeter(level: voice.inputLevel)
                    if voice.continuous {
                        Text("a mani libere")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if case .downloadingModel(let progress) = voice.phase {
                ProgressView(value: progress)
            } else if voice.isWaitingReply {
                HStack(spacing: 6) {
                    if conversation.agentState == .speaking {
                        Image(systemName: "speaker.wave.2.fill")
                    } else {
                        BearActivityIcon(status: .working, size: 20)
                    }
                    Text("a mani libere")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var voiceButton: some View {
        switch voice.phase {
        case .listening:
            Button { voice.finishListening() } label: { icon("arrow.up", fill: .red) }
                .accessibilityLabel("Invia quello che ho detto")
        case .waitingReply:
            Button { voice.interrupt() } label: { icon("mic.fill", fill: palette.accent) }
                .accessibilityLabel("Interrompi Ernie e parla")
        default:
            BearActivityIcon(status: .working, size: 30)
                .frame(width: 44, height: 44)
                .accessibilityLabel("Attendi")
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch mode {
        case .send:
            Button(action: sendDraft) { icon(slashInput == nil ? "arrow.up" : "return", fill: palette.accent) }
                .accessibilityLabel(slashInput == nil ? "Invia" : "Apri il comando")
        case .stop:
            Button { conversation.bargeIn() } label: { icon("stop.fill", fill: palette.inkSecondary) }
                .accessibilityLabel("Interrompi")
        case .mic, .voice:
            Button {
                composing = false
                voice.startListening()
            } label: {
                icon("mic.fill", fill: palette.accent)
            }
            // Pressione lunga: conversazione continua anche senza l'impostazione (il tocco al rilascio è ignorato perché l'ascolto è già partito).
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in
                composing = false
                voice.startListening(continuous: true)
            })
            .accessibilityLabel("Parla: un tocco avvia l'ascolto, tieni premuto per la conversazione continua")
        }
    }

    private func icon(_ name: String, fill: some ShapeStyle) -> some View {
        Image(systemName: name)
            .font(.system(size: 19, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 46, height: 46)
            .background(fill, in: Circle())
    }

    @Environment(AppModel.self) private var model
    private var conversationName: String { model.companionName }

    private func sendDraft() {
        if let input = slashInput {
            if input.name.isEmpty && input.arguments.isEmpty { performCommand(.help) }
            else if let command = input.command { performCommand(command, arguments: input.arguments) }
            else { commandError = input.validationError(skills: currentCommandSkills, hasAttachment: documents?.isActive == true) }
            return
        }
        let refs = documents?.ready.map { [$0] } ?? []
        let text = refs.isEmpty ? draft : (documents?.messageText(draft: draft) ?? draft)
        draft = ""
        documents?.clear()
        conversation.send(text, inputMode: "text", attachments: refs)
    }

    private func performCommand(_ command: SlashCommand, arguments: String = "") {
        let input = SlashInput("/" + command.rawValue + (arguments.isEmpty ? "" : " " + arguments))!
        if let error = input.validationError(skills: currentCommandSkills, hasAttachment: documents?.isActive == true) {
            commandError = error; return
        }
        draft = ""; composing = false; commandError = nil
        switch command {
        case .message: familyDraft = arguments; showFamilyComposer = true
        case .help: showCommandHelp = true
        default: onCommand(command)
        }
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
