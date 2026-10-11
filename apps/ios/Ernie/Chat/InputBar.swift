import SwiftUI

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

    private enum Mode { case mic, send, stop, voice }

    private var mode: Mode {
        if voice.isActive { return .voice }
        if !draft.trimmingCharacters(in: .whitespaces).isEmpty { return .send }
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
            HStack(alignment: .bottom, spacing: 10) {
                if mode == .voice {
                    Button { voice.cancelListening() } label: { icon("xmark", fill: .secondary) }
                        .accessibilityLabel("Annulla")
                    voicePanel
                    voiceButton
                } else {
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
        conversation.send(text, inputMode: "text")
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
