import Foundation
import SwiftUI
import Testing
@testable import Ernie

struct OperatingPreferencesTests {
    @Test @MainActor func preferenzeInChiaroScuroECaratteriAccessibili() async throws {
        let rows = [
            OperatingPreference(id: "one", text: "Quando una lista è ambigua, mostrami le alternative da toccare.", kind: "explicit", active: true, source: "chat", evidence: "Quando una lista è ambigua, mostrami le alternative da toccare.", createdAt: "2026-10-22T18:00:00.000Z", updatedAt: "2026-10-22T18:00:00.000Z"),
            OperatingPreference(id: "two", text: "Organizza le attività in piccoli passi e indica da quale iniziare.", kind: "explicit", active: false, source: "settings", evidence: "Organizza le attività in piccoli passi e indica da quale iniziare.", createdAt: "2026-10-22T18:00:00.000Z", updatedAt: "2026-10-22T18:00:00.000Z"),
            OperatingPreference(id: "three", text: "Forse preferisci risposte brevi al mattino.", kind: "inferred", active: false, source: "observation", evidence: "Una risposta breve", createdAt: "2026-10-22T18:00:00.000Z", updatedAt: "2026-10-22T18:00:00.000Z")
        ]
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("operating-preferences-preview", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var captures: [Data] = []
        for (name, scheme, typeSize) in [
            ("light", ColorScheme.light, DynamicTypeSize.large),
            ("dark", ColorScheme.dark, DynamicTypeSize.large),
            ("accessibility-light", ColorScheme.light, DynamicTypeSize.accessibility2),
            ("accessibility-dark", ColorScheme.dark, DynamicTypeSize.accessibility2)
        ] {
            let model = AppModel()
            #expect(model.api == nil, "L'anteprima non deve accedere a dati reali")
            let view = NavigationStack { OperatingPreferencesView(initialPreferences: rows) }
                .environment(model).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, typeSize)
            let host = UIHostingController(rootView: view)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            window.rootViewController = host
            window.makeKeyAndVisible()
            try await Task.sleep(for: .milliseconds(350))
            host.view.layoutIfNeeded()
            let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
            let data = try #require(renderer.image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }.pngData())
            captures.append(data)
            try data.write(to: folder.appendingPathComponent("\(name).png"))
            #expect(host.view.bounds.width == 390)
            window.isHidden = true
        }
        previousWindow?.makeKeyAndVisible()
        #expect(Set(captures).count == 4, "Tema e dimensione testo devono influenzare davvero il rendering")
        print("OPERATING_PREFERENCES_PREVIEWS: \(folder.path)")
    }
}
