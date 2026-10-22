import SwiftUI

/// Schermata di ascolto (bozzetto «In ascolto»), a tutto schermo sopra la chat mentre il microfono si prepara, scarica
/// il modello, ascolta o trascrive. In alto lo stato, al centro l'orso con gli anelli che seguono il livello del microfono,
/// poi l'onda, la trascrizione in tempo reale e i due pulsanti: ✕ annulla, ↑ invia quello che si è detto.
struct ListeningOverlay: View {
    let voice: VoiceController
    let conversation: ConversationStore

    /// Pesi delle dodici barre dell'onda: ognuna reagisce al livello con un'ampiezza diversa.
    private static let barWeights: [CGFloat] = [0.45, 0.7, 0.6, 0.9, 0.75, 1, 0.8, 0.95, 0.65, 0.85, 0.55, 0.4]

    /// Contatori dei pulsanti: `sensoryFeedback` reagisce a un valore che cambia.
    @State private var cancelTaps = 0
    @State private var sendTaps = 0

    /// Livello del microfono limitato a 0…1.
    private var level: CGFloat { CGFloat(min(max(voice.inputLevel, 0), 1)) }

    /// Invio possibile solo mentre il microfono ascolta davvero.
    private var canSend: Bool { voice.phase == .listening }

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            VStack(spacing: 0) {
                statusChip
                    .padding(.top, 8)
                Spacer(minLength: 12)
                bearStage
                Spacer(minLength: 12)
                waveform
                Spacer(minLength: 16)
                transcript
                hint
                    .padding(.top, 8)
                Spacer(minLength: 20)
                controls
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .animation(.easeInOut(duration: 0.2), value: voice.phase)
        }
    }

    // MARK: - parti

    /// Capsula in alto: cosa sta succedendo adesso, con il tempo «a mani libere» e l'avanzamento del download.
    private var statusChip: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                statusMark
                Text(statusLabel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                    .contentTransition(.opacity)
            }
            if voice.continuous {
                Text("a mani libere")
                    .font(.caption)
                    .foregroundStyle(Theme.inkSecondary)
            }
            if case .downloadingModel(let progress) = voice.phase {
                ProgressView(value: progress)
                    .tint(Theme.accent)
                    .frame(width: 160)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .ernieGlass(in: Capsule())
        .accessibilityElement(children: .combine)
    }

    /// Pallino rosso mentre ascolta; zampa animata durante preparazione e trascrizione.
    @ViewBuilder
    private var statusMark: some View {
        if voice.phase == .listening {
            Circle()
                .fill(.red)
                .frame(width: 9, height: 9)
                .accessibilityHidden(true)
        } else {
            BearActivityIcon(status: .working, size: 22)
        }
    }

    private var statusLabel: String {
        switch voice.phase {
        case .idle: ""
        case .preparing: "Preparo il microfono…"
        case .downloadingModel(let progress): "Scarico il modello vocale… \(Int(min(max(progress, 0), 1) * 100))%"
        case .listening: "Ti ascolto"
        case .finalizing: "Trascrivo…"
        case .waitingReply: "Ernie risponde…"
        }
    }

    /// L'orso al centro, con due anelli sottili che si allargano appena con la voce. Decorativo per VoiceOver.
    private var bearStage: some View {
        ZStack {
            ZStack {
                Circle()
                    .strokeBorder(Theme.accent.opacity(0.10), lineWidth: 1)
                    .frame(width: 250, height: 250)
                Circle()
                    .strokeBorder(Theme.accent.opacity(0.18), lineWidth: 1)
                    .frame(width: 300, height: 300)
            }
            .scaleEffect(1 + level * 0.08)
            .animation(.easeOut(duration: 0.12), value: level)

            AvatarBubble(
                state: conversation.agentState,
                emotion: conversation.lastAvatarEmotion,
                mouthOpen: false,
                size: 180
            )
        }
        .frame(width: 300, height: 300)
        .background {
            // Alone morbido dietro l'orso: non occupa spazio nel layout.
            Circle()
                .fill(Theme.glow)
                .frame(width: 330, height: 330)
                .blur(radius: 40)
        }
        .accessibilityHidden(true)
    }

    /// Onda di dodici barre: a silenzio restano piccoli puntini, con la voce si allungano sfumando verso destra.
    private var waveform: some View {
        HStack(alignment: .center, spacing: 5) {
            ForEach(Self.barWeights.indices, id: \.self) { index in
                let weight = Self.barWeights[index]
                let fade = Double(index) / Double(Self.barWeights.count - 1)
                Capsule()
                    .fill(Theme.accent.opacity(1 - 0.55 * fade))
                    .frame(width: 5, height: 5 + 3 * weight + 40 * level * weight)
            }
        }
        .frame(height: 48)
        .animation(.easeOut(duration: 0.1), value: level)
        .accessibilityHidden(true)
    }

    /// Trascrizione in tempo reale (quattro righe al massimo); a vuoto un invito. VoiceOver ascolta gli aggiornamenti.
    private var transcript: some View {
        let text = voice.liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let isEmpty = text.isEmpty
        return Text(isEmpty ? "Parla pure, ti ascolto" : text)
            .font(isEmpty ? Theme.title(20, weight: .medium) : Theme.title(24, weight: .semibold))
            .foregroundStyle(isEmpty ? Theme.inkSecondary : Theme.ink)
            .multilineTextAlignment(.center)
            .lineLimit(4)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .top)
            .contentTransition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: text)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(isEmpty ? "Parla pure, ti ascolto" : text)
            .accessibilityAddTraits(.updatesFrequently)
    }

    /// Suggerimento sul gesto di chiusura: a mani libere l'invio è automatico.
    private var hint: some View {
        Text(voice.continuous ? "Smetti di parlare e invio da solo" : "Tocca ↑ quando hai finito")
            .font(.footnote)
            .foregroundStyle(Theme.inkSecondary)
            .multilineTextAlignment(.center)
    }

    /// ✕ a sinistra, invio al centro; a destra uno spazio della stessa larghezza, così l'invio resta centrato.
    private var controls: some View {
        HStack {
            GlassCircleButton(systemName: "xmark", tint: Theme.ink, size: 56, label: "Annulla") {
                cancelTaps += 1
                voice.cancelListening()
            }
            .sensoryFeedback(.impact(weight: .light), trigger: cancelTaps)
            Spacer()
            sendButton
            Spacer()
            Color.clear
                .frame(width: 56, height: 56)
                .accessibilityHidden(true)
        }
    }

    /// Pulsante d'invio da 76 pt, viola, con alone; spento (grigio, senza alone) finché non si ascolta.
    private var sendButton: some View {
        Button {
            sendTaps += 1
            voice.finishListening()
        } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 76, height: 76)
                .background(canSend ? Theme.accent : Theme.inkSecondary.opacity(0.35), in: Circle())
                .shadow(color: canSend ? Theme.accent.opacity(0.35) : .clear, radius: 14, y: 6)
                .background {
                    // Alone: un anello di 8 pt appena fuori dal pulsante (linea centrata a 84 pt, larga 8 pt).
                    Circle()
                        .stroke(Theme.accent.opacity(canSend ? 0.14 : 0), lineWidth: 8)
                        .frame(width: 84, height: 84)
                }
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel("Invia quello che ho detto")
        .sensoryFeedback(.impact(weight: .medium), trigger: sendTaps)
    }
}
