import SwiftUI

/// L'unica schermata: spazio per l'avatar in alto, conversazione, una barra con un solo pulsante.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var showSkills = false
    @State private var draft = ""
    @FocusState private var composing: Bool

    var body: some View {
        NavigationStack {
            Group {
                if let conversation = model.conversation, let voice = model.voice {
                    VStack(spacing: 0) {
                        AvatarStage(
                            state: conversation.agentState,
                            name: model.companionName,
                            connection: conversation.connection,
                            emotion: conversation.lastAvatarEmotion,
                            compact: composing
                        )
                        MessageList(conversation: conversation)
                        InputBar(draft: $draft, composing: $composing, conversation: conversation, voice: voice)
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(model.companionName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // Skill a portata di mano: pannello a scomparsa, senza lasciare la conversazione.
                    Button { showSkills = true } label: { Image(systemName: "sparkles") }
                        .accessibilityLabel("Skill")
                    Menu {
                        Button("Nuova conversazione", systemImage: "plus.bubble") { model.newConversation() }
                        Button("Skill", systemImage: "sparkles") { showSkills = true }
                        Button("Impostazioni", systemImage: "gearshape") { showSettings = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Menu")
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showSkills) { SkillsSheet() }
        }
    }
}

struct MessageList: View {
    let conversation: ConversationStore

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
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: tail) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }
}

private struct EmptyHint: View {
    var body: some View {
        VStack(spacing: 6) {
            Text("Scrivi, oppure tieni premuto il microfono e parla.")
            Text("Le proposte delle automazioni compaiono qui.")
        }
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
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
                Text(message.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.accentColor.opacity(0.18), in: RoundedRectangle(cornerRadius: 18))
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
                Text(decision == "approved" ? "Approvata" : decision == "denied" ? "Rifiutata" : "Scaduta")
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
        case "automation.error", "automation.deadletter": "exclamationmark.triangle"
        default: "sparkles"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(card.title, systemImage: icon).font(.subheadline.weight(.semibold))
            MarkdownText(text: expanded ? card.body : String(card.body.prefix(420)) + (card.body.count > 420 ? "…" : ""), font: .callout)
                .onTapGesture { expanded.toggle() }
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
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}
