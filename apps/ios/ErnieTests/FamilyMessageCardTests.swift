import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

@MainActor struct FamilyMessageCardTests {
    private func message(incoming: Bool = false, urgent: Bool = true, acknowledged: Bool = false,
                         text: String = "Ricordati del messaggio per il laboratorio.") -> FamilyMessageBlock {
        .init(id: "preview", direction: incoming ? "in" : "out", otherUserId: "relative", label: "Familiare",
              text: text, image: nil, replyTo: nil, at: "2026-10-27T15:24:00Z", urgent: urgent,
              acknowledgedAt: acknowledged ? "2026-10-27T15:30:00Z" : nil)
    }

    @Test func gliStatiDistinguonoInvioDaConfermaSenzaPresumereLaConsegna() {
        #expect(FamilyMessageReceipt(message()) == .awaitingConfirmation)
        #expect(FamilyMessageReceipt(message(incoming: true)) == .needsConfirmation)
        #expect(FamilyMessageReceipt(message(urgent: false)) == .sent)
        #expect(FamilyMessageReceipt(message(incoming: true, urgent: false)) == .received)
        #expect(FamilyMessageReceipt(message(acknowledged: true)) == .confirmed("2026-10-27T15:30:00Z"))
        #expect(FamilyMessageReceipt(message(urgent: false, acknowledged: true)) == .sent)
    }

    private func render(_ message: FamilyMessageBlock, width: CGFloat = 390, costume: BearCostume = .borg,
                        scheme: ColorScheme = .dark, size: DynamicTypeSize = .large) throws -> UIImage {
        let palette = ChatPalette(costume: costume)
        let content = FamilyMessageCard(message: message)
            .padding(16).frame(width: width).background(palette.ground)
            .environment(\.chatPalette, palette)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        return try #require(renderer.uiImage)
    }

    @Test func testoEDestinatarioNonVengonoTagliatiSuSchermiPiccoli() throws {
        let short = try render(message(), width: 320)
        var long = message(text: String(repeating: "Questo messaggio contiene tutti i dettagli da leggere. ", count: 12))
        long.label = "Un nome familiare particolarmente lungo"
        let full = try render(long, width: 320)
        #expect(short.size.width == 320)
        #expect(full.size.width == 320)
        #expect(full.size.height > short.size.height + 300)
        let accessible = try render(long, width: 320, size: .accessibility3)
        #expect(accessible.size.width == 320)
        #expect(accessible.size.height > full.size.height)
    }

    @Test func fotoPanoramicheEVerticaliRestanoEntroLaScheda() throws {
        for dimensions in [(40, 1600), (1600, 40)] {
            var value = message(text: "Una foto")
            value.image = .init(width: dimensions.0, height: dimensions.1)
            let image = try render(value, width: 320)
            #expect(image.size.width == 320)
            #expect(image.size.height < 520)
        }
    }

    @Test func anteprimeStatiTemiEDimensioni() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-family-cards-109")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let cases: [(String, FamilyMessageBlock, CGFloat, BearCostume, ColorScheme, DynamicTypeSize)] = [
            ("borg-pending", message(), 390, .borg, .dark, .large),
            ("light-pending", message(), 390, .base, .light, .large),
            ("dark-confirmed", message(acknowledged: true), 390, .base, .dark, .large),
            ("light-confirmed", message(acknowledged: true), 390, .base, .light, .large),
            ("incoming-pending", message(incoming: true), 390, .borg, .dark, .large),
            ("incoming-accessible", message(incoming: true), 320, .base, .light, .accessibility3),
            ("normal-outgoing", message(urgent: false), 390, .jedi, .light, .large),
            ("normal-incoming", message(incoming: true, urgent: false), 390, .base, .dark, .large),
            ("narrow-large", message(), 320, .borg, .dark, .xxxLarge),
        ]
        for (name, value, width, costume, scheme, size) in cases {
            let image = try render(value, width: width, costume: costume, scheme: scheme, size: size)
            #expect(image.size.width == width)
            if name == "borg-pending" { #expect(image.size.height < 260) }
            let path = folder.appendingPathComponent(name + ".png")
            try #require(image.pngData()).write(to: path)
            print("FAMILY_CARD_SNAPSHOT: \(path.path) height=\(image.size.height)")
        }
    }
}
