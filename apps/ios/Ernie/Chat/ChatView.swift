import SwiftUI

/// Schermata principale (nuova interfaccia, bozzetti approvati il 13 ott 2026): barra in alto in vetro (pannello,
/// capsula con l'orso, voce), «Oggi» quando la conversazione è vuota, poi la conversazione; barra di scrittura in
/// vetro; in ascolto la schermata dedicata; il pannello laterale raccoglie sezioni e conversazioni passate.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var showBrain = false
    @State private var showReminders = false
    @State private var showSkills = false
    @State private var showFamily = false
    @State private var showProfile = false
    @State private var panelOpen = false
    /// Novità mostrate all'avvio dopo un aggiornamento, o riaperte dal pannello.
    @State private var whatsNew: [ChangelogEntry]?
    @State private var debugIcons = false
    @State private var draft = ""
    @FocusState private var composing: Bool

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
                            }
                        }
                    }
                    .frame(maxHeight: .infinity)
                    .animation(.spring(duration: 0.45), value: conversation.items.isEmpty)
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
        .animation(.spring(duration: 0.35), value: model.voice.map { Self.showsListening($0.phase) } ?? false)
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showBrain) { SecondBrainView() }
        .sheet(isPresented: $showReminders) { RemindersView() }
        .sheet(isPresented: $showSkills) { SkillsSheet() }
        .sheet(isPresented: Binding(get: { whatsNew != nil }, set: { if !$0 { whatsNew = nil } })) {
            WhatsNewView(entries: whatsNew ?? [])
        }
        .task {
            // Dopo un aggiornamento: le novità delle versioni non ancora viste, una volta sola.
            let unseen = Changelog.unseen()
            Changelog.markSeen()
            if !unseen.isEmpty {
                try? await Task.sleep(for: .milliseconds(600))
                whatsNew = unseen
            }
        }
        .sheet(isPresented: $showFamily) { ClosableSheet { FamilyView() } }
        .sheet(isPresented: $showProfile) { ClosableSheet { ProfileView() } }
        #if DEBUG
        .sheet(isPresented: $debugIcons) { IconGalleryView() }
        .onAppear { debugIcons = ProcessInfo.processInfo.environment["ERNIE_DEBUG_ICONS"] != nil }
        #endif
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
        case .reminders: showReminders = true
        case .brain, .health: showBrain = true
        case .family: showFamily = true
        case .profile: showProfile = true
        case .skills: showSkills = true
        case .settings: showSettings = true
        case .whatsNew: whatsNew = Array(Changelog.load().prefix(3))
        }
    }

    // MARK: barra in alto

    private func topBar(_ conversation: ConversationStore) -> some View {
        HStack(spacing: 10) {
            GlassCircleButton(systemName: "sidebar.leading", label: "Apri il pannello") {
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
                tint: model.settings.voiceOutput ? Theme.accentText : Theme.inkSecondary,
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

    /// Capsula al centro: l'orso piccolo (animato) con nome e stato. Tenendola premuta: nuova conversazione e avatar.
    private func companionCapsule(_ conversation: ConversationStore) -> some View {
        let caption = AvatarCaption.text(connection: conversation.connection, state: conversation.agentState) ?? "pronto"
        return HStack(spacing: 8) {
            PixelBearView(state: conversation.agentState, mouthOpen: model.speaker.mouthOpen, size: 32, emotion: conversation.lastAvatarEmotion)
                .frame(width: 36, height: 36)
                .background(Theme.accent, in: Circle())
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Self.ring(conversation.agentState), lineWidth: 2))
            VStack(alignment: .leading, spacing: 0) {
                Text(model.companionName).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(caption).font(.caption2).foregroundStyle(Self.captionColor(conversation))
                    .contentTransition(.opacity)
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 14)
        .padding(.vertical, 4)
        .ernieGlass(in: Capsule())
        .contextMenu {
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

    private static func ring(_ state: AgentState) -> Color {
        switch state {
        case .idle: Theme.accent.opacity(0.4)
        case .listening: .red
        case .thinking: .orange
        case .speaking: Theme.positive
        }
    }

    private static func captionColor(_ conversation: ConversationStore) -> Color {
        if case .connected = conversation.connection {
            return conversation.agentState == .idle ? Theme.inkSecondary : Theme.positive
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
    var body: some View {
        ZStack(alignment: .top) {
            Theme.ground
            Circle()
                .fill(Theme.glow)
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
                                .foregroundStyle(.white.opacity(0.85))
                                .lineLimit(1)
                        }
                    }
                    Text(message.text)
                    if message.queued == true {
                        Label("in attesa che Ernie finisca", systemImage: "clock")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.8))
                    }
                }
                .foregroundStyle(.white)
                .opacity(message.queued == true ? 0.75 : 1)
                .padding(.horizontal, 15)
                .padding(.vertical, 11)
                .background(
                    Theme.accent,
                    in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20, style: .continuous)
                )
                .shadow(color: Theme.accent.opacity(0.18), radius: 8, y: 4)
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                if !message.tools.isEmpty {
                    ForEach(message.tools) { tool in
                        ToolPill(name: tool.displayName ?? tool.toolId, ok: tool.ok)
                    }
                }
                if message.text.isEmpty, message.isStreaming, message.blocks.isEmpty {
                    ThinkingDots()
                } else if !message.text.isEmpty {
                    // Risposte di Ernie in testo pieno, senza fumetto (bozzetto 2).
                    MarkdownText(text: message.text)
                        .foregroundStyle(Theme.ink)
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
    let name: String
    let ok: Bool?

    var body: some View {
        HStack(spacing: 7) {
            ZStack {
                Circle().fill(ok == false ? Color.red.opacity(0.14) : Theme.accentSoft)
                Image(systemName: ok == nil ? "ellipsis" : (ok == true ? "checkmark" : "xmark"))
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(ok == false ? Color.red : Theme.accentText)
                    .symbolEffect(.variableColor.iterative, isActive: ok == nil)
            }
            .frame(width: 20, height: 20)
            Text(name)
                .font(.footnote)
                .foregroundStyle(Theme.inkSecondary)
                .lineLimit(1)
        }
        .padding(.leading, 4)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .background(Theme.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.hairline))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ok == nil ? "\(name), in corso" : ok == true ? "\(name), fatto" : "\(name), non riuscito")
    }
}

struct ThinkingDots: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { i in
                Circle().frame(width: 6, height: 6).opacity(phase == i ? 1 : 0.3)
            }
        }
        .foregroundStyle(.secondary)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(350))
                phase = (phase + 1) % 3
            }
        }
    }
}

struct ConfirmationCardView: View {
    let card: ConfirmationCard
    let conversation: ConversationStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Serve la tua conferma", systemImage: "hand.raised.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(SkillTint.reminders.color)
            Text(card.displayName ?? card.toolId)
            if let args = card.argsPreview {
                Text(args).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(4)
            }
            if let reason = card.reason {
                Text(reason).font(.caption).foregroundStyle(.secondary)
            }
            if let decision = card.decision {
                Text(decision == "approved" ? (card.always == true ? "Approvata · d'ora in poi senza chiedere" : "Approvata") : decision == "denied" ? "Rifiutata" : "Scaduta")
                    .font(.caption.weight(.semibold))
            } else {
                HStack {
                    Button("Rifiuta", role: .destructive) { conversation.respond(to: card, approve: false) }
                    Button("Approva") {
                        Task {
                            if await StepUp.authenticate(reason: "Conferma l'azione richiesta da Ernie") {
                                conversation.respond(to: card, approve: true)
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .buttonStyle(.bordered)
                if card.allowAlways == true {
                    Button {
                        Task {
                            if await StepUp.authenticate(reason: "Consenti sempre questa azione a Ernie") {
                                conversation.respond(to: card, approve: true, always: true)
                            }
                        }
                    } label: {
                        Label("Consenti sempre", systemImage: "checkmark.shield")
                    }
                    .font(.caption)
                    .buttonStyle(.borderless)
                    Text("Revocabile in Impostazioni → Conferme.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .ernieSurface()
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
