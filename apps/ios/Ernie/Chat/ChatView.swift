import SwiftUI

/// Schermata principale (nuova interfaccia, bozzetti approvati il 13 ott 2026): barra in alto in vetro (pannello,
/// capsula con l'orso, voce), «Oggi» quando la conversazione è vuota, poi la conversazione; barra di scrittura in
/// vetro; in ascolto la schermata dedicata; il pannello laterale raccoglie sezioni e conversazioni passate.
struct ChatView: View {
    @State private var appearanceDate = Date()
    @State private var appearanceIdleSince = Date()
    @Environment(\.scenePhase) private var scenePhase
    private var resolvedCostume: BearCostume {
        BearCostume.resolve(choice: bearCostume,
                            hour: Calendar.current.component(.hour, from: appearanceDate),
                            tools: model.conversation?.agentState == .idle && appearanceDate.timeIntervalSince(appearanceIdleSince) > 45
                                ? [] : BearContext.latest(in: model.conversation?.items ?? []).tools,
                            emotion: model.conversation?.lastAvatarEmotion ?? "")
    }
    private var palette: ChatPalette { ChatPalette(costume: resolvedCostume) }
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var showUsage = false
    @State private var showUsageAdmin = false
    @State private var showBrain = false
    @State private var showSSH = false
    @State private var showGame = false
    @State private var listSheet: ListSheet?
    @State private var showRecipes = false
    @State private var showMedia = false
    @State private var showReminders = false
    @State private var showAutomations = false
    @State private var dismissingForLink = false
    @State private var handledWidgetLink = false
    @State private var showSkills = false
    @State private var showFamily = false
    @State private var showProfile = false
    @State private var panelOpen = false
    /// Novità mostrate all'avvio dopo un aggiornamento, o riaperte dal pannello.
    @State private var whatsNew: [ChangelogEntry]?
    @State private var debugIcons = false
    @State private var draft = ""
    @AppStorage(BearCostume.preferenceKey) private var bearCostume = BearCostume.automatic.rawValue
    @State private var composing = false

    var body: some View {
        ZStack {
            ChatBackdrop()
            if let conversation = model.conversation, let voice = model.voice {
                VStack(spacing: 0) {
                    topBar(conversation)
                    ZStack(alignment: .top) {
                        if conversation.items.isEmpty {
                            HomeView(conversation: conversation, onOpen: open)
                                .transition(.opacity.combined(with: .move(edge: .top)))
                        } else {
                            MessageList(
                                conversation: conversation,
                                topInset: model.settings.avatarFloating ? FloatingAvatar.topInset(model.settings, composing: composing) : 0
                            )
                            // Su richiesta resta l'avatar galleggiante di prima (trascinabile, ridimensionabile).
                            if model.settings.avatarFloating {
                                FloatingAvatar(
                                    state: conversation.agentState,
                                    name: model.companionName,
                                    connection: conversation.connection,
                                    emotion: conversation.lastAvatarEmotion,
                                    composing: composing,
                                    mouthOpen: model.speaker.mouthOpen
                                )
                                .transition(.identity)
                            }
                        }
                    }
                    .frame(maxHeight: .infinity)
                    .animation(.spring(duration: 0.45), value: conversation.items.isEmpty)
                    if let status = conversation.recoveryStatus {
                        Text(status).font(.footnote).foregroundStyle(palette.inkSecondary)
                            .padding(.horizontal).accessibilityAddTraits(.updatesFrequently)
                    }
                    if conversation.canRecoverRequest {
                        Button("Recupera risposta") { conversation.recoverLastRequest() }
                            .buttonStyle(.bordered).padding(.horizontal)
                    }
                    InputBar(draft: $draft, composing: $composing, conversation: conversation, voice: voice, documents: model.documents)
                }
                if Self.showsListening(voice.phase) {
                    ListeningOverlay(voice: voice, conversation: conversation)
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                        .zIndex(1)
                }
                SidePanel(isOpen: $panelOpen, onSelect: open)
                    .zIndex(2)
            } else {
                ProgressView()
            }
        }
        .chatAppearance(costume: resolvedCostume)
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            appearanceDate = .now
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                appearanceDate = .now
            }
        }
        .onChange(of: model.conversation?.agentState) { appearanceIdleSince = .now; appearanceDate = .now }
        .onChange(of: model.conversation?.lastAvatarEmotion) { appearanceIdleSince = .now; appearanceDate = .now }
        .environment(\.bearContext, BearContext.latest(in: model.conversation?.items ?? []))
        .animation(.spring(duration: 0.35), value: model.voice.map { Self.showsListening($0.phase) } ?? false)
        .sheet(isPresented: $showSettings, onDismiss: sheetDidDismiss) { SettingsView() }
        .sheet(isPresented: $showUsage, onDismiss: sheetDidDismiss) { UsageView(scope: .personal) }
        .sheet(isPresented: $showUsageAdmin, onDismiss: sheetDidDismiss) { UsageView(scope: .all) }
        .sheet(isPresented: $showBrain, onDismiss: sheetDidDismiss) { SecondBrainView() }
        .fullScreenCover(isPresented: $showGame, onDismiss: sheetDidDismiss) {
            if let conversation = model.conversation {
                ErnieTRIXView(storageID: conversation.gameStorageID, costume: resolvedCostume)
            }
        }
        .onChange(of: model.conversation?.gameLaunchID) { _, request in
            if request != nil { openGame() }
        }
        .sheet(isPresented: $showSSH, onDismiss: sheetDidDismiss) { SSHHomeView(store: model.sshStore) }
        .sheet(item: $listSheet, onDismiss: sheetDidDismiss) { destination in
            switch destination {
            case .todo(let id): TodoLibraryView(listId: id)
            case .shopping(let id): ShoppingListDetailView(listId: id)
            }
        }
        .sheet(isPresented: $showRecipes, onDismiss: sheetDidDismiss) { RecipeLibraryView() }
        .sheet(isPresented: $showMedia, onDismiss: sheetDidDismiss) { MediaLibraryView() }
        .sheet(isPresented: $showReminders, onDismiss: sheetDidDismiss) { RemindersView() }
        .sheet(isPresented: $showAutomations, onDismiss: sheetDidDismiss) { AutomationsView() }
        .sheet(isPresented: $showSkills, onDismiss: sheetDidDismiss) { SkillsSheet() }
        .sheet(isPresented: Binding(get: { whatsNew != nil }, set: { if !$0 { whatsNew = nil } }), onDismiss: sheetDidDismiss) {
            WhatsNewView(entries: whatsNew ?? [])
        }
        .task {
            // Dopo un aggiornamento: le novità delle versioni non ancora viste, una volta sola.
            let unseen = Changelog.unseen()
            Changelog.markSeen()
            if !unseen.isEmpty {
                try? await Task.sleep(for: .milliseconds(600))
                guard !Task.isCancelled, !handledWidgetLink, model.pendingLink == nil else { return }
                whatsNew = unseen
            }
        }
        .sheet(isPresented: $showFamily, onDismiss: sheetDidDismiss) { ClosableSheet { FamilyView() } }
        // Widget dell'orso: «Parla» avvia l'ascolto, «Scrivi» apre la tastiera (anche ad app appena aperta).
        .onChange(of: model.pendingLink) { consumeLink() }
        .onChange(of: model.voice != nil) { consumeLink() }
        .onAppear { consumeLink() }
        .sheet(isPresented: $showProfile, onDismiss: sheetDidDismiss) { ClosableSheet { ProfileView() } }
        #if DEBUG
        .sheet(isPresented: $debugIcons, onDismiss: sheetDidDismiss) { IconGalleryView() }
        .onAppear { debugIcons = ProcessInfo.processInfo.environment["ERNIE_DEBUG_ICONS"] != nil }
        #endif
    }

    private func consumeLink() {
        guard let link = model.pendingLink, let voice = model.voice else { return }
        guard !dismissingForLink else { return }
        handledWidgetLink = true
        panelOpen = false
        // Non attivare microfono/tastiera o una seconda scheda sotto un foglio esistente.
        if hasPresentedSheet {
            dismissingForLink = true
            showSettings = false; showUsage = false; showUsageAdmin = false
            showBrain = false; showSSH = false; showGame = false; listSheet = nil
            showRecipes = false; showMedia = false; showReminders = false
            showAutomations = false; showSkills = false; showFamily = false
            showProfile = false; whatsNew = nil; debugIcons = false
            return
        }
        model.pendingLink = nil
        switch link {
        case .voice:
            composing = false
            voice.startListening()
        case .chat:
            if voice.isActive { voice.cancelListening() }
            composing = true
        case .reminders, .automations:
            if voice.isActive { voice.cancelListening() }
            composing = false
            if link == .reminders { showReminders = true } else { showAutomations = true }
        case .family:
            if voice.isActive { voice.cancelListening() }
            composing = false
        }
    }

    private var hasPresentedSheet: Bool {
        showSettings || showUsage || showUsageAdmin || showBrain || showSSH || listSheet != nil
        || showRecipes || showMedia || showReminders || showAutomations || showSkills
        || showFamily || showProfile || whatsNew != nil || debugIcons || showGame
    }

    private func sheetDidDismiss() {
        dismissingForLink = false
        consumeLink()
    }

    /// La schermata di ascolto copre la chat mentre si parla; quando Ernie risponde torna la conversazione.
    static func showsListening(_ phase: VoiceController.Phase) -> Bool {
        switch phase {
        case .preparing, .downloadingModel, .listening, .finalizing: true
        case .idle, .waitingReply: false
        }
    }

    private func open(_ destination: PanelDestination) {
        switch destination {
        case .newConversation: model.newConversation()
        case .conversation(let id): model.conversation?.resume(sessionId: id)
        case .ernietrix: openGame()
        case .ssh: showSSH = true
        case .todo: listSheet = .todo(nil)
        case .todoList(let id): listSheet = .todo(id)
        case .shoppingList(let id): listSheet = .shopping(id)
        case .reminders: showReminders = true
        case .automations: showAutomations = true
        case .brain, .health: showBrain = true
        case .recipes: showRecipes = true
        case .media: showMedia = true
        case .family: showFamily = true
        case .profile: showProfile = true
        case .skills: showSkills = true
        case .settings: showSettings = true
        case .usage: showUsage = true
        case .usageAdmin:
            if model.profile?.capabilities?.usageAdmin == true { showUsageAdmin = true }
        case .whatsNew: whatsNew = Array(Changelog.load().prefix(3))
        }
    }

    private func openGame() {
        panelOpen = false
        composing = false
        model.voice?.cancelListening()
        model.conversation?.muteSpeech()
        showGame = true
    }

    // MARK: barra in alto

    private enum ListSheet: Identifiable {
        case todo(String?)
        case shopping(String)
        var id: String {
            switch self {
            case .todo(let id): "todo:\(id ?? "library")"
            case .shopping(let id): "shopping:\(id)"
            }
        }
    }

    private func topBar(_ conversation: ConversationStore) -> some View {
        HStack(spacing: 10) {
            GlassCircleButton(systemName: "sidebar.leading", tint: palette.ink, label: "Apri il pannello") {
                withAnimation(.spring(duration: 0.35)) { panelOpen = true }
            }
            Spacer(minLength: 0)
            if !conversation.items.isEmpty {
                companionCapsule(conversation)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                Spacer(minLength: 0)
            }
            GlassCircleButton(
                systemName: model.settings.voiceOutput ? "speaker.wave.2.fill" : "speaker.slash.fill",
                tint: model.settings.voiceOutput ? palette.accentText : palette.inkSecondary,
                label: model.settings.voiceOutput ? "Voce accesa: tocca per spegnerla" : "Voce spenta: tocca per accenderla"
            ) {
                model.setVoiceOutput(!model.settings.voiceOutput)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 6)
        .animation(.spring(duration: 0.4), value: conversation.items.isEmpty)
    }

    /// Un solo orso: nella capsula, leggermente sporgente, oppure galleggiante sulla chat.
    /// Nome, stato e menu restano accessibili anche quando l'avatar è fuori dalla capsula.
    private func companionCapsule(_ conversation: ConversationStore) -> some View {
        let caption = AvatarCaption.text(connection: conversation.connection, state: conversation.agentState) ?? "pronto"
        let docked = !model.settings.avatarFloating
        return HStack(spacing: 8) {
            if docked {
                // Il posto resta compatto; l'orso viene disegnato sopra il vetro, senza tagliarlo.
                Color.clear.frame(width: 36, height: 36)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text(model.companionName).font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
                Text(caption).font(.caption2).foregroundStyle(captionColor(conversation))
                    .contentTransition(.opacity)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.75)
        }
        .frame(minHeight: 36)
        .padding(.leading, docked ? 4 : 14)
        .padding(.trailing, 14)
        .padding(.vertical, 4)
        .ernieGlass(in: Capsule())
        .overlay(alignment: .leading) {
            if docked {
                PixelBearView(state: conversation.agentState, mouthOpen: model.speaker.mouthOpen,
                              size: 32 * 1.15, emotion: conversation.lastAvatarEmotion)
                    .frame(width: 36 * 1.15, height: 36 * 1.15)
                    .background(palette.accent, in: Circle())
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(ring(conversation.agentState), lineWidth: 2))
                    .offset(x: -4)
                    // Niente seconda faccia durante la transizione all'avatar galleggiante.
                    .transition(.identity)
            }
        }
        // Include la sporgenza nel centraggio: volto, testo e pulsanti restano sullo stesso asse.
        .padding(.leading, docked ? 4 : 0)
        .contextMenu {
            Picker("Aspetto di Ernie", selection: $bearCostume) {
                ForEach(BearCostume.allCases) { costume in Text(costume.title).tag(costume.rawValue) }
            }
            Button("Nuova conversazione", systemImage: "plus.bubble") { model.newConversation() }
            Button(model.settings.avatarFloating ? "Avatar nella capsula" : "Avatar galleggiante", systemImage: "circle.dashed") {
                withAnimation(.spring(duration: 0.35)) {
                    model.settings.avatarFloating.toggle()
                    model.settings.avatarHidden = false
                }
                model.settings.save()
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(model.companionName), \(caption)")
        .accessibilityHint("Tieni premuto per altre opzioni")
    }

    private func ring(_ state: AgentState) -> Color {
        switch state {
        case .idle: palette.accent.opacity(0.4)
        case .listening: .red
        case .thinking: .orange
        case .speaking: palette.positive
        }
    }

    private func captionColor(_ conversation: ConversationStore) -> Color {
        if case .connected = conversation.connection {
            return conversation.agentState == .idle ? palette.inkSecondary : palette.positive
        }
        return .orange
    }
}

/// Foglio con barra di navigazione e «Fine» per le schermate pensate per stare dentro le impostazioni.
struct ClosableSheet<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } }
                }
        }
    }
}

/// Sfondo: lilla tenue con un alone viola sfumato in alto (quasi nero viola di sera).
struct ChatBackdrop: View {
    @Environment(\.chatPalette) private var palette
    var body: some View {
        ZStack(alignment: .top) {
            palette.ground
            Circle()
                .fill(palette.glow)
                .frame(width: 320, height: 320)
                .blur(radius: 70)
                .offset(y: -160)
                .opacity(0.9)
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

struct MessageList: View {
    let conversation: ConversationStore
    /// Spazio lasciato in alto per l'avatar che galleggia sopra la lista.
    var topInset: CGFloat = 0

    /// Cambia quando arriva un elemento nuovo o cresce il testo in streaming: la lista segue il fondo.
    private var tail: String {
        guard let last = conversation.items.last else { return "" }
        if case .message(let m) = last { return "\(last.id):\(m.text.count)" }
        return last.id
    }

    @ViewBuilder
    private var rows: some View {
        ForEach(conversation.items) { item in
            switch item {
            case .message(let m): MessageRow(message: m, conversation: conversation)
            case .confirmation(let c): ConfirmationCardView(card: c, conversation: conversation)
            case .notification(let n): NotificationCardView(card: n, conversation: conversation)
            case .family(let f): FamilyMessageBubble(message: f)
            }
        }
        Color.clear.frame(height: 1).id("bottom")
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Lista normale per le conversazioni di lunghezza comune: con quella pigra le altezze stimate delle
                // schede grandi facevano fermare la lista oltre la fine (schermo vuoto all'avvio). Pigra solo oltre i 150.
                if conversation.items.count <= 150 {
                    VStack(alignment: .leading, spacing: 14) { rows }
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                } else {
                    LazyVStack(alignment: .leading, spacing: 14) { rows }
                        .padding(.horizontal)
                        .padding(.vertical, 8)
                }
            }
            .contentMargins(.top, topInset, for: .scrollContent)
            // I messaggi sfumano sotto la barra in alto invece di essere tagliati di netto.
            .scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: tail) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            // All'avvio la lista pigra stima le altezze delle schede grandi (schemi) e può fermarsi oltre la fine:
            // dopo la prima impaginazione si riallinea al fondo.
            .task {
                try? await Task.sleep(for: .milliseconds(400))
                proxy.scrollTo("bottom", anchor: .bottom)
                try? await Task.sleep(for: .milliseconds(800))
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }
}

struct MessageRow: View {
    @Environment(\.chatPalette) private var palette
    let message: ChatMessage
    var conversation: ConversationStore?

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 6) {
                    if let attachments = message.attachments, !attachments.isEmpty {
                        ForEach(attachments, id: \.id) { a in
                            Label("\(a.title) · \(a.pages) \(a.pages == 1 ? "pagina" : "pagine")", systemImage: "doc.text.fill")
                                .font(.caption)
                                .foregroundStyle(palette.bubbleText.opacity(0.85))
                                .lineLimit(1)
                        }
                    }
                    Text(message.text)
                        .font(palette.terminal ? .system(.body, design: .monospaced) : .body)
                    if message.queued == true {
                        Label("in attesa che Ernie finisca", systemImage: "clock")
                            .font(.caption2)
                            .foregroundStyle(palette.bubbleText.opacity(0.8))
                    }
                }
                .foregroundStyle(palette.bubbleText)
                .opacity(message.queued == true ? 0.75 : 1)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(
                    palette.bubble,
                    in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
                )
                .shadow(color: palette.accent.opacity(0.18), radius: 8, y: 4)
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                if !message.tools.isEmpty {
                    ForEach(message.tools) { tool in
                        ToolPill(name: ToolLabels.name(tool.toolId, displayName: tool.displayName), ok: tool.ok)
                    }
                }
                if message.text.isEmpty, message.isStreaming, message.blocks.isEmpty {
                    BearThinkingIndicator()
                } else if !message.text.isEmpty {
                    // Risposte di Ernie in testo pieno, senza fumetto (bozzetto 2).
                    MarkdownText(text: message.text)
                        .foregroundStyle(palette.ink)
                        .lineSpacing(2)
                        .padding(.horizontal, 2)
                }
                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                    BlockView(block: block, conversation: conversation)
                }
                if message.cancelled {
                    Text("Interrotto").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.trailing, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .system:
            Text(message.text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 4)
        }
    }
}

/// Cosa sta facendo Ernie («Cerco nel second brain…»): etichetta discreta con lo stato; in corso, un riflesso animato.
struct ToolPill: View {
    @Environment(\.chatPalette) private var palette
    let name: String
    let ok: Bool?

    var body: some View {
        HStack(spacing: 7) {
            BearActivityIcon(status: ok == nil ? .working : (ok == true ? .success : .failed), size: 24)
            Text(name)
                .font(.footnote)
                .foregroundStyle(palette.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 4)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .background(palette.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(palette.hairline))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ok == nil ? "\(name), in corso" : ok == true ? "\(name), fatto" : "\(name), non riuscito")
    }
}

struct ConfirmationCardView: View {
    let card: ConfirmationCard
    let conversation: ConversationStore

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            ConfirmationCardContent(card: card, now: context.date) { approve, always in
                if approve {
                    let reason = always ? ConfirmationCopy.alwaysLabel(for: card.toolId) : ConfirmationCopy.presentation(for: card).confirmLabel
                    guard await StepUp.authenticate(reason: reason) else { return false }
                }
                guard conversation.isAttached, ConfirmationCopy.decision(for: card, now: .now) == nil else { return false }
                conversation.respond(to: card, approve: approve, always: always)
                return true
            }
        }
    }
}

/// Contenuto separato per verificare il layout reale anche a 320 punti e con Dynamic Type.
struct ConfirmationCardContent: View {
    @Environment(\.chatPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let card: ConfirmationCard
    var now = Date.now
    var onDecision: (Bool, Bool) async -> Bool = { _, _ in false }
    @State var detailsExpanded = false
    @State var reviewExpanded = false
    @State private var optionsExpanded = false
    @State private var submitting = false
    @State private var authenticationFailed = false

    private var presentation: ConfirmationPresentation { ConfirmationCopy.presentation(for: card) }
    private var decision: String? { ConfirmationCopy.decision(for: card, now: now) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let decision {
                reviewHeader(decision)
                if reviewExpanded {
                    Divider()
                    Text(presentation.summary).font(.callout).foregroundStyle(palette.ink)
                    details
                    reason
                    if card.always == true {
                        Text(ConfirmationCopy.alwaysExplanation(for: card.toolId))
                            .font(.footnote).foregroundStyle(palette.inkSecondary)
                    }
                    if decision == "expired" {
                        Text("Richiesta scaduta. Chiedi a Ernie di ripeterla.")
                            .font(.footnote).foregroundStyle(palette.inkSecondary)
                    }
                }
            } else {
                Label(presentation.title, systemImage: "hand.raised")
                    .font(.headline)
                    .foregroundStyle(palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Text(ConfirmationCopy.compactSummary(for: card))
                    .font(.callout).foregroundStyle(palette.ink)
                if !presentation.details.isEmpty {
                    DisclosureGroup(isExpanded: $detailsExpanded) {
                        details.padding(.top, 6)
                    } label: {
                        Text(card.toolId == "recipe_save" ? "Ingredienti e preparazione" : "Dettagli dell’azione")
                            .font(.subheadline.weight(.medium))
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
                reason
                if presentation.incomplete == true {
                    Text("I dettagli di questa richiesta sono incompleti. Annullala e chiedi a Ernie di ripeterla.")
                        .font(.footnote).foregroundStyle(palette.inkSecondary)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { cancelButton.fixedSize(); approveButton.fixedSize() }
                    VStack(spacing: 10) { approveButton; cancelButton }
                }
                .disabled(submitting)
                if authenticationFailed {
                    Text("Conferma non completata. Riprova.").font(.subheadline).foregroundStyle(palette.inkSecondary)
                }
                if card.allowAlways == true, presentation.incomplete != true {
                    DisclosureGroup(isExpanded: $optionsExpanded) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(ConfirmationCopy.alwaysExplanation(for: card.toolId))
                                .font(.footnote).foregroundStyle(palette.inkSecondary)
                            Button { send(approve: true, always: true) } label: {
                                Label(ConfirmationCopy.alwaysLabel(for: card.toolId), systemImage: "checkmark.shield")
                                    .font(.subheadline.weight(.medium))
                                    .frame(minHeight: 44, alignment: .leading)
                            }
                            .buttonStyle(.borderless)
                            .disabled(submitting)
                        }
                    } label: {
                        Text("Opzioni di conferma").font(.footnote.weight(.medium))
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .ernieSurface(radius: 18)
        .tint(palette.accentText)
        .onChange(of: decision) { _, newValue in
            if newValue != nil {
                reviewExpanded = false
                detailsExpanded = false
                optionsExpanded = false
            }
        }
    }

    private func reviewHeader(_ decision: String) -> some View {
        Button { reviewExpanded.toggle() } label: {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top, spacing: 8) {
                            reviewTitle
                            Spacer(minLength: 0)
                            reviewChevron
                        }
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            reviewIcon(decision).font(.system(size: 20))
                            reviewStatus(decision)
                        }
                    }
                } else {
                    HStack(spacing: 10) {
                        reviewIcon(decision).font(.title3)
                        VStack(alignment: .leading, spacing: 3) {
                            reviewTitle
                            reviewStatus(decision)
                        }
                        Spacer(minLength: 4)
                        reviewChevron
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityValue(reviewExpanded ? "Dettagli aperti" : "Dettagli chiusi")
        .accessibilityHint(reviewExpanded ? "Tocca per chiudere i dettagli" : "Tocca per rivedere la richiesta e i suoi dettagli")
    }

    private var reviewTitle: some View {
        Text(ConfirmationCopy.compactTitle(for: card))
            .font(.subheadline.weight(.semibold)).foregroundStyle(palette.ink)
    }

    private func reviewStatus(_ decision: String) -> some View {
        Text(ConfirmationCopy.status(for: card, decision: decision))
            .font(.caption).foregroundStyle(palette.inkSecondary)
    }

    private func reviewIcon(_ decision: String) -> some View {
        Image(systemName: decision == "approved" ? "checkmark.circle" : decision == "denied" ? "xmark.circle" : "clock")
            .foregroundStyle(palette.accentText).accessibilityHidden(true)
    }

    private var reviewChevron: some View {
        Image(systemName: reviewExpanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.inkSecondary)
            .accessibilityHidden(true)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(presentation.details.enumerated()), id: \.offset) { _, detail in
                VStack(alignment: .leading, spacing: 4) {
                    Text(detail.label).font(.subheadline.weight(.semibold)).foregroundStyle(palette.inkSecondary)
                    Text(detail.value).font(.callout).foregroundStyle(palette.ink).textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private var reason: some View {
        if let reason = ConfirmationCopy.reason(card.reason) {
            Text(reason).font(.footnote).foregroundStyle(palette.inkSecondary)
        }
    }

    private var cancelButton: some View {
        Button("Annulla") { send(approve: false) }
            .buttonStyle(.bordered).controlSize(.large)
    }

    private var approveButton: some View {
        Button(presentation.confirmLabel) { send(approve: true) }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .tint(presentation.destructive == true ? Color.red : palette.accent)
            .disabled(presentation.incomplete == true)
    }

    private func send(approve: Bool, always: Bool = false) {
        guard !submitting else { return }
        submitting = true
        authenticationFailed = false
        Task {
            let sent = await onDecision(approve, always)
            authenticationFailed = !sent
            submitting = false
        }
    }

}

struct NotificationCardView: View {
    let card: NotificationCard
    let conversation: ConversationStore
    @State private var expanded = false

    private var icon: String {
        switch card.kind {
        case "automation.approval": "hand.raised"
        case "automation.paused": "pause.circle"
        case "proactive.approval_expiring": "hourglass"
        case "proactive.family_reminder": "person.2.fill"
        case "automation.error", "automation.deadletter": "exclamationmark.triangle"
        default: "sparkles"
        }
    }

    /// Il promemoria scattato ha corpo «⏰ Promemoria: X» e titolo «Promemoria: X»: una riga basta.
    private var bodyRepeatsTitle: Bool {
        let norm = { (s: String) in
            s.drop { !$0.isLetter }.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        }
        return norm(card.body) == norm(card.title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(card.title, systemImage: bodyRepeatsTitle && card.title.hasPrefix("Promemoria") ? "alarm" : icon)
                .font(.subheadline.weight(.semibold))
            if !bodyRepeatsTitle {
                MarkdownText(text: expanded ? card.body : String(card.body.prefix(420)) + (card.body.count > 420 ? "…" : ""), font: .callout)
                    .onTapGesture { expanded.toggle() }
            }
            ForEach(card.pendingActions) { action in
                VStack(alignment: .leading, spacing: 6) {
                    Text(action.summary).font(.caption)
                    if let d = action.decision {
                        Text(d == "approved" ? "Eseguita" : d == "denied" ? "Rifiutata" : "Scaduta")
                            .font(.caption.weight(.semibold))
                    } else {
                        HStack {
                            Button("Rifiuta", role: .destructive) { Task { await conversation.decide(action: action, in: card, approve: false) } }
                            Button("Approva") { Task { await conversation.decide(action: action, in: card, approve: true) } }
                                .buttonStyle(.borderedProminent)
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(.top, 2)
            }
            if card.isPaused, card.automationId != nil {
                if card.resumed == true {
                    Label("Ripresa", systemImage: "checkmark.circle").font(.caption.weight(.semibold))
                } else {
                    Button {
                        Task { await conversation.resume(card) }
                    } label: {
                        Label(card.resumed == false ? "Riprova a riprendere" : "Riprendi", systemImage: "play.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
            }
        }
        .padding()
        .ernieSurface()
    }
}
