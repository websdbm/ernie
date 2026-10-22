import AVFoundation
import Foundation
import Observation

/// Voce a un tocco (decisione dell'utente, 11 ott 2026): tocca il microfono → ascolto (con barge-in se Ernie parla);
/// tocca ↑ → trascrizione finale → invio come voce; ✕ annulla. Ogni fase è visibile nella barra (`statusText`),
/// insieme al livello del microfono, così si capisce sempre cosa sta succedendo.
///
/// Conversazione continua (M8, solo in primo piano): dopo il primo tocco la frase si invia da sola quando l'utente
/// fa una pausa (`TurnDetector`), Ernie risponde a voce e poi il microfono si riapre; ✕ chiude. Mentre Ernie parla il
/// microfono è spento (mute logico): la voce sintetica non può mai diventare input. Toccando il microfono mentre
/// risponde si interrompe (barge-in) e si torna subito all'ascolto.
@MainActor
@Observable
final class VoiceController {
    enum Phase: Equatable {
        case idle
        /// Permesso, modello, sessione audio e motore in avvio.
        case preparing
        /// Prima volta: il sistema scarica il modello italiano (avanzamento 0…1).
        case downloadingModel(Double)
        case listening
        case finalizing
        /// Conversazione continua: Ernie sta rispondendo, microfono spento; si riapre da solo alla fine.
        case waitingReply
    }

    /// Evento audio di sistema mostrato in Diagnostica (interruzioni, cambi di route, reset dei servizi).
    struct AudioEvent: Equatable {
        var description: String
        var at: Date
    }

    private(set) var phase: Phase = .idle
    /// Conversazione continua in corso (a mani libere).
    private(set) var continuous = false
    private(set) var liveTranscript = ""
    /// Livello del microfono (0…1) aggiornato ~25 volte al secondo mentre ascolta.
    private(set) var inputLevel: Float = 0
    private(set) var engineName = "—"
    private(set) var lastError: String?
    private(set) var voiceProcessingActive = false
    private(set) var modelState: SpeechModel.State = .notInstalled
    private(set) var lastAudioEvent: AudioEvent?
    /// Turni chiusi automaticamente dal rilevatore di pausa (conversazione continua).
    private(set) var autoEndedTurns = 0

    var isListening: Bool { phase == .listening }
    var isActive: Bool { phase != .idle }
    var isWaitingReply: Bool { phase == .waitingReply }

    /// Cosa sta succedendo, sempre: lo legge la barra di input.
    var statusText: String {
        switch phase {
        case .idle: ""
        case .preparing: "Preparo il microfono…"
        case .downloadingModel(let p): "Scarico il modello vocale italiano (solo la prima volta)… \(Int(p * 100))%"
        case .listening:
            if !liveTranscript.isEmpty { liveTranscript } else if continuous { "Ti ascolto. Parla: invio da solo quando fai una pausa." } else { "Ti ascolto. Parla, poi tocca ↑ per inviare." }
        case .finalizing: liveTranscript.isEmpty ? "Trascrivo…" : liveTranscript
        case .waitingReply:
            if speaker.isPreparingAudio { "Preparo la voce di Ernie… Tocca il microfono per interrompere." }
            else if speaker.isSpeaking { "Ernie parla. Tocca il microfono per interromperlo, ✕ per chiudere." }
            else { "Ernie risponde… il microfono si riapre alla fine." }
        }
    }

    private let conversation: ConversationStore
    private let speaker: Speaker
    private var capture: MicrophoneCapture?
    private var engine: (any SpeechInput)?
    private var reader: Task<Void, Never>?
    private var captureGeneration = UUID()
    private var starter: Task<Void, Never>?
    private var ticker: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var resumeAfterInterruption = false
    private var lastFinalText: String?
    private var heardSpeech = false
    private var detector: TurnDetector?
    /// Turni vuoti consecutivi in conversazione continua: al secondo si chiude, invece di insistere.
    private var emptyTurns = 0

    init(conversation: ConversationStore, speaker: Speaker) {
        self.conversation = conversation
        self.speaker = speaker
        conversation.onSettled = { [weak self] in self?.turnSettled() }
        observeAudioSession()
    }

    /// Scarica il modello italiano in anticipo (all'avvio), così il primo tocco non aspetta.
    func prewarm() async {
        modelState = await SpeechModel.shared.refresh()
        if case .notInstalled = modelState {
            try? await SpeechModel.shared.ensureInstalled()
            modelState = await SpeechModel.shared.refresh()
        }
    }

    /// Il pulsante: avvia l'ascolto, oppure lo chiude e invia.
    func toggle() {
        switch phase {
        case .idle: startListening()
        case .listening: finishListening()
        case .preparing, .downloadingModel: cancelListening()
        case .finalizing: break
        case .waitingReply: interrupt()
        }
    }

    /// Avvia l'ascolto; con `continuous` (o l'impostazione omonima) entra nella conversazione a mani libere.
    func startListening(continuous: Bool? = nil) {
        guard phase == .idle else { return }
        self.continuous = continuous ?? conversation.settings.continuousVoice
        emptyTurns = 0
        beginCapture()
    }

    func finishListening() {
        guard phase == .listening else { return }
        phase = .finalizing
        ticker?.cancel()
        conversation.currentTrace = LatencyTrace()
        conversation.currentTrace?.mark(.pttReleased)
        let token = captureGeneration
        Task { await finishAndSend(token: token) }
    }

    /// ✕: annulla l'ascolto e chiude la conversazione continua (Ernie, se sta parlando, finisce la frase).
    func cancelListening() {
        captureGeneration = UUID()
        continuous = false
        starter?.cancel()
        ticker?.cancel()
        phase = .idle
        liveTranscript = ""
        inputLevel = 0
        conversation.setListening(false)
        teardown(keepSession: false)
    }

    /// Barge-in dalla conversazione continua: ferma Ernie, dice al server fin dove è stato sentito, riapre il microfono.
    func interrupt() {
        guard phase == .waitingReply else { return }
        conversation.bargeIn()
        beginCapture()
    }

    // MARK: - privato

    private func beginCapture() {
        lastError = nil
        liveTranscript = ""
        lastFinalText = nil
        heardSpeech = false
        inputLevel = 0
        if speaker.isSpeaking || conversation.isBusy { conversation.bargeIn() }
        phase = .preparing
        captureGeneration = UUID()
        let token = captureGeneration
        starter = Task { await startCapture(token: token) }
    }

    private func startCapture(token: UUID) async {
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw NSError(domain: "Ernie.Speech", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "Permesso microfono negato: abilitalo in Impostazioni → Privacy e sicurezza → Microfono → Ernie.",
                ])
            }
            try Task.checkCancellation()
            await ensureModelWithProgress(token: token)
            try Task.checkCancellation()
            phase = .preparing
            // Mai aprire il microfono mentre la sintesi è in corso (mute logico): `beginCapture` l'ha già fermata.
            if !VoiceLoopPolicy.mayOpenMicrophone(speakerSpeaking: speaker.isSpeaking) { _ = speaker.stop() }
            try AudioSessionController.activateForVoice()
            let capture = MicrophoneCapture()
            capture.onLevel = { [weak self] level in
                Task { @MainActor [weak self] in self?.updateLevel(level) }
            }
            let audio = try await capture.start()
            guard captureGeneration == token, !Task.isCancelled else { capture.stop(); return }
            guard let format = capture.format else { throw NSError(domain: "Ernie.Speech", code: 5) }
            self.capture = capture
            voiceProcessingActive = capture.voiceProcessing
            let engine = await SpeechInputFactory.make()
            guard captureGeneration == token, !Task.isCancelled else { return }
            self.engine = engine
            engineName = engine.engineName
            let updates = try await engine.start(audio: audio, inputFormat: format)
            try Task.checkCancellation()
            guard captureGeneration == token else { return }
            phase = .listening
            detector = continuous ? TurnDetector() : nil
            conversation.setListening(true)
            Log.speech.info("ascolto avviato con \(engine.engineName, privacy: .public), continuo \(self.continuous)")
            reader = Task { [weak self] in
                for await update in updates {
                    guard let self, self.captureGeneration == token, !Task.isCancelled else { return }
                    self.liveTranscript = update.text
                    self.detector?.transcript(update.text, at: .now)
                    if update.isFinal { self.lastFinalText = update.text }
                }
            }
            if continuous { startTicker() }
        } catch is CancellationError {
            guard captureGeneration == token else { return }
            teardown(keepSession: continuous)
        } catch {
            guard captureGeneration == token, !Task.isCancelled else { return }
            Log.speech.error("avvio ascolto fallito: \(error.localizedDescription, privacy: .public)")
            fail(error.localizedDescription)
        }
    }

    /// Conversazione continua: ogni 100 ms chiede al rilevatore se il turno è finito.
    private func startTicker() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, self.phase == .listening, self.detector != nil else { return }
                switch self.detector!.verdict(at: .now) {
                case .keepListening: continue
                case .endOfTurn, .tooLong:
                    self.autoEndedTurns += 1
                    self.finishListening()
                    return
                case .noSpeech:
                    self.cancelListening()
                    self.lastError = "Non ho sentito nulla per un po': tocca il microfono quando vuoi riprendere."
                    return
                }
            }
        }
    }

    /// Se il modello italiano manca, lo scarica mostrando l'avanzamento; se fallisce si prosegue col ripiego (SFSpeechRecognizer).
    private func ensureModelWithProgress(token: UUID) async {
        modelState = await SpeechModel.shared.refresh()
        guard captureGeneration == token, !Task.isCancelled else { return }
        guard case .notInstalled = modelState else { return }
        phase = .downloadingModel(0)
        let install = Task { try await SpeechModel.shared.ensureInstalled() }
        let poller = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                if case .downloading(let p) = await SpeechModel.shared.state, self?.captureGeneration == token { self?.phase = .downloadingModel(p) }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        if case .failure(let error) = await install.result {
            Log.speech.warning("modello non scaricato, uso il ripiego: \(error.localizedDescription, privacy: .public)")
        }
        poller.cancel()
        modelState = await SpeechModel.shared.refresh()
    }

    private func updateLevel(_ level: Float) {
        guard phase == .listening else { return }
        inputLevel = level
        if level > 0.35 { heardSpeech = true }
        detector?.level(level, at: .now)
    }

    private func fail(_ message: String) {
        lastError = message
        continuous = false
        ticker?.cancel()
        phase = .idle
        inputLevel = 0
        conversation.setListening(false)
        teardown(keepSession: false)
    }

    private func finishAndSend(token: UUID) async {
        guard captureGeneration == token, phase == .finalizing else { return }
        guard let engine, let capture else {
            phase = .idle
            continuous = false
            conversation.setListening(false)
            return
        }
        capture.stop()
        // La finalizzazione arriva dal lettore dei risultati; oltre 3 s si usa l'ultimo parziale.
        let stopTask = Task { await engine.stop() }
        let deadline = ContinuousClock.now + .seconds(3)
        while lastFinalText == nil, ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(50))
        }
        stopTask.cancel()
        // ✕ premuto mentre trascrivevo: cancelListening ha già chiuso tutto, il messaggio non parte.
        guard captureGeneration == token, phase == .finalizing else { return }
        let text = (lastFinalText ?? liveTranscript).trimmingCharacters(in: .whitespacesAndNewlines)
        conversation.currentTrace?.mark(.transcriptFinal)
        let heard = heardSpeech
        let name = engineName
        let keepGoing = continuous
        teardown(keepSession: keepGoing)
        inputLevel = 0
        conversation.setListening(false)
        liveTranscript = ""
        guard !text.isEmpty else {
            conversation.currentTrace = nil
            if keepGoing, emptyTurns == 0 {
                // Primo turno vuoto a mani libere: si riprova senza disturbare.
                emptyTurns += 1
                phase = .idle
                beginCapture()
                return
            }
            continuous = false
            phase = .idle
            lastError = heard
                ? "Ho sentito la tua voce ma non ho trascritto nulla (\(name)). Riprova; se continua, apri Impostazioni → Diagnostica."
                : "Non ho sentito nulla dal microfono: parla più vicino al telefono e riprova."
            return
        }
        emptyTurns = 0
        phase = keepGoing ? .waitingReply : .idle
        conversation.send(text, inputMode: "voice")
    }

    /// Il turno è chiuso (risposta completa e voce finita): in conversazione continua si riapre il microfono.
    private func turnSettled() {
        guard VoiceLoopPolicy.shouldResumeListening(
            continuous: continuous, waitingReply: phase == .waitingReply,
            agentState: conversation.agentState, speakerSpeaking: speaker.isSpeaking
        ) else { return }
        beginCapture()
    }

    private func teardown(keepSession: Bool) {
        reader?.cancel()
        reader = nil
        ticker?.cancel()
        ticker = nil
        capture?.stop()
        capture = nil
        engine = nil
        detector = nil
        // In conversazione continua la sessione resta attiva tra un turno e l'altro: la riapertura è più rapida.
        if !keepSession { AudioSessionController.deactivate() }
    }

    // MARK: - eventi audio di sistema (B.7)

    /// Interruzioni (chiamate, altre app), cambi di route (cuffie), reset dei servizi media: niente crash e stato chiaro.
    private func observeAudioSession() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let typeRaw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsRaw = n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume)
            let reasonRaw = n.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
            Task { @MainActor [weak self] in
                self?.handleInterruption(
                    typeRaw.flatMap { AVAudioSession.InterruptionType(rawValue: $0) },
                    reason: reasonRaw.flatMap { AVAudioSession.InterruptionReason(rawValue: $0) },
                    shouldResume: shouldResume
                )
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] n in
            let reasonRaw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            Task { @MainActor [weak self] in
                self?.handleRouteChange(reasonRaw.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) })
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.handleMediaReset() }
        })
    }

    private func handleInterruption(_ type: AVAudioSession.InterruptionType?, reason: AVAudioSession.InterruptionReason?, shouldResume: Bool) {
        switch type {
        case .began:
            let why: String = switch reason {
            case .appWasSuspended: "l'app è passata in secondo piano"
            case .builtInMicMuted: "il microfono è stato disattivato"
            case .routeDisconnected: "il dispositivo audio si è scollegato"
            default: "una chiamata, Siri o una sveglia"
            }
            lastAudioEvent = AudioEvent(description: "Audio interrotto: \(why)", at: .now)
            Log.speech.warning("interruzione audio iniziata: \(why, privacy: .public)")
            let wasContinuous = continuous
            if speaker.isSpeaking { conversation.muteSpeech() }
            if phase == .listening || phase == .preparing {
                cancelListening()
                // Tornando nell'app non serve un errore rosso: basta toccare di nuovo il microfono.
                lastError = reason == .appWasSuspended ? nil : "Ascolto interrotto: \(why)."
            }
            // Resta segnato per riprendere a mani libere se il sistema lo consente.
            resumeAfterInterruption = wasContinuous
        case .ended:
            lastAudioEvent = AudioEvent(description: "Audio ripristinato" + (shouldResume ? " (ripresa consentita)" : ""), at: .now)
            Log.speech.info("interruzione audio finita, ripresa \(shouldResume)")
            if shouldResume, resumeAfterInterruption, phase == .idle {
                lastError = nil
                startListening(continuous: true)
            }
            resumeAfterInterruption = false
        default:
            break
        }
    }

    private func handleRouteChange(_ reason: AVAudioSession.RouteChangeReason?) {
        guard let reason, reason == .oldDeviceUnavailable || reason == .newDeviceAvailable else { return }
        let what = reason == .oldDeviceUnavailable ? "scollegato" : "collegato"
        lastAudioEvent = AudioEvent(description: "Dispositivo audio \(what): \(AudioSessionController.routeSummary())", at: .now)
        Log.speech.info("cambio di route: \(what, privacy: .public)")
        // Cuffie scollegate mentre ascolta: il tap del microfono resta sul formato vecchio → si riparte sulla nuova route.
        if reason == .oldDeviceUnavailable, phase == .listening {
            let keep = continuous
            ticker?.cancel()
            phase = .idle
            conversation.setListening(false)
            Task {
                teardown(keepSession: true)
                self.continuous = keep
                self.beginCapture()
            }
        }
    }

    private func handleMediaReset() {
        lastAudioEvent = AudioEvent(description: "Servizi audio di sistema riavviati", at: .now)
        Log.speech.error("mediaServicesWereReset: ricostruisco l'audio")
        _ = speaker.stop()
        speaker.rebuild()
        if phase != .idle {
            cancelListening()
            lastError = "I servizi audio del sistema si sono riavviati: tocca il microfono per riprendere."
        }
    }
}
