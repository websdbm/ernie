import SwiftUI

/// L'unica schermata: spazio per l'avatar in alto, conversazione, una barra con un solo pulsante.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var showBrain = false
    @State private var showReminders = false
    @State private var showSkills = false
    @State private var debugIcons = false
    @State private var draft = ""
    @FocusState private var composing: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let conversation = model.conversation, let voice = model.voice {
                    VStack(spacing: 0) {
                        // L'avatar galleggia sulla conversazione: i messaggi scorrono sotto e restano visibili
                        // attorno al cerchio (richiesta dell'utente, 12 ott 2026).
                        ZStack(alignment: .top) {
                            MessageList(conversation: conversation, topInset: FloatingAvatar.topInset(model.settings, composing: composing))
                            FloatingAvatar(
                                state: conversation.agentState,
                                name: model.companionName,
                                connection: conversation.connection,
                                emotion: conversation.lastAvatarEmotion,
                                composing: composing,
                                mouthOpen: model.speaker.mouthOpen
                            )
                        }
                        InputBar(draft: $draft, composing: $composing, conversation: conversation, voice: voice, onSkills: { showSkills = true }, documents: model.documents)
                    }
                    .background(ChatBackdrop())
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(model.companionName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // Voce accesa/spenta: in giro basta la risposta scritta.
                    Button { model.setVoiceOutput(!model.settings.voiceOutput) } label: {
                        Image(systemName: model.settings.voiceOutput ? "speaker.wave.2.fill" : "speaker.slash.fill")
                            .foregroundStyle(model.settings.voiceOutput ? Color.accentColor : Color.secondary)
                    }
                    .accessibilityLabel(model.settings.voiceOutput ? "Voce accesa: tocca per spegnerla" : "Voce spenta: tocca per accenderla")
                    Menu {
                        Button("Nuova conversazione", systemImage: "plus.bubble") { model.newConversation() }
                        Button("Second brain", systemImage: "brain.head.profile") { showBrain = true }
                        Button("Promemoria", systemImage: "alarm") { showReminders = true }
                        Button(model.settings.avatarHidden ? "Mostra avatar" : "Nascondi avatar", systemImage: model.settings.avatarHidden ? "eye" : "eye.slash") {
                            withAnimation(.spring(duration: 0.35)) { model.settings.avatarHidden.toggle() }
                            model.settings.save()
                        }
                        Button("Avatar in alto al centro", systemImage: "arrow.up.to.line") {
                            withAnimation(.spring(duration: 0.35)) {
                                model.settings.avatarHidden = false
                                model.settings.avatarAnchor = .top
                                model.settings.avatarCompact = false
                                model.settings.avatarSize = 132
                            }
                            model.settings.save()
                        }
                        Button("Impostazioni", systemImage: "gearshape") { showSettings = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Menu")
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showBrain) { SecondBrainView() }
            .sheet(isPresented: $showReminders) { RemindersView() }
            .sheet(isPresented: $showSkills) { SkillsSheet() }
            #if DEBUG
            .sheet(isPresented: $debugIcons) { IconGalleryView() }
            .onAppear { debugIcons = ProcessInfo.processInfo.environment["ERNIE_DEBUG_ICONS"] != nil }
            #endif
        }
    }
}

/// Sfondo della schermata: una velatura dell'accento in alto che sfuma nel colore di sistema.
struct ChatBackdrop: View {
    var body: some View {
        ZStack {
            Color(.systemBackground)
            LinearGradient(
                colors: [Color.accentColor.opacity(0.14), Color.accentColor.opacity(0.04), .clear],
                startPoint: .top,
                endPoint: .center
            )
        }
        .ignoresSafeArea()
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

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if conversation.items.isEmpty {
                        EmptyHint()
                    }
                    ForEach(conversation.items) { item in
                        switch item {
                        case .message(let m): MessageRow(message: m, conversation: conversation)
                        case .confirmation(let c): ConfirmationCardView(card: c, conversation: conversation)
                        case .notification(let n): NotificationCardView(card: n, conversation: conversation)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .contentMargins(.top, topInset, for: .scrollContent)
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
            }
        }
    }
}

private struct EmptyHint: View {
    var body: some View {
        VStack(spacing: 6) {
            Text("Scrivi, oppure tocca il microfono e parla.")
            Text("Promemoria, liste e proposte compaiono qui.")
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, 24)
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
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    LinearGradient(colors: [Color.accentColor, Color.accentColor.opacity(0.78)], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous)
                )
                .shadow(color: Color.accentColor.opacity(0.18), radius: 6, y: 3)
            }
        case .assistant:
            VStack(alignment: .leading, spacing: 6) {
                if !message.tools.isEmpty {
                    ForEach(message.tools) { tool in
                        HStack(spacing: 6) {
                            Image(systemName: tool.ok == nil ? "circle.dotted" : (tool.ok == true ? "checkmark.circle" : "xmark.circle"))
                            Text(tool.displayName ?? tool.toolId)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                }
                if message.text.isEmpty, message.isStreaming, message.blocks.isEmpty {
                    ThinkingDots()
                } else if !message.text.isEmpty {
                    MarkdownText(text: message.text)
                }
                ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, block in
                    BlockView(block: block, conversation: conversation)
                }
                if message.cancelled {
                    Text("Interrotto").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.trailing, 20)
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
            Label("Serve la tua conferma", systemImage: "hand.raised")
                .font(.subheadline.weight(.semibold))
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
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
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
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}
