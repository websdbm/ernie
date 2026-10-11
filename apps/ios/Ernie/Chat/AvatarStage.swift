import SwiftUI

/// Spazio riservato all'avatar tridimensionale (M10: `WKWebView` con three.js + TalkingHead).
/// Oggi mostra un segnaposto animato che reagisce allo stato dell'agente ed è consumatore della stessa macchina a stati.
struct AvatarStage: View {
    let state: AgentState
    let name: String
    let connection: ProtocolClient.ConnectionState
    let emotion: String
    var compact = false

    @State private var pulse = false

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

    private var tint: Color {
        switch state {
        case .idle: .accentColor
        case .listening: .red
        case .thinking: .orange
        case .speaking: .green
        }
    }

    var body: some View {
        VStack(spacing: compact ? 4 : 8) {
            ZStack {
                Circle()
                    .fill(tint.opacity(0.18))
                    .scaleEffect(pulse ? 1.08 : 0.94)
                Circle()
                    .fill(LinearGradient(colors: [tint.opacity(0.9), tint.opacity(0.5)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .padding(compact ? 10 : 18)
                Image(systemName: "face.smiling")
                    .font(.system(size: compact ? 20 : 40, weight: .light))
                    .foregroundStyle(.white)
            }
            .frame(width: compact ? 48 : 110, height: compact ? 48 : 110)
            .animation(.easeInOut(duration: state == .listening ? 0.5 : 1.6).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
            if !compact {
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, compact ? 6 : 14)
        .background(Color(.secondarySystemBackground))
        .animation(.easeInOut(duration: 0.2), value: compact)
        .accessibilityLabel("\(name), \(caption)")
        // M10: sostituire il contenuto con AvatarWebView(state:, emotion:) mantenendo questa API.
    }
}
