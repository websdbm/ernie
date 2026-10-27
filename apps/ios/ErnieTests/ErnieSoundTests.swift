import AVFoundation
import Foundation
import Testing
@testable import Ernie

private struct SyntheticSoundError: Error {}

@MainActor private final class FakeSoundOutput: SoundEffectOutput {
    var played: [String] = []
    var volumes: [Float] = []
    var stops = 0
    func play(url: URL, volume: Float) -> Bool {
        played.append(url.lastPathComponent); volumes.append(volume); return true
    }
    func stop() { stops += 1 }
}

@MainActor struct ErnieSoundTests {
    @Test func audioBundledOriginaliBreviSenzaClipping() throws {
        for sound in ErnieSound.allCases {
            let url = try #require(sound.url())
            let file = try AVAudioFile(forReading: url)
            let format = file.processingFormat
            #expect(format.channelCount == 1)
            #expect(format.sampleRate == 44100)
            let duration = Double(file.length) / format.sampleRate
            #expect(duration >= 0.15 && duration < 0.5)
            let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(file.length)))
            try file.read(into: buffer)
            let data = try #require(buffer.floatChannelData?[0])
            var peak: Float = 0
            for i in 0..<Int(buffer.frameLength) {
                #expect(data[i].isFinite)
                peak = max(peak, abs(data[i]))
            }
            #expect(peak > 0.5 && peak < 0.8)
        }
    }

    @Test func gateNonRecuperaEventiVecchiEDeduplicaAncheSeSoppressi() {
        var gate = SoundFeedbackGate()
        let allowed1 = gate.accept(key: "voice", enabled: true, volume: 1, foreground: true, voiceBusy: true, now: 1)
        #expect(allowed1 == false)
        let allowed2 = gate.accept(key: "voice", enabled: true, volume: 1, foreground: true, voiceBusy: false, now: 2)
        #expect(allowed2 == false)
        let allowed3 = gate.accept(key: "background", enabled: true, volume: 1, foreground: false, voiceBusy: false, now: 3)
        #expect(allowed3 == false)
        let allowed4 = gate.accept(key: "background", enabled: true, volume: 1, foreground: true, voiceBusy: false, now: 4)
        #expect(allowed4 == false)
        let allowed5 = gate.accept(key: "new", enabled: true, volume: 1, foreground: true, voiceBusy: false, now: 5)
        #expect(allowed5 == true)
        let allowed6 = gate.accept(key: "new", enabled: true, volume: 1, foreground: true, voiceBusy: false, now: 6)
        #expect(allowed6 == false)
        let allowed7 = gate.accept(key: nil, enabled: true, volume: 1, foreground: true, voiceBusy: false, now: 5.05)
        #expect(allowed7 == false)
        let allowed8 = gate.accept(key: nil, enabled: false, volume: 1, foreground: true, voiceBusy: false, now: 7)
        #expect(allowed8 == false)
        let allowed9 = gate.accept(key: nil, enabled: true, volume: .nan, foreground: true, voiceBusy: false, now: 7)
        #expect(allowed9 == false)
        let allowed10 = gate.accept(key: nil, enabled: true, volume: 0, foreground: true, voiceBusy: false, now: 7)
        #expect(allowed10 == false)
    }

    @Test func microfonoVoceEBackgroundFermanoESopprimonoGliEffetti() throws {
        let domain = "ernie-sound-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: domain))
        defer { defaults.removePersistentDomain(forName: domain) }
        let output = FakeSoundOutput()
        var now: TimeInterval = 1
        let player = ErnieSoundPlayer(defaults: defaults, output: output, applicationActive: { true }, clock: { now })
        player.play(.send, key: "1")
        #expect(output.played.count == 1)
        #expect(output.volumes == [Float(ErnieSoundPlayer.defaultVolume)])
        player.beginVoice(.microphone)
        now += 1; player.play(.done, key: "2")
        #expect(output.played.count == 1 && output.stops == 1)
        player.beginVoice(.speech)
        now += 1; player.play(.check, key: "3")
        #expect(output.played.count == 1)
        player.endVoice(.speech)
        now += 1; player.play(.done, key: "4")
        #expect(output.played.count == 2) // Il parlato prende il posto della cattura e poi libera la sessione.
        player.setForeground(false)
        now += 1; player.play(.error, key: "5")
        #expect(output.played.count == 2)
        player.setForeground(true)
        now += 1; player.play(.error, key: "5")
        #expect(output.played.count == 2)
        defaults.set(false, forKey: ErnieSoundPlayer.enabledKey)
        now += 1; player.play(.ask)
        #expect(output.played.count == 2)
        defaults.set(true, forKey: ErnieSoundPlayer.enabledKey)
        defaults.set(0.25, forKey: ErnieSoundPlayer.volumeKey)
        now += 1; player.play(.ask)
        #expect(output.volumes.last == 0.25)
    }

    @Test func chatNotificaUnaSolaFineTurnoENonSuonaLeRisposteStoriche() throws {
        let domain = "ernie-chat-sound-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: domain))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(domain)
        defer { defaults.removePersistentDomain(forName: domain); try? FileManager.default.removeItem(at: directory) }
        var settings = LocalSettings(); settings.voiceOutput = false
        let store = ConversationStore(credentials: .init(serverURL: URL(string: "https://example.invalid")!, apiKey: "test"),
            speaker: Speaker(), inbox: InboxStore(), settings: settings,
            transcript: TranscriptStore(directory: directory, defaults: defaults), deviceContext: { nil })
        defer { store.disconnect() }
        var feedback: [ErnieSound] = []
        store.onFeedback = { sound, _ in feedback.append(sound) }
        store.send("Prova sintetica", inputMode: "text")
        let id = try #require(store.activeCorrelationId)
        #expect(feedback == [.send])
        store.apply(.init(payload: .assistantCompleted(.init()), sessionId: store.sessionId, correlationId: "old", seq: 1))
        #expect(feedback == [.send])
        let completed = AgentEvent(payload: .assistantCompleted(.init()), sessionId: store.sessionId, correlationId: id, seq: 2)
        store.apply(completed); store.apply(completed)
        #expect(feedback == [.send, .done])
    }

    @Test func todoSuonaSoloDopoSalvataggioConfermatoEIndicaErroreSenzaPremio() async {
        let store = TodoStore()
        var sounds: [ErnieSound] = []
        let item = TodoItem(title: "Prova")
        let list = TodoList(name: "Prova", items: [item])
        store.configure(transport: .init(lists: { [] }, list: { _ in list }, create: { $0 }, update: { draft in
            #expect(sounds.isEmpty) // Nessuna conferma prima della risposta del server.
            return draft
        }))
        store.onFeedback = { sounds.append($0) }
        store.apply(list)
        await store.mutate(list.id) { $0.items[0].status = .done }
        #expect(sounds == [.check])
        sounds = []
        store.configure(transport: .init(lists: { [] }, list: { _ in list }, create: { _ in throw SyntheticSoundError() }, update: { _ in throw SyntheticSoundError() }))
        store.apply(list)
        await store.mutate(list.id) { $0.items[0].status = .done }
        #expect(sounds == [.error])
        #expect(store.lists[list.id]?.items[0].status == .pending)
    }
}
