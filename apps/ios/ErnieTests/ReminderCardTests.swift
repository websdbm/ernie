import Foundation
import SwiftUI
import Testing
import UIKit
@testable import Ernie

@MainActor struct ReminderCardTests {
    private func reminder() -> ReminderItem {
        .init(id: "preview", text: "Portare il monitor in spedizione", at: "2026-11-11T18:00:00Z",
              status: "scheduled", channels: .init(email: false, alarm: true))
    }

    @Test func dueMomentiSoloConDatiEsplicitiCoerenti() {
        var item = reminder()
        item.text = "Spedire il monitor giovedì mattina"
        #expect(ReminderCardPresentation.eventDate(item) == nil)
        item.eventAt = "2026-11-12T08:00:00Z"
        #expect(ReminderCardPresentation.eventDate(item) == ReminderStore.date(item.eventAt))
        item.eventAt = item.at
        #expect(ReminderCardPresentation.eventDate(item) == nil)
        item.eventAt = "2026-11-10T08:00:00Z"
        #expect(ReminderCardPresentation.eventDate(item) == nil)
        item.eventAt = "giovedì mattina"
        #expect(ReminderCardPresentation.eventDate(item) == nil)
        item.eventAt = "2026-11-12T08:00:00Z"
        item.at = nil
        #expect(ReminderCardPresentation.eventDate(item) == nil)
        item = reminder()
        item.eventAt = "2026-11-12T08:00:00Z"
        item.place = .init(label: "ufficio", on: "arrive")
        #expect(ReminderCardPresentation.eventDate(item) == nil)
    }

    @Test func oggiEDomaniRispettanoIlCalendarioLocaleAncheACavalloDelGiorno() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Europe/Rome"))
        let now = try #require(ReminderStore.date("2026-11-10T22:30:00Z"))
        #expect(ReminderCardPresentation.day(try #require(ReminderStore.date("2026-11-10T22:55:00Z")), now: now, calendar: calendar) == "Oggi")
        #expect(ReminderCardPresentation.day(try #require(ReminderStore.date("2026-11-10T23:05:00Z")), now: now, calendar: calendar) == "Domani")
    }

    private func render(_ item: ReminderItem, width: CGFloat = 390, costume: BearCostume = .astronaut,
                        scheme: ColorScheme = .light, size: DynamicTypeSize = .large) throws -> UIImage {
        let palette = ChatPalette(costume: costume)
        let renderer = ImageRenderer(content: ReminderCardView(item: item)
            .padding(16).frame(width: width).background(palette.ground)
            .environment(\.chatPalette, palette)
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size))
        renderer.scale = 2
        return try #require(renderer.uiImage)
    }

    @Test func titoloEDettagliNonSiPerdonoConTestiGrandi() throws {
        let short = try render(reminder(), width: 320)
        var long = reminder()
        long.text = String(repeating: "Preparare il materiale per il laboratorio e verificare tutti i documenti. ", count: 4)
        long.location = "Centro di formazione, ingresso del padiglione accanto alla biblioteca"
        long.locationAddress = "Indirizzo della sede da consultare in Mappe"
        long.url = "https://example.test/workshop"
        long.notes = "Portare il portatile e gli accessori."
        let normal = try render(long, width: 320)
        let large = try render(long, width: 320, size: .accessibility3)
        #expect(normal.size.width == 320)
        #expect(large.size.width == 320)
        #expect(normal.size.height > short.size.height + 100)
        #expect(large.size.height > normal.size.height)
    }

    @Test func anteprimeDiStatiTemiETimeline() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-reminder-cards-116")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var two = reminder(); two.eventAt = "2026-11-12T08:00:00Z"
        var cancelled = reminder(); cancelled.status = "cancelled"
        var done = reminder(); done.status = "done"
        var place = reminder(); place.at = nil; place.place = .init(label: "ufficio", on: "leave", repeats: true, address: "Via del laboratorio", lat: 45, lng: 12)
        var family = reminder(); family.forLabel = "Un familiare con un nome molto lungo"
        var recurring = reminder(); recurring.repeatInfo = .init(kind: "weekly", weekdays: [5], day: nil, hour: 19, minute: 0, label: "Ogni venerdì alle 19")
        let cases: [(String, ReminderItem, CGFloat, BearCostume, ColorScheme, DynamicTypeSize)] = [
            ("light", reminder(), 390, .astronaut, .light, .large),
            ("dark", reminder(), 390, .astronaut, .dark, .large),
            ("borg", reminder(), 390, .borg, .dark, .large),
            ("two-moments", two, 390, .astronaut, .light, .large),
            ("two-moments-borg", two, 320, .borg, .dark, .xxxLarge),
            ("accessible", reminder(), 320, .base, .light, .accessibility3),
            ("cancelled", cancelled, 390, .base, .light, .large),
            ("done", done, 390, .base, .dark, .large),
            ("place", place, 320, .explorer, .dark, .large),
            ("family", family, 320, .base, .light, .xxxLarge),
            ("recurring", recurring, 390, .base, .light, .large),
        ]
        for (name, item, width, costume, scheme, size) in cases {
            let image = try render(item, width: width, costume: costume, scheme: scheme, size: size)
            #expect(image.size.width == width)
            if name == "light" { #expect(image.size.height < 350) }
            let path = folder.appendingPathComponent(name + ".png")
            let native = try await hosted(ReminderCardView(item: item).padding(16).background(ChatPalette(costume: costume).ground),
                                          width: width, height: image.size.height, costume: costume, scheme: scheme, size: size)
            try #require(native.pngData()).write(to: path)
            print("REMINDER_CARD_SNAPSHOT: \(path.path) height=\(image.size.height)")
        }
    }

    @Test func editorConTuttiIDettagliInChiaroEBorg() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-reminder-cards-116")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var item = reminder()
        item.at = "2099-11-11T18:00:00Z"
        item.location = "Centro di formazione"
        item.url = "https://example.test/workshop"
        item.notes = "Portare il portatile."
        let model = AppModel()
        for (name, costume, scheme) in [("editor-light", BearCostume.astronaut, ColorScheme.light), ("editor-borg", .borg, .dark)] {
            let image = try await hosted(ReminderEditorSheet(item: item).environment(model), width: 390, height: 844,
                                         costume: costume, scheme: scheme, size: .large)
            let path = folder.appendingPathComponent(name + ".png")
            try #require(image.pngData()).write(to: path)
            print("REMINDER_EDITOR_SNAPSHOT: \(path.path)")
        }
    }

    private func hosted<Content: View>(_ content: Content, width: CGFloat, height: CGFloat,
                                       costume: BearCostume, scheme: ColorScheme, size: DynamicTypeSize) async throws -> UIImage {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let host = UIHostingController(rootView: content
            .frame(width: width, height: height, alignment: .top)
            .environment(\.chatPalette, ChatPalette(costume: costume))
            .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            .ignoresSafeArea())
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: width, height: height)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(250))
        host.view.layoutIfNeeded()
        return UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
    }

}
