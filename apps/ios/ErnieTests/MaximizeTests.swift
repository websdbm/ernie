import Foundation
import Testing
import SwiftUI
import UIKit
@testable import Ernie

struct MaximizeTests {
    @Test func olderRequestsAndSessionsStayAutomatic() throws {
        let old = Data(#"{"text":"ciao","inputMode":"text"}"#.utf8)
        #expect(try JSONDecoder().decode(UserMessagePayload.self, from: old).modelSelection == nil)
        let file = Data(#"{"sessionId":"a","lastSeq":0,"items":[],"updatedAt":0}"#.utf8)
        #expect(try JSONDecoder().decode(TranscriptStore.SessionFile.self, from: file).modelSelection == nil)
    }

    @Test func queuedRequestKeepsItsSelectionAndProvider() throws {
        var selection = ChatModelSelection(provider: "openrouter", modelId: "openai/gpt-6.1-sol", effort: "high")
        let request = UserMessagePayload(text: "organizza", inputMode: "text", modelSelection: selection)
        selection.effort = "low"
        let saved = try JSONDecoder().decode(UserMessagePayload.self, from: JSONEncoder().encode(request))
        #expect(saved.modelSelection?.effort == "high")
        #expect(saved.modelSelection?.provider == "openrouter")
    }

    @Test func conversationsPersistIndependentChoices() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TranscriptStore(directory: directory)
        let choice = ChatModelSelection(provider: "anthropic", modelId: "claude-fable-5-2", effort: "max")
        store.save(.init(sessionId: "a", lastSeq: 0, items: [], updatedAt: .now, modelSelection: choice))
        store.save(.init(sessionId: "b", lastSeq: 0, items: [], updatedAt: .now))
        #expect(store.load("a")?.modelSelection == choice)
        #expect(store.load("b")?.modelSelection == nil)
    }
}

@MainActor @Suite(.serialized) struct MaximizeAppearanceTests {
    @Test func nativeLightDarkAndBorg() async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-maximize-117")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let store = ConversationStore(credentials: .init(serverURL: URL(string: "https://example.invalid")!, apiKey: "test"),
                                      speaker: Speaker(), inbox: InboxStore(), settings: LocalSettings(),
                                      transcript: TranscriptStore(directory: folder.appendingPathComponent("sessions"), defaults: UserDefaults(suiteName: "maximize-appearance-test")!), deviceContext: { nil })
        defer { store.disconnect() }
        store.selectModel(.init(provider: "anthropic", modelId: "claude-fable-5-2", effort: "high"))
        let catalog = ChatModelCatalog(active: true, models: [
            .init(id: "claude-fable-5-2", provider: "anthropic", name: "Claude Fable 5.2", efforts: ["default","low","medium","high","xhigh","max"], contextTokens: 1000000, maxOutputTokens: 128000, imageInput: true, sshEligible: true, price: .init(inputPerM: 8, outputPerM: 40)),
            .init(id: "openai/gpt-6.1-sol", provider: "openrouter", name: "OpenAI: GPT-6.1 Sol", efforts: ["default","low","high"], contextTokens: 1000000, maxOutputTokens: 128000, imageInput: true, sshEligible: false, price: .init(inputPerM: 2, outputPerM: 10))
        ], updatedAt: nil, unavailable: [])
        for (name, costume, scheme, showSheet) in [("light", BearCostume.base, ColorScheme.light, true), ("dark", .base, .dark, true), ("borg-bar", .borg, .dark, false)] {
            let palette = ChatPalette(costume: costume)
            let view = MaximizeBar(conversation: store, palette: palette, catalog: catalog, initiallyPresented: showSheet)
                .environment(AppModel()).environment(\.colorScheme, scheme).tint(palette.accent)
                .frame(width: 390, height: 844).background(palette.ground)
            let host = UIHostingController(rootView: view)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            window.rootViewController = host; window.makeKeyAndVisible()
            try await Task.sleep(for: .milliseconds(600))
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let path = folder.appendingPathComponent(name + ".png")
            try #require(image.pngData()).write(to: path)
            print("MAXIMIZE_SNAPSHOT: \(path.path)")
            window.isHidden = true; previous?.makeKeyAndVisible()
        }
    }
}
