import SwiftUI

/// Avatar di Ernie: un orso in pixel art (decisione dell'utente, 11 ott 2026), lo stesso dell'icona, animato a fotogrammi
/// dagli atlanti `BearV3`. Il posizionamento sulla conversazione è in `FloatingAvatar`.
/// Il cerchio dell'avatar: alone al neon traslucido, anello dell'accento, anello di stato (ascolto/pensiero/parlato)
/// e l'orso animato. Usato dall'avatar galleggiante a qualunque dimensione.
struct AvatarBubble: View {
    @Environment(\.chatPalette) private var palette
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
                .fill(RadialGradient(colors: [palette.accentText.opacity(small ? 0.18 : 0.28), .clear], center: .center, startRadius: size * 0.42, endRadius: size * 0.5 + 22))
                .frame(width: size + 56, height: size + 56)
                .allowsHitTesting(false)
            Circle()
                .strokeBorder(palette.accentText.opacity(0.55), lineWidth: small ? 1.5 : 2)
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

/// Tutti i costumi condividono le stesse sequenze. Il foglio scelto resta invariato durante un gesto.
struct PixelBearView: View {
    let state: AgentState
    let mouthOpen: Bool
    let size: CGFloat
    var emotion: String = ""
    @AppStorage(BearCostume.preferenceKey) private var costumeChoice = BearCostume.automatic.rawValue
    @Environment(\.bearContext) private var bearContext
    @Environment(\.resolvedBearCostume) private var resolvedCostume
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var idleSince = Date()
    @State private var animationSince = Date()
    @State private var celebratedAt: Date?
    @State private var observedTurn: String?

    var body: some View {
        TimelineView(.animation(minimumInterval: state == .speaking ? 0.14 : 0.24,
                                paused: reduceMotion || scenePhase != .active)) { timeline in
            let idleFor = max(0, timeline.date.timeIntervalSince(idleSince))
            let costume = resolvedCostume ?? BearCostume.resolve(
                choice: costumeChoice, hour: Calendar.current.component(.hour, from: timeline.date),
                tools: state == .idle && idleFor > 45 ? [] : bearContext.tools, emotion: emotion)
            let frame = BearMotion.frame(
                state: state, emotion: emotion, mouthOpen: mouthOpen,
                elapsed: timeline.date.timeIntervalSince(animationSince), idleFor: idleFor,
                celebrationFor: celebratedAt.map { timeline.date.timeIntervalSince($0) },
                reduceMotion: reduceMotion || scenePhase != .active)
            BearFrame(costume: costume, index: frame, size: size)
                .clipShape(Circle())
                .shadow(color: .black.opacity(0.12), radius: size > 100 ? 10 : 4, y: size > 100 ? 6 : 2)
        }
        .frame(width: size, height: size)
        .onAppear { observedTurn = bearContext.streamingID }
        .onChange(of: state) { idleSince = .now; animationSince = .now }
        .onChange(of: emotion) { idleSince = .now; animationSince = .now }
        .onChange(of: scenePhase) {
            if scenePhase == .active { idleSince = .now; animationSince = .now }
        }
        .onChange(of: bearContext) {
            if let streaming = bearContext.streamingID {
                observedTurn = streaming
            } else {
                // Solo un turno visto in streaming e realmente completato, non la riapertura dello storico.
                if let observedTurn, observedTurn == bearContext.completedID { celebratedAt = .now }
                observedTurn = nil
            }
        }
        .accessibilityHidden(true)
    }
}

/// Un fotogramma dello sprite sheet, disegnato senza interpolazione (pixel netti a ogni dimensione).
struct SpriteFrame: View {
    let sheet: String
    let index: Int
    let columns: Int
    let rows: Int
    let size: CGFloat

    var body: some View {
        // Ogni fotogramma è un'immagine a sé, ritagliata una volta dal foglio: quando l'avatar cambia dimensione
        // con l'animazione si scala solo la cella, e le celle vicine non possono affacciarsi ai bordi.
        if let cell = SpriteCells.cell(sheet: sheet, index: index, columns: columns, rows: rows) {
            Image(uiImage: cell)
                .resizable()
                .interpolation(.none)
                .frame(width: size, height: size)
        } else {
            Color.clear.frame(width: size, height: size)
        }
    }
}

/// Celle degli sprite sheet, ritagliate in pixel dal foglio e tenute in memoria (16 immagini piccole per foglio).
@MainActor
enum SpriteCells {
    private static var cache: [String: [UIImage]] = [:]

    static func cell(sheet: String, index: Int, columns: Int, rows: Int) -> UIImage? {
        let key = "\(sheet)#\(columns)x\(rows)"
        if cache[key] == nil { cache[key] = slice(sheet: sheet, columns: columns, rows: rows) }
        guard let cells = cache[key], cells.indices.contains(index) else { return nil }
        return cells[index]
    }

    private static func slice(sheet: String, columns: Int, rows: Int) -> [UIImage] {
        guard let image = UIImage(named: sheet), let cg = image.cgImage else { return [] }
        let w = cg.width / columns
        let h = cg.height / rows
        var out: [UIImage] = []
        for i in 0..<(columns * rows) {
            let rect = CGRect(x: (i % columns) * w, y: (i / columns) * h, width: w, height: h)
            guard let piece = cg.cropping(to: rect) else { return [] }
            out.append(UIImage(cgImage: piece, scale: image.scale, orientation: image.imageOrientation))
        }
        return out
    }
}
