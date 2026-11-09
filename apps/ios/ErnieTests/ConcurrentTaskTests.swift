import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

@MainActor @Suite(.serialized) struct ConcurrentTaskTests {
    private let credentials = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only")

    private func withModel(kind: String = "ask", resolver: ((TaskIntentRequest) async throws -> TaskIntentDecision)? = nil,
                           _ body: @MainActor (AppModel, TranscriptStore) async throws -> Void) async throws {
        let name = "tasks-" + UUID().uuidString
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        let defaults = try #require(UserDefaults(suiteName: name))
        let transcript = TranscriptStore(directory: directory, defaults: defaults)
        let speaker = Speaker(), inbox = InboxStore()
        var settings = LocalSettings(); settings.voiceOutput = false
        let store = ConversationStore(credentials: credentials, speaker: speaker, inbox: inbox, settings: settings,
                                      transcript: transcript, deviceContext: { nil })
        let task = ConcurrentTask(conversation: store, speaker: speaker, voice: VoiceController(conversation: store, speaker: speaker))
        let model = AppModel(testTasks: [task], credentials: credentials, transcript: transcript, resolver: resolver ?? { request in
            .init(kind: kind, targetId: kind == "steer" ? request.tasks.first?.id : nil, confidence: 1, sharedResources: false)
        })
        defer {
            for task in model.concurrentTasks { task.conversation.disconnect(); task.voice.cancelListening() }
            transcript.clearAll()
            PendingTaskInput.clearSaved()
            defaults.removePersistentDomain(forName: name)
        }
        try await body(model, transcript)
    }

    private func waitForResolution(_ model: AppModel) async {
        for _ in 0..<1000 { if !model.resolvingTask { return }; await Task.yield() }
        #expect(!model.resolvingTask)
    }

    @Test func nuovoCompitoHaSessioneERispostaIndipendenti() async throws {
        try await withModel(kind: "new") { model, transcript in
            let first = try #require(model.conversation)
            first.send("Controlla il sito", inputMode: "text")
            let request = try #require(first.activeCorrelationId)
            first.send("Che tempo farà domani?", inputMode: "text")
            await waitForResolution(model)
            let second = try #require(model.conversation)
            #expect(model.concurrentTasks.count == 2 && first !== second)
            #expect(first.sessionId != second.sessionId && first.activeCorrelationId == request)
            #expect(second.activeCorrelationId != nil)
            #expect(first.items.count == 1 && second.items.count == 1)
            #expect(!first.isForeground && second.isForeground)
            let event = AgentEvent(payload: .assistantTextCompleted(.init(text: "Risultato sito")),
                                   sessionId: first.sessionId, correlationId: request, seq: 1)
            first.apply(event); second.apply(event)
            #expect(first.items.count == 2 && second.items.count == 1)
            let completed = AgentEvent(payload: .assistantCompleted(.init(finishReason: "stop")),
                                       sessionId: first.sessionId, correlationId: request, seq: 2)
            first.apply(completed); second.apply(completed)
            #expect(first.activeCorrelationId == nil && second.activeCorrelationId != nil)
            #expect(transcript.load(first.sessionId)?.items.count == 2)
            model.selectTask(first.sessionId)
            #expect(model.conversation === first && first.isForeground && !second.isForeground)
        }
    }

    @Test func precisazioneRestaNelloStessoCompitoEAmbiguitaNonParte() async throws {
        try await withModel { model, _ in
            let first = try #require(model.conversation)
            first.send("Prepara una cena", inputMode: "text")
            first.send("Siamo in quattro", inputMode: "text")
            await waitForResolution(model)
            #expect(model.pendingTaskInput?.text == "Siamo in quattro")
            #expect(first.items.count == 1 && model.concurrentTasks.count == 1)
            model.resolvePendingTask(targetId: first.sessionId)
            #expect(model.pendingTaskInput == nil && model.conversation === first)
            #expect(first.items.count == 2 && first.queuedCount == 1) // Offline fallback, same thread.
        }
    }

    @Test func alMassimoTreCompitiENessunMessaggioPersoQuandoPieno() async throws {
        try await withModel(kind: "new") { model, _ in
            model.conversation?.send("Primo compito", inputMode: "text")
            model.conversation?.send("Secondo compito", inputMode: "text")
            await waitForResolution(model)
            model.conversation?.send("Terzo compito", inputMode: "text")
            await waitForResolution(model)
            #expect(model.concurrentTasks.count == 3 && !model.canStartParallelTask)
            model.conversation?.send("Quarto compito", inputMode: "text")
            await waitForResolution(model)
            #expect(model.pendingTaskInput?.text == "Quarto compito")
            #expect(model.concurrentTasks.count == 3)
            model.queuePendingTask()
            #expect(model.pendingTaskInput == nil && model.conversation?.queuedCount == 1)
        }
    }

    @Test func diarioEArchivioNonEntranoNelRisolutoreDuranteUnCompito() async throws {
        try await withModel { model, _ in
            let store = try #require(model.conversation)
            store.send("Controlla il sito", inputMode: "text")
            store.send("Nella chat con Giorgio cosa abbiamo deciso?", inputMode: "text")
            #expect(store.chatArchiveReference != nil && model.pendingTaskInput == nil)
            store.send("apri diario", inputMode: "text")
            #expect(store.diaryLaunch != nil && model.pendingTaskInput == nil && store.items.count == 1)
        }
    }

    @Test func inputVocaleConservaCompitoMentreStopLoAnnulla() async throws {
        try await withModel { model, _ in
            let store = try #require(model.conversation)
            store.send("Prepara una cena", inputMode: "text")
            let original = try #require(store.activeCorrelationId)
            store.prepareForSpokenInput()
            #expect(store.activeCorrelationId == original)
            store.send("Siamo in quattro", inputMode: "voice")
            await waitForResolution(model)
            #expect(model.pendingTaskInput?.inputMode == "voice" && store.activeCorrelationId == original)
            model.queuePendingTask()
            store.bargeIn()
            // Cancellation is acknowledged by the server (offline fallback takes three seconds).
            store.apply(.init(payload: .assistantCancelled(.init(reason: "user")),
                              sessionId: store.sessionId, correlationId: original, seq: 1))
            #expect(store.activeCorrelationId != original)
        }
    }

    @Test func decisioneInRitardoNonSiApplicaAlTurnoSuccessivo() async throws {
        var complete: CheckedContinuation<TaskIntentDecision, Never>?
        try await withModel(resolver: { _ in await withCheckedContinuation { complete = $0 } }) { model, _ in
            let store = try #require(model.conversation)
            store.send("Piano cena", inputMode: "text")
            let first = try #require(store.activeCorrelationId)
            store.send("Siamo in quattro", inputMode: "text")
            for _ in 0..<1000 { if complete != nil { break }; await Task.yield() }
            store.apply(.init(payload: .assistantCompleted(.init(finishReason: "stop")), sessionId: store.sessionId, correlationId: first, seq: 1))
            store.send("Controlla il sito", inputMode: "text")
            let second = try #require(store.activeCorrelationId)
            complete?.resume(returning: .init(kind: "steer", targetId: store.sessionId, confidence: 1, sharedResources: false))
            await waitForResolution(model)
            #expect(first != second && store.activeCorrelationId == second)
            #expect(model.pendingTaskInput?.text == "Siamo in quattro")
            #expect(store.queuedCount == 0)
            model.editPendingTask()
        }
    }

    @Test func richiestaInAttesaProteggeLaConversazioneDiOrigine() async throws {
        try await withModel { model, _ in
            let first = try #require(model.conversation)
            first.send("Piano cena", inputMode: "text")
            model.newConversation(); model.conversation?.send("Controlla sito", inputMode: "text")
            model.newConversation(); model.conversation?.send("Cerca un libro", inputMode: "text")
            model.selectTask(first.sessionId)
            first.send("Senza latticini", inputMode: "text")
            await waitForResolution(model)
            let request = try #require(first.activeCorrelationId)
            first.apply(.init(payload: .assistantCompleted(.init(finishReason: "stop")), sessionId: first.sessionId, correlationId: request, seq: 1))
            #expect(!model.canStartParallelTask)
            model.newConversation()
            #expect(model.concurrentTasks.contains { $0.conversation === first })
            model.queuePendingTask()
            #expect(first.activeTaskTitle == "Senza latticini")
        }
    }

    @Test func avvisiGlobaliArrivanoSoloAllaConversazioneVisibile() async throws {
        try await withModel { model, _ in
            let first = try #require(model.conversation)
            first.send("Piano cena", inputMode: "text")
            model.newConversation()
            let second = try #require(model.conversation)
            let card = NotificationCard(.init(id: "notice", kind: "test", title: "Avviso", body: "Prova", createdAt: "2026-11-09T08:00:00Z"))
            model.inbox.onCards?([card])
            #expect(!first.items.contains { $0.id == "n:notice" })
            #expect(second.items.contains { $0.id == "n:notice" })
        }
    }

    @Test func sceltaRichiedeCertezzaEUnIDDelCatalogo() {
        let candidates = [TaskIntentRequest.Candidate(id: "a", title: "Cena")]
        #expect(TaskIntentDecision(kind: "steer", targetId: "foreign", confidence: 1, sharedResources: false).destination(in: candidates) == nil)
        #expect(!TaskIntentDecision(kind: "new", targetId: nil, confidence: 0.8, sharedResources: false).isIndependent)
        #expect(!TaskIntentDecision(kind: "new", targetId: nil, confidence: 1, sharedResources: true).isIndependent)
        #expect(TaskIntentDecision(kind: "steer", targetId: "a", confidence: 1, sharedResources: false).destination(in: candidates) == "a")
    }

    @Test func cronologiaProteggeCompitiAttiviENonRicreaQuelliEliminati() async throws {
        try await withModel { model, transcript in
            let first = try #require(model.conversation)
            first.send("Piano cena", inputMode: "text")
            let request = try #require(first.activeCorrelationId)
            model.newConversation()
            #expect(!model.canDeleteConversation(first.sessionId))
            #expect(!model.deleteConversation(first.sessionId))
            first.apply(.init(payload: .assistantCompleted(.init(finishReason: "stop")),
                              sessionId: first.sessionId, correlationId: request, seq: 1))
            #expect(model.deleteConversation(first.sessionId))
            first.apply(.init(payload: .assistantCompleted(.init(finishReason: "stop")),
                              sessionId: first.sessionId, correlationId: request, seq: 2))
            #expect(transcript.load(first.sessionId) == nil)
            #expect(!model.concurrentTasks.contains { $0.id == first.sessionId })
        }
    }

    @Test func anteprimaSceltaFraCompitiConservaIlMessaggio() async throws {
        try await withModel { model, _ in
            model.conversation?.send("Organizza la cena", inputMode: "text")
            model.newConversation()
            model.conversation?.send("Controlla il sito", inputMode: "text")
            model.conversation?.send("Aggiungi anche questo dettaglio", inputMode: "text")
            await waitForResolution(model)
            let pending = try #require(model.pendingTaskInput)
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-task-style")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let previous = scene.windows.first(where: \.isKeyWindow)
            defer { previous?.makeKeyAndVisible() }
            for (name, costume): (String, BearCostume) in [("light", .base), ("borg", .borg)] {
                let palette = ChatPalette(costume: costume)
                let content = VStack(spacing: 16) {
                    ConcurrentTasksBar()
                    TaskInputChoiceView(input: pending)
                    Spacer(minLength: 0)
                }.padding(.vertical, 16).frame(width: 390).background(palette.ground)
                    .environment(model).environment(\.chatPalette, palette)
                    .environment(\.colorScheme, costume == .borg ? .dark : .light)
                let host = UIHostingController(rootView: content)
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
                window.rootViewController = host; window.makeKeyAndVisible()
                try await Task.sleep(for: .milliseconds(200))
                host.view.layoutIfNeeded()
                let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                    #expect(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
                }
                #expect(image.size.width == 390)
                let destination = folder.appendingPathComponent("\(name).png")
                try #require(image.pngData()).write(to: destination)
                print("TASK_STYLE_SNAPSHOT: \(destination.path)")
                window.isHidden = true
            }
            #expect(model.pendingTaskInput?.text == pending.text)
        }
    }

    @Test func salvataggiInBackgroundMantengonoOrdineENonRisorgonoDopoEliminazione() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let transcript = TranscriptStore(directory: directory)
        defer { transcript.clearAll() }
        for i in 0..<100 {
            transcript.saveInBackground(.init(sessionId: "test", lastSeq: i, items: [], updatedAt: .now))
        }
        #expect(transcript.load("test")?.lastSeq == 99)
        transcript.saveInBackground(.init(sessionId: "test", lastSeq: 100, items: [], updatedAt: .now))
        transcript.clearAll()
        #expect(transcript.load("test") == nil && transcript.list().isEmpty)
    }
}
