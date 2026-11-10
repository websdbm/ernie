import Foundation
import SwiftUI
import Testing
import UIKit
import Vision
@testable import Ernie

@MainActor struct HealthCardTests {
    private func render(_ block: HealthBlock, name: String, width: CGFloat = 375,
                        scheme: ColorScheme = .light, size: DynamicTypeSize = .large) throws -> UIImage {
        let renderer = ImageRenderer(content: HealthCard(block: block)
            .padding(16).frame(width: width)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size))
        renderer.scale = 2
        let image = try #require(renderer.uiImage)
        #expect(image.size.width == width)
        #expect(image.size.height > 150)
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-health-\(name).png")
        try #require(image.pngData()).write(to: path)
        print("HEALTH_CARD_SNAPSHOT: \(path.path)")
        return image
    }

    /// Verifica il testo realmente rasterizzato: un modello corretto non basta se la UI lo tronca.
    private func readableText(_ image: UIImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["it-IT", "en-US"]
        request.usesLanguageCorrection = false
        request.minimumTextHeight = 0.005
        try VNImageRequestHandler(cgImage: #require(image.cgImage), options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: " ").lowercased()
    }

    @Test func refertoSenzaDataRestituisceValoriConsultabiliSenzaDataInventata() throws {
        let data = Data(#"{"mode":"parameter","title":"Glicemia","rows":[{"label":"Glicemia","value":92,"unit":"mg/dL","flag":"n/d"}],"summary":"Data e intervallo di riferimento non disponibili."}"#.utf8)
        let block = try JSONDecoder().decode(HealthBlock.self, from: data)
        #expect(block.rows.first?.date == nil)
        #expect(HealthFormat.day(block.rows.first?.date) == nil)
        #expect(block.rows.first?.flag == "n/d")
        for (name, scheme, size): (String, ColorScheme, DynamicTypeSize) in [
            ("light", .light, .large), ("dark", .dark, .large), ("large", .light, .accessibility3)
        ] {
            let image = try render(block, name: "undated-\(name)", scheme: scheme, size: size)
            let text = try readableText(image)
            #expect(text.contains("data non disponibile"))
            #expect(text.replacingOccurrences(of: " ", with: "").contains("92mg/dl"))
            #expect(text.components(separatedBy: "glicemia").count == 2)
            #expect(!text.contains("…"))
        }
    }

    @Test func refertoAccessibileConNomiUnitaERiferimentiLunghiRimaneCompleto() throws {
        let data = Data(#"{"mode":"report","title":"Referto di prova","rows":[{"label":"Valutazione del metabolismo e del controllo nel periodo precedente","value":92,"unit":"milligrammi per decilitro","refText":"Intervallo indicato dal laboratorio: da 70 a 100 milligrammi per decilitro","flag":"n/d","previous":{"value":88,"date":"2026-10-10"},"trend":"su"},{"label":"Ricerca anticorpi nel campione analizzato","valueText":"Non rilevati nel campione analizzato","flag":"n/d"}]}"#.utf8)
        let block = try JSONDecoder().decode(HealthBlock.self, from: data)
        for (name, scheme, width): (String, ColorScheme, CGFloat) in [
            ("report-large", .light, 375), ("report-large-dark", .dark, 320)
        ] {
            let image = try render(block, name: name, width: width, scheme: scheme, size: .accessibility3)
            let text = try readableText(image)
            #expect(text.contains("valutazione del metabolismo"))
            #expect(text.contains("periodo precedente"))
            #expect(text.contains("milligrammi per decilitro"))
            #expect(text.contains("valore precedente"))
            #expect(text.contains("data precedente"))
            #expect(text.contains("88"))
            #expect(text.contains("2026"))
            #expect(text.contains("in aumento"))
            #expect(text.contains("non rilevati nel campione analizzato"))
            #expect(!text.contains("…"))
        }
    }
}
