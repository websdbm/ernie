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
/// Sprite sheet 4×8 (`BearSheet`, celle di 256 px): riga 1 idle (neutro, respiro, neutro, battito di ciglia);
/// riga 2 ascolto (inclinato a sinistra, a destra) e pensiero (sguardo in alto, con punto interrogativo);
/// riga 3 bocca (chiusa, socchiusa, aperta, tonda); riga 4 emozioni (felice, sorpreso, triste, occhiolino).
/// Dal 15 ott 2026 (richiesta dell'utente: «più variabilità, occhiali da sole ed espressione feroce»):
/// riga 5 occhiali da sole (sorrisetto, sorriso, sopra gli occhiali, scintilla); riga 6 feroce (ringhio, ruggito,
/// determinato, sbuffi); riga 7 risata, cuori, imbarazzo, confuso; riga 8 sbadiglio, fiero, preoccupato, entusiasta.
struct PixelBearView: View {
    let state: AgentState
    let mouthOpen: Bool
    let size: CGFloat
    var emotion: String = ""

    /// Dopo quanto tempo a riposo l'orso si addormenta (occhi chiusi e «z»); qualunque attività lo sveglia.
    static let sleepAfter: TimeInterval = 120
    @State private var idleSince = Date()

    private static let columns = 4
    private static let rows = 8
    /// Variante scelta per l'emozione in corso (cambia a ogni emozione nuova).
    @State private var variant = Int.random(in: 0..<1000)

    /// A riposo, ogni tanto un'espressione diversa per qualche secondo: l'orso non resta sempre uguale.
    private static let moods = [16, 29, 15, 19, 18, 31, 12]

    /// Sequenza di fotogrammi e cadenza per stato.
    private func sequence(asleep: Bool) -> (frames: [Int], tick: Double) {
        switch state {
        case .idle:
            // Dorme: occhi chiusi, con uno sbadiglio ogni tanto.
            if asleep { return ([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 28, 28], 0.8) }
            // L'espressione resta, con un battito di ciglia breve ogni tanto (non con occhiali da sole o occhi chiusi).
            if let e = Self.emotionFrame(emotion, variant: variant) {
                return (Self.blinks(e) ? [e, e, e, e, e, e, e, 3] : [e], 0.6)
            }
            return ([0, 0, 1, 1, 0, 0, 0, 3, 0, 0, 0, 1, 1, 0, 3], 0.45)
        case .listening: return ([4, 4, 5, 5], 0.5)
        case .thinking: return ([6, 6, 7, 7, 6, 7], 0.55)
        case .speaking: return ([8, 9, 10, 9, 8, 11], 0.12)
        }
    }

    /// Fotogrammi possibili per ogni emozione del protocollo: a ogni emozione nuova se ne sceglie uno.
    static func emotionFrames(_ emotion: String) -> [Int]? {
        switch emotion.lowercased() {
        case "happy", "felice", "contento", "allegro", "joy": [12, 12, 29]
        case "love": [25, 12]
        case "surprised", "sorpreso", "stupito", "wow": [13]
        case "fear", "worried", "preoccupato": [30]
        case "sad", "triste", "dispiaciuto": [14]
        case "disgust": [27]
        case "playful", "wink", "scherzoso", "complice": [15, 17, 24]
        case "laughing", "laugh": [24]
        case "cool": [16, 17, 18, 19]
        case "proud", "fiero": [29, 19, 16]
        case "angry", "fierce", "feroce": [20, 21, 23]
        case "determined": [22, 20]
        case "embarrassed": [26]
        case "confused": [27]
        case "excited": [31, 17]
        case "sleep", "sleepy": [28]
        default: nil
        }
    }

    static func emotionFrame(_ emotion: String, variant: Int = 0) -> Int? {
        guard let frames = emotionFrames(emotion), !frames.isEmpty else { return nil }
        return frames[abs(variant) % frames.count]
    }

    /// Fotogrammi con gli occhi visibili e aperti: solo su questi ha senso il battito di ciglia.
    private static func blinks(_ frame: Int) -> Bool {
        ![3, 12, 15, 16, 17, 19, 24, 25, 28, 29, 31].contains(frame)
    }

    /// Espressione «d'umore» a riposo: in circa un terzo delle finestre di 40 s, per i primi 3 s.
    private static func mood(at date: Date) -> Int? {
        let t = date.timeIntervalSinceReferenceDate
        let slot = Int(t / 40)
        let h = UInt32(truncatingIfNeeded: slot &* 2_654_435_761)
        guard h % 3 == 0, t.truncatingRemainder(dividingBy: 40) < 3 else { return nil }
        return moods[Int(h >> 3) % moods.count]
    }

    /// Piccolo segno sopra l'orso: cuore per l'affetto (se gli occhi non sono già cuori), «!» per la sorpresa,
    /// «z» quando dorme.
    private func badge(asleep: Bool, frame: Int) -> String? {
        if state == .idle && asleep { return "z" }
        guard state == .idle else { return nil }
        switch emotion.lowercased() {
        case "love": return frame == 25 ? nil : "❤️"
        case "surprised": return "!"
        default: return nil
        }
    }

    var body: some View {
        // Ridisegno veloce solo mentre parla (bocca); a riposo bastano 5 fotogrammi al secondo.
        TimelineView(.periodic(from: .now, by: state == .speaking ? 0.12 : 0.2)) { context in
            let calm = state == .idle && Self.emotionFrame(emotion) == nil
            let asleep = calm && context.date.timeIntervalSince(idleSince) > Self.sleepAfter
            let seq = sequence(asleep: asleep)
            let step = Int(context.date.timeIntervalSinceReferenceDate / seq.tick) % max(seq.frames.count, 1)
            // Parlato: la bocca segue le parole del sintetizzatore (aperta/chiusa), con una leggera variazione di forma.
            let frame: Int = state == .speaking
                ? (mouthOpen ? [10, 11, 9][step % 3] : 8)
                : (calm && !asleep ? (Self.mood(at: context.date) ?? seq.frames[step]) : seq.frames[step])
            ZStack(alignment: .topTrailing) {
                SpriteFrame(sheet: "BearSheet", index: frame, columns: Self.columns, rows: Self.rows, size: size)
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.12), radius: size > 100 ? 10 : 4, y: size > 100 ? 6 : 2)
                if let mark = badge(asleep: asleep, frame: frame) {
                    // Sale e svanisce a scatti, come il resto dell'animazione in pixel art.
                    let phase = Double(Int(context.date.timeIntervalSinceReferenceDate / 0.4) % 5) / 4
                    Text(mark)
                        .font(.system(size: max(12, size * 0.18), weight: .heavy, design: .rounded))
                        .foregroundStyle(mark == "z" ? Color.white : Color.orange)
                        .shadow(color: .black.opacity(0.35), radius: 1, y: 1)
                        // Dentro il cerchio, in alto a destra: fuori verrebbe tagliato dal contenitore.
                        .offset(x: -size * 0.1, y: size * 0.06 - phase * size * 0.1)
                        .opacity(1 - phase * 0.6)
                        .allowsHitTesting(false)
                }
            }
        }
        .frame(width: size, height: size)
        .onChange(of: state) { idleSince = .now }
        .onChange(of: emotion) {
            idleSince = .now
            variant = Int.random(in: 0..<1000)
        }
        .onChange(of: mouthOpen) { idleSince = .now }
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
