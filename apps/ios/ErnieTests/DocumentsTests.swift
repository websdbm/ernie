import Foundation
import PDFKit
import Testing
import UIKit
@testable import Ernie

struct DocumentsTests {
    @Test func decodificaBlocchiDocumentoESchema() throws {
        let json = """
        [
          {"kind":"document","documentId":"d1","title":"Fotosintesi","pages":2,"source":"scan","abstract":"Le piante…","keyPoints":["Cloroplasti"],"questions":[{"question":"Dove?","answer":"Nei cloroplasti."}]},
          {"kind":"schema","documentId":"d1","title":"Fotosintesi","diagram":{"type":"mindmap","root":{"label":"Fotosintesi","children":[{"label":"Fase luminosa","children":[{"label":"Fotolisi"}]}]}}},
          {"kind":"schema","documentId":"d1","title":"Procedura","diagram":{"type":"flow","steps":[{"id":"a","label":"Luce"},{"id":"b","label":"Zuccheri"}],"links":[{"from":"a","to":"b","label":"poi"}]}},
          {"kind":"schema","documentId":"d1","title":"Storia","diagram":{"type":"timeline","events":[{"when":"1779","label":"Ingenhousz"},{"when":"1950","label":"Calvin"}]}},
          {"kind":"boh","x":1}
        ]
        """
        let blocks = try JSONDecoder().decode([ContentBlock].self, from: Data(json.utf8))
        #expect(blocks.count == 5)
        guard case .document(let doc) = blocks[0] else { Issue.record("atteso document"); return }
        #expect(doc.questions?.first?.answer == "Nei cloroplasti.")
        guard case .schema(let mind) = blocks[1], case .mindmap(let root) = mind.diagram else { Issue.record("attesa mappa"); return }
        #expect(root.children?.first?.children?.first?.label == "Fotolisi")
        guard case .schema(let flow) = blocks[2], case .flow(let steps, let links) = flow.diagram else { Issue.record("atteso flusso"); return }
        #expect(steps.count == 2 && links.first?.label == "poi")
        guard case .schema(let tl) = blocks[3], case .timeline(let events) = tl.diagram else { Issue.record("attesa linea del tempo"); return }
        #expect(events.last?.when == "1950")
        #expect(blocks[4] == .unknown(kind: "boh"))
        // Andata e ritorno: la trascrizione salvata rilegge gli stessi blocchi.
        let again = try JSONDecoder().decode([ContentBlock].self, from: JSONEncoder().encode(blocks))
        #expect(again == blocks)
    }

    @Test func messaggioUtenteConAllegato() throws {
        let payload = UserMessagePayload(text: "riassumi", inputMode: "text", locale: "it-IT", attachments: [DocumentAttachment(id: "d1")])
        let json = String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)
        #expect(json.contains("\"kind\":\"document\"") && json.contains("\"id\":\"d1\""))
        let senza = UserMessagePayload(text: "ciao", inputMode: "text", locale: nil)
        #expect(!String(decoding: try JSONEncoder().encode(senza), as: UTF8.self).contains("attachments"))
    }

    @Test func testoSemplicePaginatoPerParagrafi() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-\(UUID().uuidString).txt")
        let paragraphs = (1...7).map { "Paragrafo \($0) del testo di prova." }
        try paragraphs.joined(separator: "\n\n").write(to: url, atomically: true, encoding: .utf8)
        let doc = try DocumentReader.read(text: url)
        #expect(doc.pages.count == 3)
        #expect(doc.pages[0].contains("Paragrafo 1") && doc.pages[2].contains("Paragrafo 7"))
    }

    @Test func pdfConTestoLettoSenzaOCR() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-\(UUID().uuidString).pdf")
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 400, height: 500))
        try renderer.writePDF(to: url) { ctx in
            for page in 1...2 {
                ctx.beginPage()
                let text = "Pagina \(page): la fotosintesi clorofilliana avviene nei cloroplasti delle cellule vegetali."
                text.draw(in: CGRect(x: 20, y: 20, width: 360, height: 400), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
            }
        }
        let doc = try await DocumentReader.read(pdf: url) { _, _ in }
        #expect(doc.source == "pdf")
        #expect(doc.pages.count == 2)
        #expect(doc.pages[1].contains("Pagina 2"))
        #expect(doc.chars > 100)
    }
}

struct DocumentOCRTests {
    /// Immagine con testo stampato, come una foto nitida di una pagina.
    static func pageImage(_ lines: [String], size: CGSize = CGSize(width: 1200, height: 800)) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let style = NSMutableParagraphStyle()
            style.lineSpacing = 14
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 40, weight: .regular),
                .foregroundColor: UIColor.black,
                .paragraphStyle: style,
            ]
            lines.joined(separator: "\n").draw(in: CGRect(x: 60, y: 60, width: size.width - 120, height: size.height - 120), withAttributes: attrs)
        }
    }

    @Test func ocrSuImmagineDiTestoStampato() async throws {
        let image = Self.pageImage([
            "La fotosintesi clorofilliana",
            "Le piante trasformano la luce in energia chimica.",
            "Avviene nei cloroplasti grazie alla clorofilla.",
        ])
        let doc = try await DocumentReader.read(images: [image], source: "photo") { _, _ in }
        #expect(doc.pages.count == 1)
        let text = doc.pages[0].lowercased()
        #expect(text.contains("fotosintesi"))
        #expect(text.contains("cloroplasti"))
    }

    @Test func pdfScansionatoPassaDallOCR() async throws {
        // Una pagina PDF che contiene solo un'immagine (nessun testo nativo): deve essere letta con l'OCR.
        let image = Self.pageImage(["Rivoluzione francese", "Presa della Bastiglia, 14 luglio 1789."])
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-scan-\(UUID().uuidString).pdf")
        let bounds = CGRect(x: 0, y: 0, width: 600, height: 400)
        try UIGraphicsPDFRenderer(bounds: bounds).writePDF(to: url) { ctx in
            ctx.beginPage()
            image.draw(in: bounds)
        }
        let doc = try await DocumentReader.read(pdf: url) { _, _ in }
        #expect(doc.pages.count == 1)
        #expect(doc.pages[0].lowercased().contains("bastiglia"))
    }
}
