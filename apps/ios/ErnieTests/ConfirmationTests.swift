import Foundation
import SwiftUI
import Testing
@testable import Ernie

struct ConfirmationTests {
    private let presentation = ConfirmationPresentation(
        title: "Salvare questa ricetta?",
        summary: "«Burritos con tempeh» verrà salvata nella tua raccolta. Se il titolo esiste già, la ricetta verrà aggiornata.",
        confirmLabel: "Salva ricetta",
        details: [
            .init(label: "Ingredienti", value: "• 200 g di tempeh al naturale\n• 1 cucchiaino di paprica affumicata\n• 70 ml di salsa di pomodoro\n• 2 tortillas"),
            .init(label: "Preparazione", value: "1. Taglia il tempeh e insaporiscilo con la paprica.\n2. Cuoci con la salsa e distribuisci nelle tortillas."),
            .init(label: "Porzioni", value: "2"),
            .init(label: "Tag", value: "• vegetale\n• veloce")
        ])

    private func card(presentation: ConfirmationPresentation? = nil) -> ConfirmationCard {
        ConfirmationCard(approvalId: "a", correlationId: "c", toolId: "recipe_save", reason: "run contaminata da contenuto non fidato (Rule of Two)", expiresAt: "2099-10-18T08:00:00.000Z", allowAlways: true, presentation: presentation)
    }

    @Test func confermaStrutturataSopravviveAllaCronologia() throws {
        let value = card(presentation: presentation)
        let decoded = try JSONDecoder().decode(ConfirmationCard.self, from: JSONEncoder().encode(value))
        #expect(decoded == value)
        #expect(ConfirmationCopy.presentation(for: decoded).details[1].value.contains("2. Cuoci"))
        let oldJSON = #"{"approvalId":"a","correlationId":"c","toolId":"recipe_save","expiresAt":"2099-10-18T08:00:00Z"}"#
        let old = try JSONDecoder().decode(ConfirmationCard.self, from: Data(oldJSON.utf8))
        #expect(old.presentation == nil)
    }

    @Test func decodificaPayloadServerConTuttiIDettagli() throws {
        let p = ToolConfirmationRequestedPayload(approvalId: "a", toolCallId: "t", toolId: "recipe_save", expiresAt: "2099-10-18T08:00:00Z", allowAlways: true, presentation: presentation)
        let event = AgentEvent(payload: .toolConfirmationRequested(p), sessionId: "s", correlationId: "c", seq: 1)
        let decoded = try AgentEvent.decode(event.encoded())
        guard case .toolConfirmationRequested(let received) = decoded.payload else { Issue.record("Conferma non decodificata"); return }
        #expect(received.presentation == presentation)
        #expect(received.allowAlways == true)
    }

    @Test func messaggiTecniciPrecedentiDiventanoComprensibili() {
        let reason = ConfirmationCopy.reason(card().reason)
        #expect(reason == "Prima di procedere, controlla i dati ricavati dai contenuti che ho letto.")
        #expect(ConfirmationCopy.reason("possibile fuga di dati: Rule of Two")?.contains("servizio esterno") == true)
        #expect(ConfirmationCopy.reason("azione con effetto esterno con rischio 0.90")?.contains("rischio") == false)
        #expect(ConfirmationCopy.alwaysExplanation(for: "recipe_save").contains("tutte le ricette salvate o aggiornate"))
    }

    @Test func vecchioJSONCompletoETroncatoNonCompareInScheda() {
        var value = card()
        value.argsPreview = #"{"title":"Burritos con tempeh","ingredients":["200 g di tempeh"],"steps":["Cuoci"]}"#
        let complete = ConfirmationCopy.presentation(for: value)
        #expect(complete.summary.contains("Burritos con tempeh"))
        #expect(complete.details.contains { $0.label == "Ingredienti" && $0.value == "• 200 g di tempeh" })
        #expect(complete.incomplete == false)
        value.argsPreview = #"{"title":"Torta \"di casa\"","ingredients":["200 g di…"#
        let partial = ConfirmationCopy.presentation(for: value)
        #expect(partial.summary.contains("Torta \"di casa\""))
        #expect(partial.incomplete == true)
        #expect(partial.details.isEmpty)
        #expect(!partial.summary.contains("ingredients"))
    }

    @Test func confermeScaduteNonOffronoUnaNuovaApprovazione() throws {
        var value = card()
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-18T08:00:00Z"))
        #expect(ConfirmationCopy.decision(for: value, now: now) == nil)
        value.expiresAt = "2026-10-18T08:00:00.000Z"
        #expect(ConfirmationCopy.decision(for: value, now: now) == "expired")
        value.decision = "approved"
        #expect(ConfirmationCopy.decision(for: value, now: now) == "approved")
        value.decision = nil
        value.expiresAt = "2026-10-18T07:59:00Z"
        #expect(ConfirmationCopy.decision(for: value, now: now) == "expired")
    }

    @Test func riepilogoCompattoConservaOggettoEStatoSenzaDichiarareIlSalvataggioRiuscito() {
        var value = card(presentation: presentation)
        value.decision = "approved"
        #expect(ConfirmationCopy.compactTitle(for: value) == "Burritos con tempeh")
        #expect(ConfirmationCopy.compactSummary(for: value).contains("verrà aggiornata"))
        #expect(ConfirmationCopy.status(for: value, decision: "approved") == "Confermata")
        value.always = true
        #expect(ConfirmationCopy.status(for: value, decision: "approved").contains("consenso salvato"))
        value.toolId = "shopping_list_add"
        #expect(ConfirmationCopy.compactTitle(for: value) == ToolLabels.name("shopping_list_add"))
        #expect(ConfirmationCopy.compactSummary(for: value) == presentation.summary)
    }

    @Test @MainActor func confermeChiuseOccupanoMenoDiMetaSpazioEDettagliRestanoConsultabili() throws {
        func image(_ value: ConfirmationCard, expanded: Bool = false) throws -> UIImage {
            let content = ConfirmationCardContent(card: value, reviewExpanded: expanded)
                .padding(16).frame(width: 390).background(Theme.ground)
                .environment(\.dynamicTypeSize, .large)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            return try #require(renderer.uiImage)
        }
        let pending = try image(card(presentation: presentation))
        for decision in ["approved", "denied", "expired"] {
            var value = card(presentation: presentation)
            value.decision = decision
            let closed = try image(value)
            let open = try image(value, expanded: true)
            #expect(closed.size.height < pending.size.height / 2)
            #expect(closed.size.height <= 140)
            #expect(open.size.height > closed.size.height * 2)
            for (suffix, rendered) in [("closed", closed), ("open", open)] {
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-confirmation-\(decision)-\(suffix).png")
                try #require(rendered.pngData()).write(to: url)
                print("CONFIRMATION_SNAPSHOT: \(url.path) height=\(rendered.size.height)")
            }
        }
    }

    @Test @MainActor func anteprimeChiaroScuroTestoGrandeEDettagli() throws {
        for (name, width, size, scheme, expanded) in [
            ("light", CGFloat(390), DynamicTypeSize.large, ColorScheme.light, false),
            ("dark", CGFloat(390), .large, .dark, false),
            ("small", CGFloat(320), .xxxLarge, .light, false),
            ("details", CGFloat(390), .large, .light, true)
        ] {
            let content = ConfirmationCardContent(card: card(presentation: presentation), detailsExpanded: expanded)
                .padding(16).frame(width: width).background(Theme.ground)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == width)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-confirmation-\(name).png")
            try #require(image.pngData()).write(to: url)
            print("CONFIRMATION_SNAPSHOT: \(url.path)")
        }
        for (name, width, size, scheme) in [
            ("approved-dark", CGFloat(390), DynamicTypeSize.large, ColorScheme.dark),
            ("approved-small", CGFloat(320), .xxxLarge, .light),
            ("approved-accessible", CGFloat(320), .accessibility3, .dark)
        ] {
            var value = card(presentation: presentation)
            value.decision = "approved"
            value.always = true
            let content = ConfirmationCardContent(card: value)
                .padding(16).frame(width: width).background(Theme.ground)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == width)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-confirmation-\(name).png")
            try #require(image.pngData()).write(to: url)
            print("CONFIRMATION_SNAPSHOT: \(url.path) height=\(image.size.height)")
        }
    }
}
