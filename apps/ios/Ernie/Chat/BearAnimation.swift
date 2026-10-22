import SwiftUI

/// Ogni costume ha lo stesso repertorio: 20 espressioni e 5 gesti da 4 fotogrammi.
/// Il costume e il fotogramma sono indipendenti: parlare o starnutire non toglie il cappello.
enum BearCostume: String, CaseIterable, Identifiable, Sendable {
    case automatic, base, night, classic, aviator, chef, detective, engineer, explorer, astronaut
    var id: String { rawValue }
    static let preferenceKey = "ernie.bearCostume"
    static var costumes: [Self] { allCases.filter { $0 != .automatic } }
    var title: String {
        switch self {
        case .automatic: "Automatico"
        case .base: "Ernie classico"
        case .night: "Cappello da notte"
        case .classic: "Occhiali scuri"
        case .aviator: "Occhiali da aviatore"
        case .chef: "Cuoco"
        case .detective: "Detective"
        case .engineer: "Tecnico"
        case .explorer: "Esploratore"
        case .astronaut: "Astronauta"
        }
    }

    static func resolve(choice: String, hour: Int, tools: [String], emotion: String) -> Self {
        if let chosen = Self(rawValue: choice), chosen != .automatic { return chosen }
        for tool in tools.reversed() {
            if tool.hasPrefix("recipe") || tool.hasPrefix("shopping_") { return .chef }
            if tool.hasPrefix("ssh_") || tool.hasPrefix("server_") || tool.hasPrefix("wp_") { return .engineer }
            if tool.hasPrefix("place_") || tool.hasPrefix("weather") { return .explorer }
            if tool.contains("search") || tool == "web_fetch" { return .detective }
        }
        if hour >= 21 || hour < 7 { return .night }
        if emotion.lowercased() == "cool" { return hour < 15 ? .classic : .aviator }
        return .base
    }
}

struct BearContext: Equatable, Sendable {
    var tools: [String] = []
    var streamingID: String?
    var completedID: String?

    static func latest(in items: [ChatItem]) -> Self {
        for item in items.reversed() {
            guard case .message(let message) = item else { continue }
            if message.role == .user { return Self() }
            guard message.role == .assistant else { continue }
            let completed = !message.isStreaming && !message.cancelled && message.usage != nil
                && message.tools.allSatisfy { $0.ok == true }
            return Self(tools: message.tools.map(\.toolId),
                        streamingID: message.isStreaming ? message.id : nil,
                        completedID: completed ? message.id : nil)
        }
        return Self()
    }
}

private struct BearContextKey: EnvironmentKey {
    static let defaultValue = BearContext()
}
extension EnvironmentValues {
    var bearContext: BearContext {
        get { self[BearContextKey.self] }
        set { self[BearContextKey.self] = newValue }
    }
}

/// Selezione deterministica, separata dal rendering e dalle preferenze del dispositivo.
enum BearMotion {
    static let sleepAfter: TimeInterval = 120
    static let emotionNames = [
        "neutral", "happy", "love", "surprised", "worried", "fear", "sad", "disgust",
        "playful", "laughing", "cool", "proud", "angry", "determined", "embarrassed",
        "confused", "excited", "sleepy", "curious", "concentrated"
    ]
    enum Gesture: Int, CaseIterable {
        case thinking = 20, speaking = 24, sneeze = 28, sleep = 32, highFive = 36
        func frame(at elapsed: TimeInterval) -> Int {
            let step = max(0, Int(elapsed / (self == .speaking ? 0.16 : 0.3)))
            return rawValue + step % 4
        }
    }
    static func emotionFrame(_ emotion: String) -> Int? {
        switch emotion.lowercased() {
        case "neutral", "neutro", "": nil
        case "happy", "felice", "contento", "allegro", "joy": 1
        case "love", "affetto": 2
        case "surprised", "sorpreso", "stupito", "wow": 3
        case "worried", "preoccupato": 4
        case "fear", "scared", "paura": 5
        case "sad", "triste", "dispiaciuto": 6
        case "disgust", "disgusted": 7
        case "playful", "wink", "scherzoso", "complice": 8
        case "laughing", "laugh": 9
        case "cool": 10
        case "proud", "fiero": 11
        case "angry", "fierce", "feroce": 12
        case "determined": 13
        case "embarrassed": 14
        case "confused": 15
        case "excited": 16
        case "sleep", "sleepy": 17
        case "curious": 18
        case "concentrated", "focused": 19
        default: nil
        }
    }

    static func frame(state: AgentState, emotion: String, mouthOpen: Bool,
                      elapsed: TimeInterval, idleFor: TimeInterval,
                      celebrationFor: TimeInterval? = nil, reduceMotion: Bool = false) -> Int {
        if reduceMotion {
            switch state {
            case .thinking: return 22
            case .listening: return 18
            case .speaking: return 24
            case .idle: return emotionFrame(emotion) ?? (idleFor >= sleepAfter ? 34 : 0)
            }
        }
        let elapsed = max(0, elapsed)
        switch state {
        case .thinking: return Gesture.thinking.frame(at: elapsed * 0.55)
        case .listening: return [18, 18, 0, 18][Int(elapsed / 0.8) % 4]
        case .speaking:
            return mouthOpen ? [25, 26, 27, 26][Int(elapsed / 0.16) % 4] : 24
        case .idle:
            if let celebrationFor, celebrationFor >= 0, celebrationFor < 1.2 {
                return Gesture.highFive.frame(at: celebrationFor)
            }
            if let emotion = emotionFrame(emotion) {
                // Un battito breve mantiene l'espressione senza cambiare costume.
                return elapsed.truncatingRemainder(dividingBy: 5.4) > 5.15 ? 34 : emotion
            }
            if idleFor >= sleepAfter {
                let phase = (idleFor - sleepAfter).truncatingRemainder(dividingBy: 24)
                return phase < 1.2 ? Gesture.sleep.frame(at: phase) : (phase < 12 ? 34 : 35)
            }
            // Starnuto occasionale soltanto a riposo, mai durante ascolto o parlato.
            let idlePhase = max(0, idleFor).truncatingRemainder(dividingBy: 60)
            if idlePhase >= 48, idlePhase < 49.2 { return Gesture.sneeze.frame(at: idlePhase - 48) }
            let step = Int(elapsed / 0.4) % 20
            return step == 19 ? 34 : (step == 10 || step == 11 ? 18 : 0)
        }
    }
}

struct BearFrame: View {
    let costume: BearCostume
    let index: Int
    let size: CGFloat
    var body: some View {
        if let cell = BearAtlas.cell(costume: costume.rawValue, index: index) {
            BearPortraitArtwork(image: cell,
                                baseline: BearAtlas.portraitBaseline(costume: costume.rawValue, index: index, image: cell),
                                size: size)
        } else {
            if let fallback = BearAtlas.fallback {
                Image(uiImage: fallback).resizable().interpolation(.none).scaledToFit()
                    .frame(width: size, height: size)
            } else {
                Color.clear.frame(width: size, height: size)
            }
        }
    }
}

/// Picchiettio a dita alternate: appoggio fra i colpi, ritorno breve e pausa.
/// I fotogrammi sono registrati sul polso; non si trasla o ridimensiona la zampa.
enum BearPawTapMotion {
    static let cycle: TimeInterval = 1.65
    static let interval: TimeInterval = 1.0 / 30
    // La posa 0 è anche la pausa finale: il loop non cambia silhouette al riavvio.
    static let beats: [(until: TimeInterval, frame: Int)] = [
        (0.30, 0), (0.42, 1), (0.48, 0), (0.60, 2),
        (0.66, 0), (0.80, 3), (cycle, 0)
    ]

    static func frame(at elapsed: TimeInterval) -> Int {
        guard elapsed.isFinite, elapsed > 0 else { return 0 }
        let phase = elapsed.truncatingRemainder(dividingBy: cycle)
        return beats.first { phase < $0.until }?.frame ?? 0
    }
}

/// La zampa picchietta durante il lavoro; a operazione riuscita dà il cinque una volta.
/// Un errore resta una X esplicita: un gesto allegro non deve suggerire un successo inesistente.
struct BearActivityIcon: View {
    enum Status: Equatable { case working, success, failed }
    let status: Status
    var size: CGFloat = 24
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var succeededAt: Date?
    @State private var workingSince = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: BearPawTapMotion.interval, paused: reduceMotion || scenePhase != .active || status != .working && succeededAt == nil)) { timeline in
            let elapsed = succeededAt.map { max(0, timeline.date.timeIntervalSince($0)) }
            let frame = Self.frame(status: status, elapsed: elapsed,
                                   clock: timeline.date.timeIntervalSince(workingSince), reduceMotion: reduceMotion)
            BearActivityArtwork(status: status, frame: frame, size: size)
        }
        .onChange(of: status) { old, new in
            succeededAt = old == .working && new == .success ? .now : nil
            if new == .working { workingSince = .now }
        }
        .onChange(of: scenePhase) { _, new in
            if new == .active { workingSince = .now }
        }
        .task(id: succeededAt) {
            guard succeededAt != nil else { return }
            do { try await Task.sleep(for: .milliseconds(1_200)) } catch { return }
            succeededAt = nil
        }
        .accessibilityHidden(true)
    }

    nonisolated static func frame(status: Status, elapsed: TimeInterval?, clock: TimeInterval, reduceMotion: Bool) -> Int {
        switch status {
        case .failed: return 0
        case .working: return reduceMotion ? 0 : BearPawTapMotion.frame(at: clock)
        case .success:
            guard !reduceMotion, let elapsed, elapsed < 1.2 else { return 9 }
            return 4 + min(3, max(0, Int(elapsed / 0.3)))
        }
    }
}

struct BearActivityArtwork: View {
    let status: BearActivityIcon.Status
    let frame: Int
    let size: CGFloat

    var body: some View {
        Group {
            if status == .failed {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
            } else if let image = BearAtlas.cell(costume: status == .working ? "paws-tap" : "paws", index: frame) {
                Image(uiImage: image).resizable().interpolation(.none).scaledToFit()
            } else {
                Image(systemName: status == .success ? "checkmark" : "pawprint.fill")
                    .foregroundStyle(Theme.accentText)
            }
        }.frame(width: size, height: size)
    }
}

struct BearThinkingIndicator: View {
    var body: some View {
        HStack(spacing: 6) {
            BearActivityIcon(status: .working, size: 26)
            Text("Ci penso…").font(.footnote).foregroundStyle(Theme.inkSecondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ernie sta pensando")
    }
}
