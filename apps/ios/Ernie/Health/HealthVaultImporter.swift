import Foundation
import UIKit

/// OCR sul dispositivo. Nessuna coda Media e nessuna copia temporanea del documento.
enum HealthVaultImporter {
    static func file(_ url: URL, progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in }) async throws -> HealthVaultDraft {
        let granted = url.startAccessingSecurityScopedResource()
        defer { if granted { url.stopAccessingSecurityScopedResource() } }
        let ext = url.pathExtension.lowercased()
        if ["txt", "md"].contains(ext) {
            let doc = try DocumentReader.read(text: url)
            let draft = HealthVaultDraft(title: String((doc.title ?? "Testo personale").prefix(160)), source: .text, pages: doc.pages, attachments: [])
            try draft.validate(); return draft
        }
        guard ext == "pdf", let bytes = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              bytes <= HealthVaultDraft.maxPDFBytes else { throw HealthVaultError.invalidImport }
        let data = try Data(contentsOf: url)
        let doc = try await DocumentReader.read(pdf: url, progress: progress)
        let draft = HealthVaultDraft(title: String((doc.title ?? "Referto").prefix(160)), source: .pdf, pages: doc.pages,
            attachments: [.init(id: UUID().uuidString, name: url.lastPathComponent, mimeType: "application/pdf", dataBase64: data.base64EncodedString())])
        try draft.validate(); return draft
    }
    @MainActor static func images(_ images: [UIImage], source: HealthSourceKind,
                                 progress: @escaping @Sendable (Int, Int) -> Void = { _, _ in }) async throws -> HealthVaultDraft {
        guard !images.isEmpty, images.count <= 10 else { throw HealthVaultError.invalidImport }
        var data: [Data] = []
        for image in images {
            try Task.checkCancellation()
            let jpeg = try await MediaPresentation.prepare(MediaImportPhoto(image: image))
            guard jpeg.count <= HealthVaultDraft.maxImageBytes else { throw HealthVaultError.invalidImport }
            data.append(jpeg)
        }
        let doc = try await DocumentReader.read(jpegs: data, source: source.rawValue, progress: progress)
        return try draft(document: doc, images: data)
    }
    static func draft(document: ImportedDocument, images: [Data] = [], pdf: URL? = nil) throws -> HealthVaultDraft {
        var attachments = images.enumerated().map { index, data in
            HealthAttachment(id: UUID().uuidString, name: "Pagina \(index + 1).jpg", mimeType: "image/jpeg", dataBase64: data.base64EncodedString())
        }
        if let pdf {
            let granted = pdf.startAccessingSecurityScopedResource()
            defer { if granted { pdf.stopAccessingSecurityScopedResource() } }
            guard let bytes = try? pdf.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  bytes <= HealthVaultDraft.maxPDFBytes else { throw HealthVaultError.invalidImport }
            attachments.append(.init(id: UUID().uuidString, name: pdf.lastPathComponent, mimeType: "application/pdf", dataBase64: try Data(contentsOf: pdf).base64EncodedString()))
        }
        let draft = HealthVaultDraft(title: String((document.title ?? "Documento Salute").prefix(160)), source: HealthSourceKind(rawValue: document.source) ?? .text,
                                     pages: document.pages, attachments: attachments)
        try draft.validate(); return draft
    }
}

/// Difesa aggiuntiva per allegati inviati dalla chat. L'importazione Salute esplicita
/// è il percorso principale: il riconoscimento del testo non garantisce ogni caso.
enum HealthImportGuard {
    static func recognizes(_ document: ImportedDocument) -> Bool {
        let text = ((document.title ?? "") + "\n" + document.pages.joined(separator: "\n")).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "it_IT"))
        if ["referto", "analisi cliniche", "emocromo", "diagnosi", "prescrizione medica", "anamnesi", "esame emato", "laboratorio analisi"].contains(where: text.contains) { return true }
        let analytes = ["glicemia", "colesterolo", "creatinina", "emoglobina", "trigliceridi", "leucociti", "piastrine"]
        return analytes.filter(text.contains).count >= 2 || (text.contains("paziente") && ["mg/dl", "mmol/l", "valori di riferimento", "intervallo di riferimento"].contains(where: text.contains))
    }
}
