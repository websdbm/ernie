import SwiftUI

/// Spazio riservato all'avatar. Decisione dell'utente (11 ott 2026, sera): Ernie è un orso in pixel art (occhiali tondi,
/// ciuffo chiaro, cornice al neon viola), lo stesso dell'icona. L'animazione è a sprite «procedurale»: movimenti a scatti
/// di pixel (respiro, inclinazione quando pensa, bocca che si apre a ogni parola pronunciata), senza sfocature.
/// M10 sostituirà l'immagine singola con uno sprite sheet (più fotogrammi) mantenendo questa API.
struct AvatarStage: View {
    let state: AgentState
    let name: String
    let connection: ProtocolClient.ConnectionState
    let emotion: String
    var compact = false
    /// Bocca aperta/chiusa mentre Ernie parla (dal sintetizzatore vocale).
    var mouthOpen = false

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

    var body: some View {
        VStack(spacing: compact ? 4 : 8) {
            ZStack {
                Circle()
                    .stroke(ringColor.opacity(0.55), lineWidth: compact ? 3 : 5)
                    .opacity(state == .idle ? 0 : 1)
                PixelBearView(state: state, mouthOpen: mouthOpen, size: size)
            }
            .frame(width: size + 16, height: size + 16)
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
        // M10: sprite sheet con più fotogrammi (idle, ascolto, pensiero, parlato, emozioni) dietro la stessa API.
    }
}

/// L'orso in pixel art: resa senza interpolazione, movimenti a scatti di «pixel grossi» a seconda dello stato,
/// bocca disegnata sopra l'immagine quando parla (sincronizzata con le parole del sintetizzatore).
struct PixelBearView: View {
    let state: AgentState
    let mouthOpen: Bool
    let size: CGFloat

    /// Pixel grosso dell'immagine (600 px per ~75 celle) in punti.
    private var cell: CGFloat { size / 75 }

    /// Cadenza del respiro per stato (secondi per scatto).
    private var tick: Double {
        switch state {
        case .idle: 0.6
        case .listening: 0.25
        case .thinking: 0.4
        case .speaking: 0.3
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: tick)) { context in
            let phase = Int(context.date.timeIntervalSinceReferenceDate / tick) % 4
            let bob: CGFloat = [0, -1, 0, 1][phase] * cell
            let lean: CGFloat = state == .listening ? [0, 1, 0, -1][phase] * cell : 0
            let tilt: Double = state == .thinking ? [-3, 0, 3, 0][phase] : 0
            ZStack {
                Image("Mascot")
                    .resizable()
                    .interpolation(.none)
                    .scaledToFill()
                    .frame(width: size, height: size)
                // Bocca: un rettangolo scuro a pixel sotto il naso, visibile solo a bocca aperta.
                if mouthOpen {
                    RoundedRectangle(cornerRadius: cell * 0.8)
                        .fill(Color(red: 0.10, green: 0.05, blue: 0.03))
                        .frame(width: cell * 7, height: cell * 3)
                        .overlay(
                            RoundedRectangle(cornerRadius: cell * 0.5)
                                .fill(Color(red: 0.55, green: 0.18, blue: 0.22))
                                .frame(width: cell * 4, height: cell * 1.2)
                                .offset(y: cell * 0.5)
                        )
                        .offset(x: cell * 0.8, y: size * 0.325)
                }
            }
            .clipShape(Circle())
            .shadow(color: .black.opacity(0.12), radius: size > 100 ? 10 : 4, y: size > 100 ? 6 : 2)
            .offset(x: lean, y: bob)
            .rotationEffect(.degrees(tilt))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
