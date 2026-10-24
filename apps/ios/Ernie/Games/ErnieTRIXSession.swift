import Foundation
import Observation
import CryptoKit

struct TRIXSave: Codable {
    var version = 1
    var game: ErnieTRIXEngine
    var record: Int

    static func decode(_ data: Data?) -> Self? {
        guard let data, data.count < 32_768,
              let save = try? JSONDecoder().decode(Self.self, from: data),
              save.version == 1, save.game.isValidSave,
              (0...1_000_000_000).contains(save.record) else { return nil }
        return save
    }
}

@MainActor @Observable
final class ErnieTRIXSession {
    @ObservationIgnored private var engine: ErnieTRIXEngine
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String
    private(set) var revision = 0
    private(set) var record: Int
    private(set) var celebration = 0

    var game: ErnieTRIXEngine { _ = revision; return engine }

    /// Stable offline too; raw account credentials never enter the save or its key.
    static func storageID(for credentials: Credentials) -> String {
        SHA256.hash(data: Data("\(credentials.serverURL.absoluteString)\n\(credentials.apiKey)".utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    init(storageID: String, defaults: UserDefaults = .standard, seed: UInt64? = nil) {
        self.defaults = defaults
        key = "ernie.ernietrix.v1.\(storageID)"
        let save = TRIXSave.decode(defaults.data(forKey: key))
        engine = save?.game ?? ErnieTRIXEngine(seed: seed ?? UInt64.random(in: 1...UInt64.max))
        engine.pause()
        record = max(save?.record ?? 0, engine.score)
    }

    func resume() { engine.resume(); revision += 1 }
    func pause() { engine.pause(); revision += 1; save() }
    func restart() {
        record = max(record, engine.score)
        engine = ErnieTRIXEngine()
        engine.resume()
        revision += 1
        save()
    }
    func perform(_ command: ErnieTRIXEngine.Command) {
        let previous = engine
        engine.perform(command)
        publish(previous)
    }
    func tick(_ delta: TimeInterval) {
        let previous = engine
        engine.advance(delta)
        publish(previous)
    }
    private func publish(_ previous: ErnieTRIXEngine) {
        // Internal timers do not invalidate SwiftUI sixty times a second.
        guard previous.active != engine.active || previous.piecesPlaced != engine.piecesPlaced
                || previous.status != engine.status || previous.score != engine.score else { return }
        record = max(record, engine.score)
        revision += 1
        if previous.lines != engine.lines { celebration += 1 }
        if previous.piecesPlaced != engine.piecesPlaced || engine.status == .gameOver { save() }
    }
    func save() {
        var checkpoint = engine
        checkpoint.pause()
        guard let data = try? JSONEncoder().encode(TRIXSave(game: checkpoint, record: record)) else { return }
        defaults.set(data, forKey: key)
    }
}
