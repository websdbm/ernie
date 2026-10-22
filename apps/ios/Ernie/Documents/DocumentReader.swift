import CoreGraphics
import Foundation
import PDFKit
import UIKit
import Vision

/// Testo letto sul telefono. Le nuove foto sono conservate separatamente nella raccolta Media; i PDF restano solo testo.
struct ImportedDocument: Sendable, Equatable {
    var title: String?
    var source: String   // scan | photo | pdf
    var pages: [String]
    var chars: Int { pages.reduce(0) { $0 + $1.count } }
}

/// Lettura del testo con gli strumenti integrati di iOS: PDFKit per i PDF con testo, Vision (OCR, italiano) per
/// foto, scansioni e PDF scansionati. Deterministico, offline, nessun costo.
enum DocumentReader {
    enum ReadError: LocalizedError {
        case unreadable, empty, tooManyPages(Int)
        var errorDescription: String? {
            switch self {
            case .unreadable: "non riesco ad aprire il file"
            case .empty: "non ho trovato testo leggibile"
            case .tooManyPages(let n): "troppe pagine (\(n)): massimo 300"
            }
        }
    }

    static let maxPages = 300
    static let languages: [Locale.Language] = [Locale.Language(identifier: "it-IT"), Locale.Language(identifier: "en-US")]

    /// PDF: testo nativo se presente, altrimenti OCR pagina per pagina (resa a ~150 dpi).
    static func read(pdf url: URL, progress: @escaping @Sendable (Int, Int) -> Void) async throws -> ImportedDocument {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let pdf = PDFDocument(url: url) else { throw ReadError.unreadable }
        let count = pdf.pageCount
        guard count > 0 else { throw ReadError.empty }
        guard count <= maxPages else { throw ReadError.tooManyPages(count) }
        var pages: [String] = []
        for i in 0..<count {
            try Task.checkCancellation()
            progress(i + 1, count)
            guard let page = pdf.page(at: i) else { pages.append(""); continue }
            let native = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if native.count >= 20 {
                pages.append(native)
            } else if let image = render(page: page) {
                pages.append(try await recognize(image))
            } else {
                pages.append("")
            }
        }
        guard pages.contains(where: { !$0.isEmpty }) else { throw ReadError.empty }
        let title = pdf.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String
        return ImportedDocument(title: title?.isEmpty == false ? title : nil, source: "pdf", pages: pages)
    }

    /// Foto o scansioni: una pagina per immagine.
    static func read(images: [UIImage], source: String, progress: @escaping @Sendable (Int, Int) -> Void) async throws -> ImportedDocument {
        guard !images.isEmpty else { throw ReadError.empty }
        guard images.count <= maxPages else { throw ReadError.tooManyPages(images.count) }
        var pages: [String] = []
        for (i, image) in images.enumerated() {
            try Task.checkCancellation()
            progress(i + 1, images.count)
            guard let cg = image.cgImage else { pages.append(""); continue }
            pages.append(try await recognize(cg, orientation: cgOrientation(image.imageOrientation)))
        }
        guard pages.contains(where: { !$0.isEmpty }) else { throw ReadError.empty }
        return ImportedDocument(title: nil, source: source, pages: pages)
    }

    /// Testo semplice (.txt, .md): pagine separate da righe vuote doppie; utile nel simulatore.
    static func read(text url: URL) throws -> ImportedDocument {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let raw = try String(contentsOf: url, encoding: .utf8)
        let paragraphs = raw.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard !paragraphs.isEmpty else { throw ReadError.empty }
        var pages: [String] = []
        var i = 0
        while i < paragraphs.count { pages.append(paragraphs[i..<min(i + 3, paragraphs.count)].joined(separator: "\n\n")); i += 3 }
        guard pages.count <= maxPages else { throw ReadError.tooManyPages(pages.count) }
        return ImportedDocument(title: nil, source: "pdf", pages: pages)
    }

    // MARK: - privato

    /// Vision (iOS 26): riconoscimento del documento con struttura; ripiego sul riconoscimento del testo.
    static func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation = .up) async throws -> String {
        try Task.checkCancellation()
        var documents = RecognizeDocumentsRequest()
        documents.textRecognitionOptions.recognitionLanguages = languages
        if let observation = try await documents.perform(on: image, orientation: orientation).first {
            let transcript = observation.document.text.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            if !transcript.isEmpty { return transcript }
        }
        try Task.checkCancellation()
        var text = RecognizeTextRequest()
        text.recognitionLevel = .accurate
        text.recognitionLanguages = languages
        let lines = try await text.perform(on: image, orientation: orientation)
        return lines.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    static func render(page: PDFPage, dpi: CGFloat = 150) -> CGImage? {
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0, dpi.isFinite, dpi > 0 else { return nil }
        let scale = min(dpi / 72, 2400 / max(bounds.width, bounds.height))
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        guard size.width > 0, size.height > 0 else { return nil }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let image = renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            ctx.cgContext.translateBy(x: 0, y: size.height)
            ctx.cgContext.scaleBy(x: scale, y: -scale)
            page.draw(with: .mediaBox, to: ctx.cgContext)
        }
        return image.cgImage
    }

    static func cgOrientation(_ o: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch o {
        case .up: .up
        case .down: .down
        case .left: .left
        case .right: .right
        case .upMirrored: .upMirrored
        case .downMirrored: .downMirrored
        case .leftMirrored: .leftMirrored
        case .rightMirrored: .rightMirrored
        @unknown default: .up
        }
    }
}
