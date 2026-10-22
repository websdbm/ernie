import AVFoundation
import Foundation
import Testing
@testable import Ernie

struct SpeechTests {
    @Test func spezzaLeFrasiCompleteELasciaIlResto() {
        var buffer = "Ecco tre ricette per la settimana. La prima è la zuppa di legumi! Poi"
        let sentences = SentenceSplitter.popSentences(from: &buffer)
        #expect(sentences == ["Ecco tre ricette per la settimana.", "La prima è la zuppa di legumi!"])
        #expect(buffer == " Poi")
    }

    @Test func nonSpezzaSuNumeriPuntati() {
        var buffer = "1. Zuppa di legumi, circa trenta minuti. 2."
        let sentences = SentenceSplitter.popSentences(from: &buffer)
        #expect(sentences == ["1. Zuppa di legumi, circa trenta minuti."])
        #expect(buffer == " 2.")
    }

    @Test func rimuoveIlMarkdownPrimaDiParlare() {
        #expect(SentenceSplitter.plainForSpeech("**Pollo** al [limone](https://x.it) con `aglio`") == "Pollo al limone con aglio")
        #expect(SentenceSplitter.plainForSpeech("- latte") == "latte")
        #expect(SentenceSplitter.plainForSpeech("🛒 In lista ci sono 3 voci 👍") == "In lista ci sono 3 voci")
        #expect(SentenceSplitter.plainForSpeech("In lista:\n- latte\n- 2 uova\n1. pane") == "In lista:\nlatte\n2 uova\npane")
    }

    @Test func blocchiMarkdown() {
        let blocks = Markdown.blocks("In lista ci sono 3 voci:\n- latte\n- pane\n\n## Ricette\n1. Zuppa\n2. Pollo\n> nota")
        #expect(blocks == [
            .paragraph("In lista ci sono 3 voci:"),
            .bullets(["latte", "pane"]),
            .heading("Ricette"),
            .numbered(start: 1, ["Zuppa", "Pollo"]),
            .quote("nota"),
        ])
    }

    @Test func livelloMicrofonoInScalaPercettiva() {
        #expect(AudioLevel.normalized(rms: 0) == 0)
        #expect(AudioLevel.normalized(rms: 1) == 1)
        // −20 dBFS (parlato vicino) → 0,6; −50 dBFS (silenzio) → 0.
        #expect(abs(AudioLevel.normalized(rms: 0.1) - 0.6) < 0.001)
        #expect(AudioLevel.normalized(rms: 0.001) < 0.11)
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4)!
        buffer.frameLength = 4
        for i in 0..<4 { buffer.floatChannelData![0][i] = 0.5 }
        #expect(abs(AudioLevel.rms(of: buffer) - 0.5) < 0.0001)
    }

    @Test func elencoNumeratoInterrottoNonRiparteDaUno() {
        let blocks = Markdown.blocks("1. Apple\nhttps://a.it\n2. Reddit\nhttps://b.it\n3. Blog")
        #expect(blocks == [
            .numbered(start: 1, ["Apple"]),
            .paragraph("https://a.it"),
            .numbered(start: 2, ["Reddit"]),
            .paragraph("https://b.it"),
            .numbered(start: 3, ["Blog"]),
        ])
    }

    @Test func latenzaPerStadio() {
        var t = LatencyTrace(startedAt: Date(timeIntervalSince1970: 0))
        t.mark(.pttReleased, at: Date(timeIntervalSince1970: 10))
        t.mark(.transcriptFinal, at: Date(timeIntervalSince1970: 10.4))
        t.mark(.messageSent, at: Date(timeIntervalSince1970: 10.45))
        t.mark(.firstToken, at: Date(timeIntervalSince1970: 11.2))
        t.mark(.firstSpeech, at: Date(timeIntervalSince1970: 11.6))
        t.mark(.firstSpeech, at: Date(timeIntervalSince1970: 20))   // il primo vince
        #expect(abs((t.audibleLatency ?? 0) - 1.6) < 0.001)
        #expect(abs((t.sttFinalization ?? 0) - 0.4) < 0.001)
        #expect(LatencyTrace.percentile([3, 1, 2], 0.5) == 2)
        #expect(LatencyTrace.percentile([], 0.5) == nil)
    }

    @Test func schedaNotificaRiassumeLeAzioniSospese() throws {
        let json = """
        {"id":"n1","kind":"automation.approval","title":"Ricette","body":"Tre ricette","createdAt":"2026-10-11T09:21:20.000Z","payload":{"runId":"r","pendingActions":[{"approvalId":"a1","toolId":"shopping_list_add","args":{"items":[{"name":"limoni","quantity":"3"},{"name":"aglio"}]},"reason":"run contaminata","expiresAt":"x"}]}}
        """
        let item = try JSONDecoder().decode(NotificationItem.self, from: Data(json.utf8))
        let card = NotificationCard(item)
        #expect(card.needsApproval)
        #expect(card.pendingActions.first?.summary == "Aggiungi alla lista: limoni (3), aglio")
    }
}

@MainActor
private final class FakeSpeechOutput: SpeechOutput {
    var localVoiceDescription = "Voce prova"
    var remote: [Data] = []
    var local: [String] = []
    var finishes: [(Bool) -> Void] = []
    var stopCount = 0
    var failBeforePlaying = false
    var failAfterPlaying = false
    func play(_ data: Data, started: @escaping () -> Void, mouth: @escaping (Bool) -> Void,
              finished: @escaping (Bool) -> Void) throws {
        if failBeforePlaying { throw URLError(.cannotDecodeContentData) }
        remote.append(data)
        finishes.append(finished)
        started()
        mouth(true)
        if failAfterPlaying { throw URLError(.cannotDecodeContentData) }
    }
    func speak(_ text: String, started: @escaping () -> Void, progress: @escaping (Int) -> Void,
               finished: @escaping (Bool) -> Void) {
        local.append(text)
        finishes.append(finished)
        started()
    }
    func stop() { stopCount += 1 }
}

@MainActor
private final class ControlledSpeechTransport {
    var texts: [String] = []
    var pending: [CheckedContinuation<Data, any Error>] = []
    var completed = 0
    var active = 0
    var maximumActive = 0
    var cancelledResponses = 0
    func audio(_ text: String, _ style: SpeechStyle, _ credentials: Credentials) async throws -> Data {
        texts.append(text)
        active += 1; maximumActive = max(maximumActive, active)
        defer {
            active -= 1; completed += 1
            if Task.isCancelled { cancelledResponses += 1 }
        }
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
}

@MainActor
struct DramaSpeechTests {
    private var credentials: Credentials { Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "test") }
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition(), "La coda asincrona non ha completato il passaggio atteso")
    }

    @Test func annullareDuranteLaGenerazioneNonFaParlareLaRispostaTardiva() async throws {
        let output = FakeSpeechOutput()
        let transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.beginTurn()
        speaker.feed("Questa è la prima frase.")
        #expect(speaker.isSpeaking) // comprende l'attesa HTTP: niente riapertura del microfono
        await waitFor { transport.pending.count == 1 }
        #expect(speaker.stop() == 0)
        transport.pending[0].resume(returning: Data([1]))
        for _ in 0..<20 { await Task.yield() }
        #expect(output.remote.isEmpty)
        #expect(output.local.isEmpty)
        #expect(!speaker.isSpeaking)
    }

    @Test func frasiInOrdineERipiegoSoloPerLaFraseFallita() async throws {
        let output = FakeSpeechOutput()
        let transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.beginTurn()
        speaker.feed("Questa è la prima frase. Questa è la seconda frase.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { output.finishes.count == 1 }
        await waitFor { transport.pending.count == 2 }
        transport.pending[1].resume(throwing: URLError(.timedOut))
        await waitFor { transport.completed == 2 }
        #expect(output.local.isEmpty) // Il ripiego preparato aspetta la fine della prima frase.
        output.finishes[0](true)
        await waitFor { output.local.count == 1 }
        #expect(output.remote == [Data([1])])
        #expect(output.local == ["Questa è la seconda frase."])
        #expect(speaker.isSpeaking)
        output.finishes[1](true)
        #expect(!speaker.isSpeaking)
        #expect(speaker.stop() == "Questa è la prima frase. Questa è la seconda frase.".count)
    }

    @Test func audioNonDecodificabileUsaIlRipiegoPrimaDiParlare() async {
        let output = FakeSpeechOutput()
        output.failBeforePlaying = true
        let speaker = Speaker(output: output, transport: { _, _, _ in Data([0]) })
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.flush(fullText: "Audio non valido.")
        await waitFor { output.local.count == 1 }
        #expect(output.remote.isEmpty)
        #expect(output.local == ["Audio non valido."])
        output.finishes[0](true)
        #expect(!speaker.isSpeaking)
    }

    @Test func vecchiCallbackNonChiudonoIlNuovoTurno() async {
        let output = FakeSpeechOutput()
        let speaker = Speaker(output: output)
        speaker.configure(credentials: credentials, engine: .ios, style: .warm)
        speaker.beginTurn()
        speaker.flush(fullText: "Primo turno.")
        let stale = output.finishes[0]
        speaker.beginTurn()
        speaker.flush(fullText: "Nuovo turno.")
        stale(true)
        #expect(speaker.isSpeaking)
        #expect(speaker.stop() == 0)
    }

    @Test func erroreDopoInizioNonRipeteLaFraseENonSegnaTestoNonPronunciato() async {
        let output = FakeSpeechOutput()
        let speaker = Speaker(output: output, transport: { _, _, _ in Data([1]) })
        speaker.configure(credentials: credentials, engine: .drama, style: .playful)
        speaker.beginTurn()
        speaker.flush(fullText: "Una frase incompleta. Un’altra frase in coda.")
        await waitFor { output.finishes.count == 1 }
        output.finishes[0](false)
        #expect(output.local.isEmpty)
        #expect(output.remote.count == 1)
        #expect(speaker.stop() == 0)
        #expect(!speaker.isSpeaking)
    }

    @Test func cambioCredenzialiInvalidaLaRichiestaInCorso() async {
        let output = FakeSpeechOutput()
        let transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.flush(fullText: "Risposta del vecchio account.")
        await waitFor { transport.pending.count == 1 }
        speaker.configure(credentials: nil, engine: .drama, style: .warm)
        transport.pending[0].resume(throwing: URLError(.timedOut))
        for _ in 0..<20 { await Task.yield() }
        #expect(output.local.isEmpty)
        #expect(!speaker.isSpeaking)
    }

    @Test func preparaUnaSolaFraseAvantiERiproduceSubitoQuellaPronta() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.beginTurn()
        var speaking: [Bool] = []
        speaker.onSpeakingChanged = { speaking.append($0) }
        let sentences = ["Prima frase completa.", "Seconda frase completa.", "Terza frase completa."]
        speaker.feed(sentences.joined(separator: " "))
        await waitFor { transport.pending.count == 1 }
        #expect(transport.maximumActive == 1 && output.remote.isEmpty)
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { transport.pending.count == 2 }
        #expect(output.remote == [Data([1])]) // La seconda si scarica mentre la prima parla.
        #expect(speaker.isSpeaking && !speaker.isPreparingAudio && speaker.mouthOpen)
        transport.pending[1].resume(returning: Data([2]))
        await waitFor { transport.completed == 2 }
        for _ in 0..<20 { await Task.yield() }
        #expect(transport.texts.count == 2) // Nessun download della terza finché non parte la seconda.
        #expect(output.remote.count == 1)
        output.finishes[0](true)
        #expect(output.remote == [Data([1]), Data([2])]) // Nessuna nuova attesa HTTP.
        #expect(speaking == [true]) // Il microfono non si riapre tra le frasi.
        await waitFor { transport.pending.count == 3 }
        transport.pending[2].resume(returning: Data([3]))
        await waitFor { transport.completed == 3 }
        output.finishes[1](true)
        #expect(output.remote == [Data([1]), Data([2]), Data([3])])
        output.finishes[2](true)
        #expect(speaking == [true, false])
        #expect(speaker.stop() == sentences.joined(separator: " ").count)
        #expect(transport.maximumActive == 1)
        #expect(transport.texts == sentences) // Stesso numero e contenuto di sintesi, nessuna duplicazione.
        #expect(output.local.isEmpty)
    }

    @Test func preloadAncoraInCorsoDiventaAttivoSenzaDuplicareRichieste() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { transport.pending.count == 2 }
        output.finishes[0](true)
        #expect(speaker.isSpeaking && speaker.isPreparingAudio && !speaker.mouthOpen)
        #expect(transport.texts.count == 2 && output.remote.count == 1)
        transport.pending[1].resume(returning: Data([2]))
        await waitFor { output.remote.count == 2 }
        #expect(!speaker.isPreparingAudio)
        #expect(speaker.stop() == "Prima frase completa.".count) // La seconda è iniziata, non finita.
    }

    @Test func testoArrivatoDurantePlaybackAvviaPreloadSenzaAspettareLaFine() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { output.remote.count == 1 }
        speaker.feed(" Seconda frase completa.")
        await waitFor { transport.pending.count == 2 }
        #expect(output.remote.count == 1)
        _ = speaker.stop()
        transport.pending[1].resume(returning: Data([2]))
        await waitFor { transport.completed == 2 }
        #expect(output.remote.count == 1 && output.local.isEmpty)
        #expect(transport.cancelledResponses == 1)
        #expect(!speaker.isSpeaking && !speaker.isPreparingAudio && !speaker.mouthOpen)
    }

    @Test func stopScartaAudioGiaProntoERispostaPreloadDiUnVecchioTurno() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { transport.pending.count == 2 }
        transport.pending[1].resume(returning: Data([2]))
        await waitFor { transport.completed == 2 }
        let staleFinish = output.finishes[0]
        #expect(speaker.stop() == 0)
        speaker.beginTurn()
        speaker.feed("Frase del nuovo turno.")
        await waitFor { transport.pending.count == 3 }
        staleFinish(true)
        transport.pending[2].resume(returning: Data([3]))
        await waitFor { output.remote.count == 2 }
        #expect(output.remote == [Data([1]), Data([3])])
        #expect(speaker.isSpeaking)
        output.finishes[1](true)
        #expect(speaker.stop() == "Frase del nuovo turno.".count)
    }

    @Test(arguments: ["credentials", "style", "engine"])
    func cambioConfigurazioneCancellaPreloadELasciaMutiCallbackTardivi(_ change: String) async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa. Terza frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { transport.pending.count == 2 }
        speaker.configure(credentials: change == "credentials" ? nil : credentials,
                          engine: change == "engine" ? .ios : .drama, style: change == "style" ? .calm : .warm)
        transport.pending[1].resume(throwing: URLError(.timedOut))
        await waitFor { transport.completed == 2 }
        output.finishes[0](true)
        #expect(transport.cancelledResponses == 1)
        #expect(transport.texts.count == 2)
        #expect(output.remote == [Data([1])] && output.local.isEmpty)
        #expect(!speaker.isSpeaking && !speaker.isPreparingAudio)
    }

    @Test func preloadTardivoNonCancellaLaRichiestaDelNuovoTurno() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { transport.pending.count == 2 }
        speaker.beginTurn()
        speaker.feed("Frase del nuovo turno.")
        await waitFor { transport.pending.count == 3 }
        transport.pending[1].resume(returning: Data([2]))
        await waitFor { transport.completed == 2 }
        #expect(speaker.isSpeaking && speaker.isPreparingAudio)
        #expect(output.remote == [Data([1])])
        transport.pending[2].resume(returning: Data([3]))
        await waitFor { output.remote.count == 2 }
        #expect(output.remote == [Data([1]), Data([3])])
        output.finishes[1](true)
        #expect(!speaker.isSpeaking)
    }

    @Test func erroreDellaFraseAttivaAnnullaIlPreloadSenzaRipetereAudio() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { transport.pending.count == 2 }
        output.finishes[0](false)
        transport.pending[1].resume(returning: Data([2]))
        await waitFor { transport.completed == 2 }
        #expect(output.remote.count == 1 && output.local.isEmpty)
        #expect(!speaker.isSpeaking)
        #expect(speaker.stop() == 0)
    }

    @Test func errorePlayDopoStartedNonAvviaRipiegoOPreloadSupplementare() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        output.failAfterPlaying = true
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { !speaker.isSpeaking }
        // Il Task creato da started viene annullato prima di eseguire il trasporto.
        for _ in 0..<20 { await Task.yield() }
        #expect(transport.texts.count == 1)
        #expect(output.remote.count == 1 && output.local.isEmpty)
        #expect(speaker.stop() == 0)
    }

    @Test func audioPrecaricatoNonDecodificabileRipiegaSoloQuandoToccaAllaFrase() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .drama, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa.")
        await waitFor { transport.pending.count == 1 }
        transport.pending[0].resume(returning: Data([1]))
        await waitFor { transport.pending.count == 2 }
        transport.pending[1].resume(returning: Data([0]))
        await waitFor { transport.completed == 2 }
        #expect(output.local.isEmpty)
        output.failBeforePlaying = true
        output.finishes[0](true)
        #expect(output.local == ["Seconda frase completa."])
        #expect(output.remote == [Data([1])])
        #expect(speaker.isSpeaking && !speaker.isPreparingAudio)
        output.finishes[1](true)
        #expect(!speaker.isSpeaking)
        #expect(speaker.stop() == "Prima frase completa. Seconda frase completa.".count)
    }

    @Test func motoreIOSNonAvviaMaiSintesiRemoteEConservaOrdine() async {
        let output = FakeSpeechOutput(), transport = ControlledSpeechTransport()
        let speaker = Speaker(output: output, transport: transport.audio)
        speaker.configure(credentials: credentials, engine: .ios, style: .warm)
        speaker.feed("Prima frase completa. Seconda frase completa.")
        #expect(output.local == ["Prima frase completa."])
        output.finishes[0](true)
        #expect(output.local == ["Prima frase completa.", "Seconda frase completa."])
        output.finishes[1](true)
        for _ in 0..<20 { await Task.yield() }
        #expect(transport.texts.isEmpty)
        #expect(!speaker.isSpeaking)
    }

    @Test func frasiLungheSonoLimitateESenzaPerditaDiOffset() {
        let original = String(repeating: "Parola lunga 🙂 ", count: 500)
        var buffer = original
        var chunks = SentenceSplitter.popSpeechChunks(from: &buffer)
        chunks += SentenceSplitter.popSpeechChunks(from: &buffer, flush: true)
        #expect(chunks.joined() == original)
        #expect(chunks.allSatisfy { $0.utf16.count <= 1800 })
        #expect(buffer.isEmpty)
        var noSpace = String(repeating: "a", count: 4500)
        let long = SentenceSplitter.popSpeechChunks(from: &noSpace, flush: true)
        #expect(long.map(\.count) == [1800, 1800, 900])
    }

    @Test func preferenzeVoceMigranoERestanoSalvate() throws {
        let old = try JSONDecoder().decode(LocalSettings.self, from: Data("{\"voiceOutput\":false}".utf8))
        #expect(old.speechEngine == .drama)
        #expect(old.speechStyle == .warm)
        #expect(!old.voiceOutput)
        var settings = old
        settings.speechEngine = .ios
        settings.speechStyle = .calm
        let restored = try JSONDecoder().decode(LocalSettings.self, from: JSONEncoder().encode(settings))
        #expect(restored == settings)
    }
}

/// Verifica il player reale e la sessione condivisa: i mock di SpeechOutput non rilevano l'attenuazione voiceChat.
@MainActor
@Suite(.serialized)
struct SpeechPlaybackSessionTests {
    @Test func avvioRealeMicrofonoRiceveBufferEFermaSenzaCrash() async throws {
        guard await AVAudioApplication.requestRecordPermission() else {
            Issue.record("Per la prova audio reale serve il permesso microfono del simulatore")
            return
        }
        try AudioSessionController.activateForVoice()
        let capture = MicrophoneCapture()
        defer { capture.stop(); AudioSessionController.deactivate() }
        let stream = try await capture.start()
        let received = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await chunk in stream { return chunk.buffer.frameLength > 0 }
                return false
            }
            group.addTask { try? await Task.sleep(for: .seconds(5)); return false }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
        #expect(received, "Il motore deve consegnare almeno un buffer dal vero callback audio")
        capture.stop()
        #expect(capture.format == nil && !capture.voiceProcessing)
    }
    @Test func avvioMicrofonoAnnullatoNonRiattivaLaModalitaChiamata() async throws {
        try AudioSessionController.activateForSpeechPlayback()
        let engine = AVAudioEngine()
        let capture = MicrophoneCapture(engine: engine)
        defer { capture.stop(); AudioSessionController.deactivate() }
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await capture.start()
        }
        do { _ = try await task.value; Issue.record("L'avvio annullato deve fermarsi") }
        catch { #expect(error is CancellationError) }
        #expect(AVAudioSession.sharedInstance().category == .playback)
        #expect(!engine.inputNode.isVoiceProcessingEnabled)
    }

    @Test func chiudereIlMicrofonoDisattivaAncheLElaborazioneCheAttenuaIlPlayer() throws {
        try AudioSessionController.activateForVoice()
        let engine = AVAudioEngine()
        let capture = MicrophoneCapture(engine: engine)
        defer { capture.stop(); AudioSessionController.deactivate() }
        // Nessuna registrazione: inizializza soltanto il processore vocale di sistema.
        try engine.inputNode.setVoiceProcessingEnabled(true)
        #expect(engine.inputNode.isVoiceProcessingEnabled)
        capture.stop()
        #expect(!engine.inputNode.isVoiceProcessingEnabled)
        try AudioSessionController.activateForSpeechPlayback()
        #expect(AVAudioSession.sharedInstance().category == .playback)
        // Il capture resta vivo: non bisogna aspettarne la deallocazione per liberare il playback.
        #expect(!engine.inputNode.isVoiceProcessingEnabled)
    }

    @Test func audioRemotoEsceDallaModalitaChiamataAncheDopoIlMicrofono() async throws {
        let session = AVAudioSession.sharedInstance()
        let speaker = Speaker(transport: { _, _, _ in Self.silentWav() })
        speaker.configure(
            credentials: Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test"),
            engine: .drama, style: .warm
        )
        defer { _ = speaker.stop(); AudioSessionController.deactivate() }
        var starts = 0
        speaker.onAudibleStarted = { starts += 1 }
        // Primo ascolto e successivo ritorno al microfono: entrambi devono lasciare spazio al playback normale.
        for turn in 1...2 {
            try AudioSessionController.activateForVoice()
            #expect(session.category == .playAndRecord)
            #expect(session.mode == .voiceChat)
            speaker.beginTurn()
            speaker.flush(fullText: "Prova audio.")
            let deadline = ContinuousClock.now + .seconds(3)
            while starts < turn, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(starts == turn)
            #expect(session.category == .playback)
            #expect(session.mode != .voiceChat)
            #expect(session.categoryOptions.contains(.duckOthers))
            _ = speaker.stop()
            #expect(!speaker.isSpeaking)
        }
    }

    private static func silentWav() -> Data {
        // PCM mono 16 bit, 0,5 secondi: il player decodifica audio reale senza emettere suoni durante il test.
        let sampleRate: UInt32 = 16_000
        let byteCount: UInt32 = sampleRate
        var data = Data()
        func word<T: FixedWidthInteger>(_ value: T) {
            var le = value.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        data.append(contentsOf: "RIFF".utf8); word(36 + byteCount)
        data.append(contentsOf: "WAVEfmt ".utf8); word(UInt32(16))
        word(UInt16(1)); word(UInt16(1)); word(sampleRate); word(sampleRate * 2)
        word(UInt16(2)); word(UInt16(16))
        data.append(contentsOf: "data".utf8); word(byteCount)
        data.append(Data(repeating: 0, count: Int(byteCount)))
        return data
    }
}


@MainActor struct ConversationSpeechLifecycleTests {
    @Test func stopMantieneMutoIlTurnoEDisconnessioneBloccaInviiTardivi() throws {
        let output = FakeSpeechOutput()
        let speaker = Speaker(output: output)
        let creds = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "test")
        speaker.configure(credentials: creds, engine: .ios, style: .warm)
        var settings = LocalSettings()
        settings.speakTextReplies = true
        let name = "ernie-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let store = ConversationStore(credentials: creds, speaker: speaker, inbox: InboxStore(), settings: settings,
                                      transcript: TranscriptStore(directory: directory, defaults: defaults))
        store.send("Una domanda", inputMode: "text")
        let corr = try #require(store.activeCorrelationId)
        store.apply(AgentEvent(payload: .assistantTextDelta(.init(delta: "Prima frase pronunciata.")), sessionId: store.sessionId, correlationId: corr, seq: 1))
        #expect(output.local.count == 1)
        store.muteSpeech()
        store.apply(AgentEvent(payload: .assistantTextDelta(.init(delta: " Seconda frase solo scritta.")), sessionId: store.sessionId, correlationId: corr, seq: 2))
        #expect(output.local.count == 1)
        #expect(!speaker.isSpeaking)
        store.disconnect()
        let count = store.items.count
        store.send("Trascrizione tardiva", inputMode: "voice")
        #expect(store.items.count == count)
        #expect(!store.isAttached)
    }
}
