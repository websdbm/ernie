import Foundation
import ImageIO
import SwiftUI
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import Ernie

@MainActor struct BrainResourcesTests {
    let id = "0A000000-0000-4000-8000-000000000001"
    private func note(type: String = "ricetta", resource: BrainResource? = nil) -> BrainNoteDetail {
        BrainNoteDetail(path: "Ricette/0a000000-0000-4000-8000-000000000001.md", title: "Torta di mele", type: type,
                        created: "2026-10-18", links: [], private: false, body: "Ingredienti: mele, farina e latte.", resource: resource)
    }
    @Test func percorsiCanoniciOmonimiERoutingLegacy() throws {
        let resource = BrainResource(kind: .recipe, id: id)
        #expect(resource.path == "Ricette/0a000000-0000-4000-8000-000000000001.md")
        #expect(BrainResource(kind: .media, id: id).path == "Immagini/0a000000-0000-4000-8000-000000000001.md")
        #expect(BrainResource(kind: .media, id: "../non-valido").path == nil)
        let first = BrainDestination.path("Persone/Anna + Ada.md")
        let second = BrainDestination.path("Progetti/Anna + Ada.md")
        #expect(first != second)
        #expect(first.requestPath.contains("path="))
        #expect(first.requestPath.contains("%2B"))
        #expect(!first.requestPath.contains("title="))
        #expect(BrainDestination(url: try #require(BrainLocation.noteURL(path: "Persone/Anna + Ada.md"))) == first)
        #expect(BrainDestination(url: URL(string: "ernie-brain://note?title=Anna")!) == .title("Anna"))
    }
    @Test func risorseNonEditabiliConOSenzaMetadatiENoteLegacyCompatibili() throws {
        for type in ["ricetta", "immagine"] { #expect(!note(type: type).isEditable) }
        #expect(!note(type: "nota", resource: .init(kind: .recipe, id: id)).isEditable)
        #expect(note(type: "nota").isEditable)
        let plain = try JSONSerialization.jsonObject(with: JSONEncoder().encode(note())) as! [String: Any]
        let old = try JSONDecoder().decode(BrainNoteResponse.self, from: JSONSerialization.data(withJSONObject: ["note": plain, "backlinks": ["Anna"]]))
        #expect(old.related == nil && old.note.resourceLinks == nil && old.note.resource == nil)
        var complete = plain
        complete["resource"] = ["kind": "recipe", "id": id]
        complete["resourceLinks"] = ["Persone/Anna.md"]
        let response = try JSONDecoder().decode(BrainNoteResponse.self, from: JSONSerialization.data(withJSONObject: ["note": complete, "backlinks": [], "related": [["path": "Immagini/\(id.lowercased()).md", "title": "Pranzo", "type": "immagine", "resource": ["kind": "media", "id": id], "coords": [45.1, 12.2]]]]))
        #expect(response.note.resource?.kind == .recipe)
        #expect(response.note.resourceLinks == ["Persone/Anna.md"])
        #expect(response.related?.first?.resource?.kind == .media)
        #expect(response.related?.first?.coords == [45.1, 12.2])
    }
    @Test func associazioniSoloNoteConsentitePubbliche() {
        var summary = BrainNoteSummary(path: "Persone/Anna.md", title: "Anna", type: "persona", created: "2026-10-18", links: [], private: false, excerpt: "")
        for type in ["persona", "luogo", "argomento", "progetto"] {
            summary.type = type; #expect(BrainResourceLinkPolicy.selectable(summary))
        }
        summary.private = true; #expect(!BrainResourceLinkPolicy.selectable(summary))
        summary.private = false
        for type in ["nota", "documento", "ricetta", "immagine", "salute", "chi-sono"] {
            summary.type = type; #expect(!BrainResourceLinkPolicy.selectable(summary))
        }
    }
    @Test func APISalvaSoloCollegamentiManualiELimitaLaSelezione() async throws {
        let credentials = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "test")
        let api = ApiClient(credentials: credentials, transport: { request in
            #expect(request.httpMethod == "PATCH")
            #expect(request.url?.path == "/v1/brain/resources/recipe/0a000000-0000-4000-8000-000000000001/links")
            struct Body: Decodable { var paths: [String] }
            let body = try JSONDecoder().decode(Body.self, from: try #require(request.httpBody))
            #expect(body.paths == ["Persone/Anna.md"])
            return (Data(#"{"paths":["Persone/Anna.md"]}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        #expect(try await api.setBrainResourceLinks(.init(kind: .recipe, id: id), paths: ["Persone/Anna.md"]) == ["Persone/Anna.md"])
        do {
            _ = try await api.setBrainResourceLinks(.init(kind: .recipe, id: id), paths: (1...21).map { "Persone/\($0).md" })
            Issue.record("21 collegamenti devono essere rifiutati prima della rete")
        } catch { #expect((error as? ApiError)?.code == "invalid_links") }
    }

    @Test func fotografieEAzioniRisorsaLeggibili() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 70))
        let photo = renderer.image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 70))
            UIColor.systemYellow.setFill(); context.fill(CGRect(x: 20, y: 14, width: 55, height: 42))
        }
        let related = [BrainRelatedNote(path: "Immagini/\(id.lowercased()).md", title: "Pranzo in giardino", type: "immagine", resource: .init(kind: .media, id: id))]
        for (name, width, size, scheme): (String, CGFloat, DynamicTypeSize, ColorScheme) in [("light", 390, .large, .light), ("dark", 390, .large, .dark), ("small", 320, .xxxLarge, .light)] {
            let view = VStack(alignment: .leading, spacing: 20) {
                BrainNoteContent(note: note(resource: .init(kind: .recipe, id: id)))
                BrainResourceActions(resource: .init(kind: .recipe, id: id), type: "ricetta", open: { _ in }, link: {})
                BrainRelatedNotes(notes: related, previews: [id.lowercased(): photo]) { _ in }
            }.padding(20).frame(width: width).background(Theme.surface)
                .environment(AppModel()).environment(\.dynamicTypeSize, size).environment(\.colorScheme, scheme)
            let render = ImageRenderer(content: view); render.scale = 2
            let png = try #require(render.uiImage?.pngData())
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-brain-resources-\(name).png")
            try png.write(to: url); print("BRAIN_RESOURCES_SNAPSHOT: \(url.path)")
        }
    }
}

@MainActor struct MediaLocationTests {
    @Test func immagineMostraLuogoAssociatoOPosizioneDelloScatto() {
        var note = BrainNoteDetail(path: "Immagini/foto.md", title: "Pranzo", type: "immagine", created: "2026-10-18", place: "Casa sul lago", coords: [45, 12], links: [], private: false, body: "")
        #expect(note.visiblePlaces.first?.title == "Casa sul lago")
        note.place = nil
        #expect(note.visiblePlaces.first?.title == "Posizione dello scatto")
        note.place = "  \n "
        #expect(note.visiblePlaces.first?.title == "Posizione dello scatto")
        note.type = "persona"
        #expect(note.visiblePlaces.first?.title == "Posizione citata")
        note.type = "luogo"
        #expect(note.visiblePlaces.first?.title == "Pranzo")
    }

    @Test func EXIFImprecisoScartaSoloLaPosizione() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        let gps: [String: Any] = [kCGImagePropertyGPSLatitude as String: 45.5, kCGImagePropertyGPSLatitudeRef as String: "N", kCGImagePropertyGPSLongitude as String: 12.25, kCGImagePropertyGPSLongitudeRef as String: "E", "HPositioningError": 200]
        CGImageDestinationAddImage(destination, try #require(image.cgImage), [kCGImagePropertyGPSDictionary as String: gps] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let imported = try MediaImportPhoto(data: data as Data)
        #expect(imported.location == nil)
        #expect(!(try await MediaPresentation.prepare(imported)).isEmpty)
        #expect(MediaLocation(lat: 45.5, lon: 12.25, accuracy: 100).isValid)
        #expect(!MediaLocation(lat: 45.5, lon: 12.25, accuracy: 100.01).isValid)
    }

    @Test func EXIFOriginaleLettoPrimaDelJPEGESenzaPosizioneInventata() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        let gps: [String: Any] = [kCGImagePropertyGPSLatitude as String: 45.5, kCGImagePropertyGPSLatitudeRef as String: "S", kCGImagePropertyGPSLongitude as String: 12.25, kCGImagePropertyGPSLongitudeRef as String: "W", kCGImagePropertyGPSDateStamp as String: "2020:03:02", kCGImagePropertyGPSTimeStamp as String: "10:15:30"]
        CGImageDestinationAddImage(destination, try #require(image.cgImage), [kCGImagePropertyGPSDictionary as String: gps] as CFDictionary)
        #expect(CGImageDestinationFinalize(destination))
        let imported = try MediaImportPhoto(data: data as Data)
        #expect(imported.location?.lat == -45.5 && imported.location?.lon == -12.25)
        #expect(imported.location?.capturedAt == "2020-03-02T10:15:30Z")
        let jpeg = try await MediaPresentation.prepare(imported)
        #expect(MediaLocation.read(jpeg) == nil)
        #expect(imported.location?.lat == -45.5)
        #expect(MediaLocation.read(properties: [:]) == nil)
        #expect(!MediaLocation(lat: 91, lon: 12).isValid)
        #expect(!MediaLocation(lat: 45, lon: .infinity).isValid)
    }
    @Test func routeMediaMockConservaGPSERispostaVecchiaRestaCompatibile() async throws {
        let location = MediaLocation(lat: 45.5, lon: 12.25, capturedAt: "2020-03-02T10:15:30Z")
        let media = SavedMedia(id: UUID().uuidString, title: "Giardino", description: "", category: "Foto", tags: [], width: 40, height: 30, source: "photo", organization: "manual", version: 1, createdAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:00:00Z", location: location)
        struct Response: Encodable { var item: SavedMedia }
        let response = try JSONEncoder().encode(Response(item: media))
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "test"), transport: { request in
            struct Body: Decodable { var location: MediaLocation? }
            let body = try JSONDecoder().decode(Body.self, from: try #require(request.httpBody))
            #expect(body.location == location)
            return (response, HTTPURLResponse(url: request.url!, statusCode: 201, httpVersion: nil, headerFields: nil)!)
        })
        let uploaded = try await api.uploadMedia(MediaUpload(data: Data([1]), source: "photo", autoOrganize: false, location: location))
        #expect(uploaded.location == location)
        var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(media)) as? [String: Any])
        json.removeValue(forKey: "location")
        #expect(try JSONDecoder().decode(SavedMedia.self, from: JSONSerialization.data(withJSONObject: json)).location == nil)
    }

    @Test func cameraAccettaSoloFixRealiRecentiEPrecisi() {
        let capture = Date(timeIntervalSince1970: 1000)
        #expect(MediaLocation.cameraFix(lat: 45, lon: 12, accuracy: 80, fixAt: capture.addingTimeInterval(-30), capturedAt: capture) != nil)
        #expect(MediaLocation.cameraFix(lat: 45, lon: 12, accuracy: 80, fixAt: capture.addingTimeInterval(-31), capturedAt: capture) == nil)
        #expect(MediaLocation.cameraFix(lat: 45, lon: 12, accuracy: 101, fixAt: capture, capturedAt: capture) == nil)
        #expect(MediaLocation.cameraFix(lat: 45, lon: 12, accuracy: -1, fixAt: capture, capturedAt: capture) == nil)
    }
}
