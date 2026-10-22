import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

private enum BrainFactualFixtures {
    static let path = "Persone/Anna Rossi.md"
    static var routine: BrainRoutine {
        .init(id: "routine-school", title: "Scuola di Sofia", days: [1, 2, 3, 4, 5], timeZone: "Europe/Rome",
              startTime: "08:30", endTime: "16:00", dropOffTime: "08:15", pickupTime: "16:10", homeTime: "16:40",
              place: "Scuola del parco", validFrom: "2026-09-14", validUntil: "2027-06-10", notes: "Il mercoledì porta il materiale per disegno.",
              updatedAt: "2026-10-21T09:00:00Z", exceptions: [.init(date: "2026-10-23", status: "cancelled", notes: "Scuola chiusa")])
    }
    static var note: BrainNoteDetail {
        .init(path: path, title: "Anna Rossi", type: "persona", created: "2026-10-12", links: [], private: false,
              body: "Annotazioni precedenti della persona.\n\nInformazioni conservate nella cronologia.",
              knowledge: .init(version: 1, facts: [
                .init(id: "fact-shoes", label: "Numero di scarpe", value: "39", updatedAt: "2026-10-21T09:00:00Z"),
                .init(id: "fact-preference", label: "Preferenza alimentare", value: "Vegetariana", updatedAt: "2026-10-20T10:00:00Z")
              ], routines: [routine]))
    }
    static var agenda: BrainAgenda {
        .init(date: "2026-10-21", timeZone: "Europe/Rome", entries: [
            .init(notePath: path, noteTitle: "Anna Rossi", routineId: "school", title: "Scuola di Sofia", timeZone: "Europe/Rome", status: "planned",
                  startTime: "08:30", endTime: "16:00", dropOffTime: "08:15", pickupTime: "16:10", homeTime: "16:40", place: "Scuola del parco"),
            .init(notePath: "Persone/Luca Bianchi.md", noteTitle: "Luca Bianchi", routineId: "music", title: "Lezione di musica", timeZone: "Europe/London", status: "cancelled",
                  startTime: "17:00", endTime: "18:00", notes: "Lezione annullata dall’insegnante")
        ], subjects: [.init(path: path, title: "Anna Rossi"), .init(path: "Persone/Luca Bianchi.md", title: "Luca Bianchi")])
    }
    static func summary(_ title: String, type: String = "persona", suffix: String = "") -> BrainNoteSummary {
        .init(path: "\(type)/\(title)\(suffix).md", title: title, type: type, created: "2026-10-21", links: [], private: false, excerpt: "")
    }
    static var directory: BrainDirectory {
        .init(total: 128, groups: [
            .init(type: "persona", count: 104, notes: [summary("Zoe Verdi"), summary("Anna Rossi"), summary("Luca Bianchi")]),
            .init(type: "luogo", count: 24, notes: [summary("Scuola del parco", type: "luogo"), summary("Casa sul lago", type: "luogo")])
        ], truncated: true)
    }
}

struct BrainKnowledgeTests {
    @Test func decodificaFattiOrariEVecchieSchedeSenzaKnowledge() throws {
        let current = try JSONDecoder().decode(BrainNoteDetail.self, from: JSONEncoder().encode(BrainFactualFixtures.note))
        #expect(current.hasKnowledge)
        #expect(current.knowledge?.facts.first?.value == "39")
        #expect(current.knowledge?.routines.first?.homeTime == "16:40")
        #expect(current.knowledge?.routines.first?.exceptions.first?.status == "cancelled")
        var legacy = BrainFactualFixtures.note
        legacy.knowledge = nil
        legacy.overview = .init(facts: [.init(text: "Fatto storico", sourcePath: legacy.path, sourceTitle: legacy.title)], places: [])
        let restored = try JSONDecoder().decode(BrainNoteDetail.self, from: JSONEncoder().encode(legacy))
        #expect(!restored.hasKnowledge)
        #expect(restored.hasOverview)
        #expect(restored.body == legacy.body)
        legacy.knowledge = .init(version: 2, facts: [], routines: [BrainFactualFixtures.routine])
        #expect(!legacy.hasKnowledge) // Unknown versions keep the readable Markdown fallback.
    }

    @Test func eccezioneDistingueValoriRimossiDaCampiNonModificati() throws {
        let json = #"{"date":"2026-10-22","status":"changed","pickupTime":null,"homeTime":"17:00","place":null}"#
        let value = try JSONDecoder().decode(BrainRoutineException.self, from: Data(json.utf8))
        #expect(value.clearedFields == ["pickupTime", "place"])
        #expect(value.startTime == nil)
        #expect(!value.clearedFields.contains("startTime"))
        #expect(value.homeTime == "17:00")
    }

    @Test func elencoAlfabeticoMantieneConteggiRealiEOmonimi() {
        var directory = BrainFactualFixtures.directory
        directory.groups[0].notes += [BrainFactualFixtures.summary("Anna Rossi", suffix: "-2")]
        #expect(directory.total == 128)
        #expect(directory.groups[0].count == 104)
        #expect(directory.alphabeticalGroups.map(\.type) == ["luogo", "persona"])
        let people = directory.groups[0].alphabeticalNotes
        #expect(people.map(\.title) == ["Anna Rossi", "Anna Rossi", "Luca Bianchi", "Zoe Verdi"])
        #expect(Set(people.map(\.id)).count == 4)
        #expect(directory.truncated)
        #expect(BrainViewMode.allCases.first == .indice)
    }

    @Test func agendaMantieneAnnullamentiFusiEOreAssentiSenzaInferenze() throws {
        let response = try JSONDecoder().decode(BrainAgenda.self, from: JSONEncoder().encode(BrainFactualFixtures.agenda))
        #expect(response.entries.last?.status == "cancelled")
        #expect(response.entries.last?.timeZone == "Europe/London")
        #expect(response.entries.last?.homeTime == nil)
        let labels = BrainRoutinePresentation.times(start: "09:00", end: "12:00", dropOff: nil, pickup: nil, home: nil)
        #expect(labels.map(\.0) == ["Inizio", "Fine"])
        #expect(BrainRoutinePresentation.days([7, 1, 7, 0, 8]) == "lunedì, domenica")
        var empty = response
        empty.entries = []
        #expect(empty.subjects.count == 2) // No entries must never imply nobody has routines / everybody is home.
    }

    @Test func dataEQueryUsanoFusoPercorsoRiservatiECodificaSicura() throws {
        let day = ISO8601DateFormatter().date(from: "2026-10-25T23:30:00Z")!
        #expect(BrainAgendaQuery.day(day, timeZone: "Europe/Rome") == "2026-10-26")
        #expect(BrainAgendaQuery.day(day, timeZone: "America/New_York") == "2026-10-25")
        let query = BrainAgendaQuery(date: "2026-10-25", timeZone: "Etc/GMT+3", ref: "Persone/Anna & Sofia + 2.md")
        let url = try #require(URLComponents(string: query.requestPath))
        #expect(url.path == "/v1/brain/agenda")
        #expect(url.queryItems?.first { $0.name == "ref" }?.value == query.ref)
        #expect(url.queryItems?.first { $0.name == "timeZone" }?.value == "Etc/GMT+3")
        #expect(url.queryItems?.contains { $0.name == "includePrivate" } == false)
        #expect(query.requestPath.contains("%2B"))
    }

    @Test func APIIndiceNonLimitaIlConteggioAlNumeroDiSchedeRicevute() async throws {
        let data = try JSONEncoder().encode(BrainFactualFixtures.directory)
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.invalid")!, apiKey: "synthetic"), transport: { request in
            #expect(request.url?.path == "/v1/brain/directory")
            #expect(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.query == nil)
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let result = try await api.brainDirectory()
        #expect(result.total == 128)
        #expect(result.groups.reduce(0) { $0 + $1.notes.count } == 5)
    }
}

@MainActor struct BrainAgendaLifecycleTests {
    private let credentials = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "synthetic")
    @Test func cambioDataIgnoraRispostaVecchiaELogoutRimuoveDati() async throws {
        let store = BrainAgendaStore()
        let first = BrainAgendaQuery(date: "2026-10-21", timeZone: "Europe/Rome")
        let second = BrainAgendaQuery(date: "2026-10-22", timeZone: "Europe/Rome")
        var continuation: CheckedContinuation<BrainAgenda, any Error>?
        let pending = Task { await store.load(first, credentials: credentials) { _ in
            try await withCheckedThrowingContinuation { continuation = $0 }
        } }
        for _ in 0..<1000 { if continuation != nil { break }; await Task.yield() }
        let callback = try #require(continuation)
        var next = BrainFactualFixtures.agenda; next.date = second.date; next.entries = []
        await store.load(second, credentials: credentials) { _ in next }
        callback.resume(returning: BrainFactualFixtures.agenda)
        await pending.value
        #expect(store.result(for: first, credentials: credentials) == nil)
        #expect(store.result(for: second, credentials: credentials)?.date == second.date)
        #expect(store.result(for: second, credentials: .init(serverURL: credentials.serverURL, apiKey: "another-account")) == nil)
        store.clear()
        #expect(store.result == nil)
        #expect(!store.loading)
    }
    @Test func erroreNonSembraUnAgendaVuota() async {
        let store = BrainAgendaStore()
        let query = BrainAgendaQuery(date: "2026-10-21", timeZone: "Europe/Rome")
        await store.load(query, credentials: credentials) { _ in throw ApiError(status: 403, code: "forbidden", message: "Accesso negato") }
        #expect(store.result == nil)
        #expect(store.error != nil)
        #expect(!store.loading)
    }
}

@MainActor struct BrainFactualRenderTests {
    @Test func renderNativiIndicePersonaEAgenda() async throws {
        let directory = URL(fileURLWithPath: "/tmp/ernie-brain-factual-ios-20261021/renders")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (variant, width, scheme, size) in [("light", CGFloat(390), ColorScheme.light, DynamicTypeSize.large),
                                               ("dark", CGFloat(390), ColorScheme.dark, DynamicTypeSize.large),
                                               ("large", CGFloat(320), ColorScheme.light, DynamicTypeSize.xxxLarge)] {
            let index = AnyView(NavigationStack {
                List {
                    Section { BrainModePicker(mode: .constant(.indice)) }
                    Section { Button("Orari per data", systemImage: "calendar") {} }
                    BrainDirectorySections(directory: BrainFactualFixtures.directory) { _ in }
                }.navigationTitle("Second brain").navigationBarTitleDisplayMode(.inline)
                    .searchable(text: .constant(""), prompt: "Cerca nelle note")
            })
            let person = AnyView(ScrollView {
                BrainNoteContent(note: BrainFactualFixtures.note, openAgenda: {}).padding(20)
            }.background(Theme.surface))
            let agenda = AnyView(ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Orari per data").font(.title2.bold())
                    DatePicker("Data", selection: .constant(Date(timeIntervalSince1970: 1_792_541_600)), displayedComponents: .date)
                    BrainAgendaContent(agenda: BrainFactualFixtures.agenda) { _ in }
                }.padding(20)
            }.background(Theme.surface))
            for (kind, content) in [("index", index), ("person", person), ("agenda", agenda)] {
                let viewport = content.frame(width: width, height: 844)
                    .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                    .environment(\.locale, Locale(identifier: "it_IT"))
                let controller = UIHostingController(rootView: viewport)
                controller.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
                let dimensions = CGSize(width: width, height: 844)
                let window = UIWindow(frame: CGRect(origin: .zero, size: dimensions))
                window.rootViewController = controller; window.isHidden = false
                controller.view.frame = window.bounds
                controller.view.setNeedsLayout(); controller.view.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(200))
                let format = UIGraphicsImageRendererFormat(); format.scale = 2
                let image = UIGraphicsImageRenderer(size: dimensions, format: format).image { _ in
                    #expect(controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true))
                }
                window.isHidden = true
                try #require(image.pngData()).write(to: directory.appendingPathComponent("\(kind)-\(variant).png"))
            }
        }
    }
}
