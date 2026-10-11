import SwiftUI

/// Spazio riservato all'avatar (M10: `WKWebView` con three.js + TalkingHead e un personaggio peluche 3D).
/// Oggi mostra la mascotte di Ernie (stile peluche morbido, decisione dell'utente dell'11 ott 2026) che reagisce
/// allo stato dell'agente ed è consumatrice della stessa macchina a stati.
struct AvatarStage: View {
    let state: AgentState
    let name: String
    let connection: ProtocolClient.ConnectionState
    let emotion: String
    var compact = false

    @State private var breathe = false

    private var caption: String {
        switch connection {
        case .connecting, .reconnecting: return "connessione…"
        case .disconnected: return "non connesso"
        case .connected:
            switch state {
            case .idle: return "pronto"
            case .listening: return "ti ascolto"
            case .thinking: return "ci penso"
            case .speaking: return "parlo"
            }
        }
    }

    private var ringColor: Color {
        switch state {
        case .idle: .clear
        case .listening: .red
        case .thinking: .orange
        case .speaking: .green
        }
    }

    private var size: CGFloat { compact ? 56 : 150 }

    /// Respiro lento da fermo, pulsazione rapida in ascolto, oscillazione quando pensa, battito quando parla.
    private var pulse: Animation {
        let duration: Double = switch state {
        case .listening: 0.45
        case .speaking: 0.3
        case .thinking: 0.6
        case .idle: 1.8
        }
        return .easeInOut(duration: duration).repeatForever(autoreverses: true)
    }

    var body: some View {
        VStack(spacing: compact ? 4 : 8) {
            // L'animazione è scoperta solo su scala e rotazione: mai sul layout (altrimenti anima anche la posizione iniziale).
            ZStack {
                Circle()
                    .stroke(ringColor.opacity(0.55), lineWidth: compact ? 3 : 5)
                    .opacity(state == .idle ? 0 : 1)
                    .scaleEffect(breathe ? 1.06 : 0.98)
                    .animation(pulse, value: breathe)
                Image("Mascot")
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.12), radius: compact ? 4 : 10, y: compact ? 2 : 6)
                    .scaleEffect(breathe ? 1.02 : 0.99)
                    .rotationEffect(.degrees(state == .thinking ? (breathe ? 2 : -2) : 0))
                    .animation(pulse, value: breathe)
            }
            .frame(width: size + 16, height: size + 16)
            .id(state)
            .onAppear { breathe = true }
            if !compact {
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, compact ? 6 : 12)
        .background(Color(.secondarySystemBackground))
        .accessibilityLabel("\(name), \(caption)")
        // M10: sostituire il contenuto con AvatarWebView(state:, emotion:) mantenendo questa API; `emotion` è già disponibile.
    }
}
