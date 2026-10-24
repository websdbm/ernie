import SwiftUI
import SpriteKit

struct ErnieTRIXView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var session: ErnieTRIXSession
    @State private var scene: ErnieTRIXScene
    @State private var confirmRestart = false
    private let costume: BearCostume
    private var palette: ChatPalette { ChatPalette(costume: costume) }

    init(storageID: String, costume: BearCostume) {
        self.init(session: ErnieTRIXSession(storageID: storageID), costume: costume)
    }

    init(session: ErnieTRIXSession, costume: BearCostume) {
        self.costume = costume
        _session = State(initialValue: session)
        _scene = State(initialValue: ErnieTRIXScene(session: session, accent: UIColor(ChatPalette(costume: costume).accentText)))
    }

    var body: some View {
        GeometryReader { geometry in
            let cell = max(6, min((geometry.size.width - 32) / 10, (geometry.size.height - 270) / 20))
            VStack(spacing: 8) {
                header
                statistics
                Spacer(minLength: 0)
                ZStack {
                    SpriteView(scene: scene, isPaused: session.game.status != .playing,
                               preferredFramesPerSecond: 60, options: [.ignoresSiblingOrder])
                        .accessibilityLabel("Campo ErnieTRIX: 10 colonne e 20 righe")
                    if session.game.status != .playing { pauseOverlay }
                }
                .frame(width: cell * 10, height: cell * 20)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.accentText.opacity(0.75), lineWidth: 2))
                Spacer(minLength: 0)
                controls
                HStack {
                    Text("RECORD \(session.record)")
                        .font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary)
                    Spacer()
                    Button { session.perform(.drop) } label: {
                        Label("Caduta rapida", systemImage: "arrow.down.to.line")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .padding(.horizontal, 10).frame(minHeight: 36)
                    }
                    .buttonStyle(.bordered).tint(palette.accentText)
                    .disabled(session.game.status != .playing)
                    .accessibilityHint("Posa subito il pezzo sulla sagoma")
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(LinearGradient(colors: [palette.glow.opacity(0.6), palette.ground, palette.ground], startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea())
        .chatAppearance(costume: costume)
        .preferredColorScheme(.dark)
        .onAppear { scene.reduceMotion = reduceMotion }
        .onChange(of: reduceMotion) { scene.reduceMotion = reduceMotion }
        .onChange(of: session.game.status) { scene.resetClock() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { session.pause() } }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in session.pause() }
        .onDisappear { session.pause() }
        .confirmationDialog("Ricominciare la partita?", isPresented: $confirmRestart, titleVisibility: .visible) {
            Button("Nuova partita", role: .destructive) { session.restart() }
            Button("Annulla", role: .cancel) { }
        } message: { Text("Il record rimane salvato. La partita attuale verrà sostituita.") }
    }

    private var header: some View {
        HStack(spacing: 8) {
            PixelBearView(state: .idle, mouthOpen: false, size: 42,
                          emotion: session.game.status == .gameOver ? "sad" : (session.game.lastClearedRows.count > 1 ? "happy" : ""))
                .frame(width: 44, height: 44).accessibilityHidden(true)
            Text("ErnieTRIX")
                .font(.system(size: 25, weight: .black, design: .monospaced))
                .minimumScaleFactor(0.6).lineLimit(1)
                .foregroundStyle(palette.accentText)
            Spacer(minLength: 0)
            Button {
                if session.game.status == .playing { session.pause() } else { session.resume() }
            } label: {
                Image(systemName: session.game.status == .playing ? "pause.fill" : "play.fill").frame(width: 44, height: 44)
            }
            .accessibilityLabel(session.game.status == .playing ? "Pausa" : "Riprendi")
            .disabled(session.game.status == .gameOver)
            Button { session.pause(); dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                .accessibilityLabel("Chiudi ErnieTRIX e salva la partita")
        }
        .buttonStyle(.plain)
        .foregroundStyle(palette.accentText)
        .frame(height: 48)
    }

    private var statistics: some View {
        HStack(spacing: 10) {
            stat("PUNTI", value: session.game.score)
            stat("LIVELLO", value: session.game.level)
            stat("RIGHE", value: session.game.lines)
            Spacer(minLength: 0)
            VStack(spacing: 2) {
                Text("PROSSIMO").font(.system(size: 9, weight: .bold, design: .monospaced))
                TRIXNextPiece(kind: session.game.next).frame(width: 52, height: 26)
            }.accessibilityLabel("Prossimo pezzo: \(String(describing: session.game.next).uppercased())")
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 8))
        .frame(height: 50)
    }
    private func stat(_ title: String, value: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 9, weight: .bold, design: .monospaced)).foregroundStyle(.secondary)
            Text(value.formatted()).font(.system(size: 18, weight: .bold, design: .monospaced))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
        }.accessibilityElement(children: .combine)
    }
    private var pauseOverlay: some View {
        VStack(spacing: 14) {
            Text(session.game.status == .gameOver ? "PARTITA FINITA" : (session.game.piecesPlaced == 0 && session.game.score == 0 ? "PRONTO?" : "IN PAUSA"))
                .font(.system(size: 20, weight: .black, design: .monospaced))
                .minimumScaleFactor(0.6).lineLimit(1)
            if session.game.status == .gameOver {
                Text("\(session.game.score) punti").font(.headline)
                Button("Gioca ancora") { session.restart() }.buttonStyle(.borderedProminent)
            } else {
                Button(session.game.piecesPlaced == 0 && session.game.score == 0 ? "Gioca" : "Riprendi") { session.resume() }
                    .buttonStyle(.borderedProminent)
                Button("Nuova partita") { confirmRestart = true }.buttonStyle(.bordered)
            }
        }
        .tint(palette.accent).padding(18)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black.opacity(0.8))
    }
    private var controls: some View {
        HStack(spacing: 10) {
            control("Sinistra", icon: "arrow.left", command: .left, repeats: true)
            control("Scendi", icon: "arrow.down", command: .down, repeats: true)
            control("Destra", icon: "arrow.right", command: .right, repeats: true)
            control("Ruota", icon: "arrow.clockwise", command: .rotate, repeats: false)
        }.frame(height: 64)
    }
    private func control(_ title: String, icon: String, command: ErnieTRIXEngine.Command, repeats: Bool) -> some View {
        VStack(spacing: 3) {
            TRIXPadControl(icon: icon, label: title, tint: UIColor(palette.accentText),
                           enabled: session.game.status == .playing, repeats: repeats) { session.perform(command) }
                .frame(minHeight: 44)
            Text(title.uppercased()).font(.system(size: 9, weight: .bold, design: .monospaced))
                .lineLimit(1).minimumScaleFactor(0.7).accessibilityHidden(true)
        }.frame(maxWidth: .infinity)
    }
}

private struct TRIXNextPiece: View {
    let kind: TRIXKind
    var body: some View {
        let cells = kind.cells
        let minX = cells.map(\.x).min() ?? 0
        let minY = cells.map(\.y).min() ?? 0
        let width = (cells.map(\.x).max() ?? 0) - minX + 1
        ZStack(alignment: .topLeading) {
            ForEach(cells, id: \.self) { cell in
                Image(uiImage: TRIXFur.images[kind.rawValue - 1]).resizable().interpolation(.none)
                    .frame(width: 12, height: 12).offset(x: CGFloat(cell.x - minX) * 12, y: CGFloat(cell.y - minY) * 12)
            }
        }.frame(width: CGFloat(width) * 12, height: 24)
    }
}

/// Touch-down fires once; held arrows repeat. Touch cancellation, sliding off, pause and removal stop repetition.
private struct TRIXPadControl: UIViewRepresentable {
    let icon: String
    let label: String
    let tint: UIColor
    let enabled: Bool
    let repeats: Bool
    let action: () -> Void
    func makeUIView(context: Context) -> TRIXPadButton { TRIXPadButton() }
    func updateUIView(_ view: TRIXPadButton, context: Context) {
        view.action = action; view.repeats = repeats
        view.isEnabled = enabled
        view.accessibilityLabel = label
        view.accessibilityHint = repeats ? "Tieni premuto per ripetere" : "Ruota il pezzo in senso orario"
        view.setImage(UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 26, weight: .bold)), for: .normal)
        view.tintColor = tint
        view.backgroundColor = tint.withAlphaComponent(enabled ? 0.16 : 0.05)
        view.layer.borderColor = tint.withAlphaComponent(enabled ? 0.6 : 0.15).cgColor
        if !enabled { view.stop() }
    }
    static func dismantleUIView(_ uiView: TRIXPadButton, coordinator: ()) { uiView.stop() }
}

private final class TRIXPadButton: UIButton {
    var action: (() -> Void)?
    var repeats = false
    private var repetition: Task<Void, Never>?
    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 8; layer.borderWidth = 2
        addTarget(self, action: #selector(press), for: .touchDown)
        addTarget(self, action: #selector(stop), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    }
    required init?(coder: NSCoder) { nil }
    @objc private func press() {
        guard isEnabled else { return }
        stop()
        action?()
        guard repeats else { return }
        repetition = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(280)) } catch { return }
            while !Task.isCancelled {
                guard let self, self.isEnabled else { return }
                self.action?()
                do { try await Task.sleep(for: .milliseconds(85)) } catch { return }
            }
        }
    }
    @objc func stop() { repetition?.cancel(); repetition = nil }
    override func accessibilityActivate() -> Bool {
        guard isEnabled else { return false }
        action?(); return true
    }
}

#if DEBUG
/// Synthetic offline simulator preview; never included in a distributed build.
struct ErnieTRIXDebugPreview: View {
    private let session: ErnieTRIXSession
    private let costume: BearCostume
    init() {
        costume = BearCostume(rawValue: ProcessInfo.processInfo.environment["ERNIE_DEBUG_TRIX_COSTUME"] ?? "base") ?? .base
        let defaults = UserDefaults(suiteName: "ernietrix-debug-preview")!
        var game = ErnieTRIXEngine(seed: 99)
        for row in 16..<20 {
            for col in 0..<10 where col < row - 14 || col >= 8 { game.board[row * 10 + col] = (row + col) % 7 + 1 }
        }
        game.active = TRIXPiece(kind: .t, x: 3, y: 4)
        defaults.set(try? JSONEncoder().encode(TRIXSave(game: game, record: 1200)), forKey: "ernie.ernietrix.v1.preview")
        session = ErnieTRIXSession(storageID: "preview", defaults: defaults)
        session.resume()
    }
    var body: some View { ErnieTRIXView(session: session, costume: costume) }
}
#endif
