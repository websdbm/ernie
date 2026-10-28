import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

@MainActor struct SlashCommandTests {
    private func skill(_ id: String, active: Bool) -> SkillInfo {
        .init(id: id, title: id, summary: nil, description: "", kind: "builtin", tools: [], examples: [],
              available: active, enabled: active, active: active)
    }
    @Test func soloSlashAllInizioEDelimitazioneDelComando() throws {
        #expect(SlashInput("https://example.test/a/b") == nil)
        #expect(SlashInput("Spiega /messaggio") == nil)
        #expect(SlashInput("  /MSG ciao\nseconda riga  ")?.command == .message)
        #expect(SlashInput("  /MSG ciao\nseconda riga  ")?.arguments == "ciao\nseconda riga")
        #expect(SlashInput("/attività")?.command == .todo)
        #expect(SlashInput("/messaggiotest")?.command == nil)
        #expect(SlashInput("/usr/bin")?.command == nil)
        #expect(SlashInput("/diario testo privato")?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashInput("/ testo da conservare")?.validationError(skills: [], hasAttachment: false) != nil)
    }
    @Test func suggerimentiFiltratiESkillSpenteNonSiAttivano() throws {
        let all = try #require(SlashInput("/"))
        #expect(all.suggestions(skills: nil).contains(.message))
        #expect(!all.suggestions(skills: nil).contains(.ssh))
        #expect(!all.suggestions(skills: [skill("ssh", active: false)]).contains(.ssh))
        #expect(all.suggestions(skills: [skill("ssh", active: true)]).contains(.ssh))
        #expect(SlashInput("/mes")?.suggestions(skills: []) == [.message])
        #expect(SlashInput("/mem")?.suggestions(skills: [skill("second_brain", active: true)]) == [.brain])
        #expect(SlashInput("/ssh")?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashInput("/ssh")?.validationError(skills: [skill("ssh", active: true)], hasAttachment: false) == nil)
    }
    @Test func testoMessaggioConservatoAllegatiENavigazioneNonVengonoInviati() throws {
        let input = try #require(SlashInput("/messaggio Ciao! /questo resta testo"))
        #expect(input.arguments == "Ciao! /questo resta testo")
        #expect(input.validationError(skills: [], hasAttachment: false) == nil)
        #expect(input.validationError(skills: [], hasAttachment: true) != nil)
        #expect(SlashInput("/impostazioni testo")?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashInput("/messaggio " + String(repeating: "x", count: 2001))?.validationError(skills: [], hasAttachment: false) != nil)
        #expect(SlashCommand.usage.destination == .usage)
        #expect(SlashCommand.message.destination == nil) // Prepara il compositore; non invia.
    }
    @Test func menuRenderizzatoInEntrambeLeSkinECaratteriGrandi() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-slash-110")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (name, costume, scheme, width, size) in [
            ("borg", BearCostume.borg, ColorScheme.dark, CGFloat(390), DynamicTypeSize.large),
            ("light", .base, .light, 390, .large),
            ("accessible", .base, .dark, 320, .accessibility2)
        ] {
            let palette = ChatPalette(costume: costume)
            let content = SlashCommandMenu(commands: [.message, .family, .help], onSelect: { _ in })
                .padding(12).frame(width: width).background(palette.ground)
                .environment(\.chatPalette, palette).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: content); renderer.scale = 2
            let image = try #require(renderer.uiImage)
            #expect(image.size.width == width)
            #expect(image.size.height < 300)
            let path = folder.appendingPathComponent(name + ".png")
            try #require(image.pngData()).write(to: path)
            print("SLASH_SNAPSHOT: \(path.path)")
        }
    }
}
