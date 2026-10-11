import SwiftUI

/// Un campo e un solo pulsante: microfono da tenere premuto, invio quando c'è testo, stop mentre Ernie parla.
struct InputBar: View {
    @Binding var draft: String
    var composing: FocusState<Bool>.Binding
    let conversation: ConversationStore
    let voice: VoiceController
    @State private var pressing = false

    private enum Mode { case mic, send, stop, listening }

    private var mode: Mode {
        if voice.isListening { return .listening }
        if !draft.trimmingCharacters(in: .whitespaces).isEmpty { return .send }
        if conversation.isBusy { return .stop }
        return .mic
    }

    var body: some View {
        VStack(spacing: 6) {
            if voice.isListening || !voice.liveTranscript.isEmpty && voice.isFinalizing {
                Text(voice.liveTranscript.isEmpty ? "Ti ascolto…" : voice.liveTranscript)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .transition(.opacity)
            }
            if let error = voice.lastError ?? conversation.lastError {
                Text(error).font(.caption2).foregroundStyle(.red).padding(.horizontal, 20)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Scrivi, o tieni premuto il microfono", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(composing)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22))
                    .onSubmit(sendDraft)
                actionButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .animation(.easeInOut(duration: 0.15), value: voice.isListening)
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
        case .mic, .listening:
            icon(mode == .listening ? "waveform" : "mic.fill", fill: mode == .listening ? .red : Color.accentColor)
                .scaleEffect(pressing ? 1.12 : 1)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in
                            if !pressing {
                                pressing = true
                                composing.wrappedValue = false
                                voice.beginPushToTalk()
                            }
                        }
                        .onEnded { _ in
                            pressing = false
                            voice.endPushToTalk()
                        }
                )
                .accessibilityLabel("Tieni premuto per parlare")
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
