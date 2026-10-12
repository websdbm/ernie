import SwiftUI

/// Avatar di Ernie: un orso in pixel art (decisione dell'utente, 11 ott 2026), lo stesso dell'icona, animato a fotogrammi
/// dallo sprite sheet `BearSheet`. Il posizionamento sulla conversazione è in `FloatingAvatar`.
/// Il cerchio dell'avatar: alone al neon traslucido, anello dell'accento, anello di stato (ascolto/pensiero/parlato)
/// e l'orso animato. Usato dall'avatar galleggiante a qualunque dimensione.
struct AvatarBubble: View {
    let state: AgentState
    let emotion: String
    let mouthOpen: Bool
    let size: CGFloat

    private var ringColor: Color {
        switch state {
        case .idle: .clear
        case .listening: .red
        case .thinking: .orange
        case .speaking: .green
        }
    }

    var body: some View {
        let small = size < 90
        ZStack {
            // L'alone è solo decorativo: non intercetta i tocchi (la chat sotto resta usabile).
            Circle()
                .fill(RadialGradient(colors: [Color.accentColor.opacity(small ? 0.18 : 0.28), .clear], center: .center, startRadius: size * 0.42, endRadius: size * 0.5 + 22))
                .frame(width: size + 56, height: size + 56)
                .allowsHitTesting(false)
            Circle()
                .strokeBorder(Color.accentColor.opacity(0.55), lineWidth: small ? 1.5 : 2)
                .frame(width: size + 8, height: size + 8)
            Circle()
                .stroke(ringColor.opacity(0.75), lineWidth: small ? 3 : 5)
                .frame(width: size + 14, height: size + 14)
                .opacity(state == .idle ? 0 : 1)
            PixelBearView(state: state, mouthOpen: mouthOpen, size: size, emotion: emotion)
        }
        .frame(width: size + 16, height: size + 16)
        .animation(.easeInOut(duration: 0.2), value: state)
    }
}

/// Testo di stato sotto l'avatar («ti ascolto», «ci penso», «connessione…»); a riposo non c'è niente da dire.
enum AvatarCaption {
    static func text(connection: ProtocolClient.ConnectionState, state: AgentState) -> String? {
        switch connection {
        case .connecting, .reconnecting: return "connessione…"
        case .disconnected: return "non connesso"
        case .connected:
            switch state {
            case .idle: return nil
            case .listening: return "ti ascolto"
            case .thinking: return "ci penso"
            case .speaking: return "parlo"
            }
        }
    }
}

/// L'orso in pixel art animato a fotogrammi (decisione dell'utente: animazioni disegnate, non procedurali).
/// Sprite sheet 4×4 (`BearSheet`, celle di 256 px): riga 1 idle (neutro, respiro, neutro, battito di ciglia);
/// riga 2 ascolto (inclinato a sinistra, a destra) e pensiero (sguardo in alto, con punto interrogativo);
/// riga 3 bocca (chiusa, socchiusa, aperta, tonda); riga 4 emozioni (felice, sorpreso, triste, occhiolino).
struct PixelBearView: View {
    let state: AgentState
    let mouthOpen: Bool
    let size: CGFloat
    var emotion: String = ""

    private static let columns = 4
    private static let rows = 4

    /// Sequenza di fotogrammi e cadenza per stato.
    private var sequence: (frames: [Int], tick: Double) {
        switch state {
        case .idle:
            if let e = Self.emotionFrame(emotion) { return ([e, e, e, 0], 1.2) }
            return ([0, 0, 1, 1, 0, 0, 0, 3, 0, 0, 0, 1, 1, 0, 3], 0.45)
        case .listening: return ([4, 4, 5, 5], 0.5)
        case .thinking: return ([6, 6, 7, 7, 6, 7], 0.55)
        case .speaking: return ([8, 9, 10, 9, 8, 11], 0.12)
        }
    }

    static func emotionFrame(_ emotion: String) -> Int? {
        switch emotion.lowercased() {
        case "happy", "felice", "contento", "allegro", "joy": 12
        case "surprised", "sorpreso", "stupito", "wow": 13
        case "sad", "triste", "dispiaciuto", "worried", "preoccupato": 14
        case "playful", "wink", "scherzoso", "complice": 15
        default: nil
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: sequence.tick)) { context in
            let seq = sequence
            let step = Int(context.date.timeIntervalSinceReferenceDate / seq.tick) % max(seq.frames.count, 1)
            // Parlato: la bocca segue le parole del sintetizzatore (aperta/chiusa), con una leggera variazione di forma.
            let frame: Int = state == .speaking
                ? (mouthOpen ? [10, 11, 9][step % 3] : 8)
                : (seq.frames[step])
            SpriteFrame(sheet: "BearSheet", index: frame, columns: Self.columns, rows: Self.rows, size: size)
                .clipShape(Circle())
                .shadow(color: .black.opacity(0.12), radius: size > 100 ? 10 : 4, y: size > 100 ? 6 : 2)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Un fotogramma dello sprite sheet: l'immagine intera scorre dietro una finestra quadrata, senza interpolazione.
struct SpriteFrame: View {
    let sheet: String
    let index: Int
    let columns: Int
    let rows: Int
    let size: CGFloat

    var body: some View {
        let col = CGFloat(index % columns)
        let row = CGFloat(index / columns)
        Image(sheet)
            .resizable()
            .interpolation(.none)
            .frame(width: size * CGFloat(columns), height: size * CGFloat(rows))
            .offset(x: -col * size, y: -row * size)
            .frame(width: size, height: size, alignment: .topLeading)
            .clipped()
    }
}
