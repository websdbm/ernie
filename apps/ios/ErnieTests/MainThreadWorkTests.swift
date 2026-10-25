import Foundation
import ImageIO
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import Ernie

/// Lavoro tolto dal main thread contro i blocchi da watchdog (0x8BADF00D, build 97–98) e copie dei widget legate
/// all'account.
struct TranscriptIndexTests {
    private func user(_ text: String) -> ChatItem {
        .message(ChatMessage(id: UUID().uuidString, correlationId: "c", role: .user, text: text, createdAt: .now))
    }

    @Test func storicoDalPiccoloIndiceERicostruitoPerLeCronologieVecchie() async throws {
        let name = "transcript-index-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let store = TranscriptStore(directory: directory, defaults: defaults)
        let index = directory.appendingPathComponent("a.summary")
        store.save(.init(sessionId: "a", lastSeq: 1, items: [user("prima domanda\nsu due righe")], updatedAt: Date(timeIntervalSince1970: 1_000)))
        store.save(.init(sessionId: "vuota", lastSeq: 0, items: [], updatedAt: .now))
        #expect(FileManager.default.fileExists(atPath: index.path))
        let listed = await store.listInBackground()
        #expect(listed.map(\.id) == ["a"])
        #expect(listed.first?.title == "Prima domanda su due righe")
        #expect(listed.first?.updatedAt == Date(timeIntervalSince1970: 1_000))
        // Cronologia salvata da una versione senza indice: si legge una volta e l'indice si crea.
        try FileManager.default.removeItem(at: index)
        #expect(store.list().map(\.title) == ["Prima domanda su due righe"])
        #expect(FileManager.default.fileExists(atPath: index.path))
        // Indice più vecchio della conversazione (riscritta senza indice): vale la conversazione.
        let newer = TranscriptStore.SessionFile(sessionId: "a", lastSeq: 2, items: [user("domanda cambiata")], updatedAt: .now)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -60)], ofItemAtPath: index.path)
        try encoder.encode(newer).write(to: directory.appendingPathComponent("a.json"))
        #expect(store.list().map(\.title) == ["Domanda cambiata"])
        store.delete("a")
        #expect(!FileManager.default.fileExists(atPath: index.path))
        #expect(store.list().isEmpty)
    }
}

struct MediaPreparationTests {
    private func encoded(width: Int, height: Int, type: UTType, orientation: Int? = nil, alpha: Bool = false) throws -> Data {
        let format = UIGraphicsImageRendererFormat.default(); format.scale = 1; format.opaque = !alpha
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { ctx in
            UIColor.systemBlue.setFill()
            ctx.fill(CGRect(x: width / 4, y: height / 4, width: width / 2, height: height / 2))
        }
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil))
        var properties: [String: Any] = [kCGImagePropertyGPSDictionary as String: [kCGImagePropertyGPSLatitude as String: 45.5, kCGImagePropertyGPSLatitudeRef as String: "N",
                                                                                   kCGImagePropertyGPSLongitude as String: 12.25, kCGImagePropertyGPSLongitudeRef as String: "E"]]
        if let orientation { properties[kCGImagePropertyOrientation as String] = orientation }
        CGImageDestinationAddImage(destination, try #require(image.cgImage), properties as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }
    private func pixel(_ image: CGImage, x: Int, y: Int) throws -> (UInt8, UInt8, UInt8) {
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = try #require(CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return (bytes[0], bytes[1], bytes[2])
    }

    @Test func fotoDaFileRidottaConOrientamentoSenzaGPSESfondoBianco() async throws {
        // 3000×1500 ruotata di 90° nei metadati: il JPEG pronto è verticale, al massimo 2400 di lato, senza GPS.
        let photo = try MediaImportPhoto(data: try encoded(width: 3000, height: 1500, type: .jpeg, orientation: 6))
        #expect(photo.location != nil)
        let jpeg = try await MediaPresentation.prepare(photo)
        let image = try #require(CGImageSourceCreateWithData(jpeg as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        #expect(image.width == 1200 && image.height == 2400)
        #expect(MediaLocation.read(jpeg) == nil)
        #expect(jpeg.count <= 3_000_000)
        // PNG trasparente: gli angoli diventano bianchi, non neri.
        let png = try await MediaPresentation.prepare(try MediaImportPhoto(data: try encoded(width: 800, height: 600, type: .png, alpha: true)))
        let flat = try #require(CGImageSourceCreateWithData(png as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        #expect(flat.width == 800 && flat.height == 600)
        let corner = try pixel(flat, x: 2, y: 2)
        #expect(corner.0 > 240 && corner.1 > 240 && corner.2 > 240)
    }

    @Test func fileNonImmagineScartatoSubito() {
        #expect(throws: DocumentReader.ReadError.self) { try MediaImportPhoto(data: Data("non è una foto".utf8)) }
        #expect(throws: DocumentReader.ReadError.self) { try MediaPresentation.prepare(data: Data()) }
    }
}

struct WidgetSummaryCacheTests {
    private let alice = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "alice-test-only")
    private let bob = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "bob-test-only")

    @Test func copiaSoloPerLAccountCollegato() throws {
        let summary = Data(#"{"generatedAt":"2026-10-25T10:00:00Z"}"#.utf8)
        let wrapped = try #require(WidgetSummaryCache.wrap(summary, for: alice))
        #expect(!wrapped.contains(Data("alice-test-only".utf8)))
        #expect(WidgetSummaryCache.unwrap(wrapped, for: alice) == summary)
        #expect(WidgetSummaryCache.unwrap(wrapped, for: bob) == nil)
        #expect(WidgetSummaryCache.unwrap(wrapped, for: nil) == nil)
        // Copia di una versione precedente, senza account: non vale.
        #expect(WidgetSummaryCache.unwrap(summary, for: alice) == nil)
    }

    @Test func rispostaArrivataDopoLUscitaNonRiscriveIlFile() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("widget-summary-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let summary = Data(#"{"generatedAt":"2026-10-25T10:00:00Z"}"#.utf8)
        // Uscita prima della scrittura.
        #expect(!WidgetSummaryCache.store(summary, fetchedWith: alice, current: { nil }, to: url))
        #expect(!FileManager.default.fileExists(atPath: url.path))
        // Uscita (o cambio di account) durante la scrittura: il file si toglie.
        var calls = 0
        #expect(!WidgetSummaryCache.store(summary, fetchedWith: alice, current: { calls += 1; return calls == 1 ? alice : bob }, to: url))
        #expect(!FileManager.default.fileExists(atPath: url.path))
        #expect(WidgetSummaryCache.store(summary, fetchedWith: alice, current: { alice }, to: url))
        #expect(WidgetSummaryCache.unwrap(try Data(contentsOf: url), for: alice) == summary)
    }
}
