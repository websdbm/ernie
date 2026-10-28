import SwiftUI
import Testing
@testable import Ernie

@Suite(.serialized)
struct TerminalChatTests {
    @Test @MainActor func ilCompositoreRiceveIlTestoSenzaDestinatarioONuoviInvii() async throws {
        let text = "Messaggio sintetico già pronto."
        let model = AppModel() // Nessuna credenziale e nessuna connessione.
        let host = UIHostingController(rootView: FamilyComposerSheet(initialText: text).environment(model))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(200)); host.view.layoutIfNeeded()
        func texts(_ view: UIView) -> [String] {
            let own = (view as? UITextField)?.text ?? (view as? UITextView)?.text
            return (own.map { [$0] } ?? []) + view.subviews.flatMap(texts)
        }
        #expect(texts(host.view).contains(text))
        #expect(model.api == nil)
    }

    @Test @MainActor func slashMostraSuggerimentiSenzaPerdereFocusOTesto() async throws {
        let state = ComposerState(); state.terminal = true
        let host = UIHostingController(rootView: TerminalPreview(terminal: true, state: state))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(200))
        let editor = try #require(findEditor(host.view)); editor.becomeFirstResponder()
        for text in ["/", "m", "e", "s"] {
            editor.insertText(text)
            try await Task.sleep(for: .milliseconds(100))
            #expect(editor.isFirstResponder)
            #expect(editor.text == state.text)
        }
        #expect(state.text == "/mes")
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-slash-inputbar.png")
        try #require(image.pngData()).write(to: path)
        print("SLASH_INPUTBAR: \(path.path)")
    }
    @Test @MainActor func cursoreSegueTestoSelezioneEInvioACapo() async throws {
        let state = ComposerState()
        let host = UIHostingController(rootView: ComposerHarness(state: state))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(300))
        let editor = try #require(findEditor(host.view))
        editor.becomeFirstResponder()
        editor.insertText("Ciao 🐻\nseconda riga")
        #expect(state.text == "Ciao 🐻\nseconda riga")
        host.view.layoutIfNeeded()
        let begin = editor.caretRect(for: editor.beginningOfDocument)
        let end = editor.caretRect(for: editor.endOfDocument)
        #expect(begin.width >= 9)
        #expect(begin.height > begin.width)
        #expect(end.minY > begin.minY)
        #expect(end.maxX <= editor.bounds.width)
        editor.selectedRange = NSRange(location: 0, length: 4)
        editor.insertText("Salve")
        #expect(state.text == "Salve 🐻\nseconda riga")
        editor.selectedRange = NSRange(location: 0, length: 0)
        editor.insertText("> ")
        #expect(state.text.hasPrefix("> Salve"))
        editor.selectedRange = NSRange(location: (editor.text as NSString).length, length: 0)
        editor.insertText(String(repeating: "\nUn'altra riga lunga da scrivere.", count: 12))
        try await Task.sleep(for: .milliseconds(300))
        #expect(editor.isScrollEnabled)
        #expect(editor.bounds.height <= (editor.font?.lineHeight ?? 21) * 6 + 23)
        let draft = state.text
        state.terminal = false
        try await Task.sleep(for: .milliseconds(150))
        #expect(findEditor(host.view) == nil)
        #expect(state.text == draft)
        state.terminal = true
        try await Task.sleep(for: .milliseconds(200))
        #expect(findEditor(host.view)?.text == draft)
        state.text = ""
        try await Task.sleep(for: .milliseconds(200))
        #expect(findEditor(host.view)?.text == "")
        #expect(findEditor(host.view)?.isScrollEnabled == false)
    }

    @Test @MainActor func digitazioneProgressivaNellaBarraCompleta() async throws {
        let host = UIHostingController(rootView: TerminalPreview(terminal: true, draft: ""))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(300))
        let editor = try #require(findEditor(host.view))
        editor.becomeFirstResponder()
        try await Task.sleep(for: .milliseconds(300))
        var expected = ""
        for character in "Ciao Ernie 🐻, questa è una prova.\nSeconda riga." {
            expected.append(character)
            editor.insertText(String(character))
            try await Task.sleep(for: .milliseconds(30))
            host.view.layoutIfNeeded()
            #expect(editor.text == expected)
            #expect(editor.isFirstResponder)
        }
        for _ in 0..<10 {
            editor.deleteBackward()
            expected.removeLast()
            try await Task.sleep(for: .milliseconds(30))
            #expect(editor.text == expected)
        }
        editor.setMarkedText("composizione", selectedRange: NSRange(location: 12, length: 0))
        try await Task.sleep(for: .milliseconds(100))
        editor.unmarkText()
        editor.insertText(" conclusa")
        try await Task.sleep(for: .milliseconds(100))
        #expect(editor.text.hasSuffix("composizione conclusa"))
    }

    @Test @MainActor func focusProgrammaticoECambioSkinNellaBarraCompleta() async throws {
        let state = ComposerState()
        let host = UIHostingController(rootView: TerminalPreview(terminal: true, state: state))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(250))
        for terminal in [true, false, true] {
            state.terminal = terminal
            state.focused = true
            try await Task.sleep(for: .milliseconds(250))
            // La comparsa della tastiera può completarsi dopo l'animazione del cambio skin.
            for _ in 0..<20 where findFirstResponder(host.view) == nil {
                try await Task.sleep(for: .milliseconds(50))
            }
            let responder = try #require(findFirstResponder(host.view), "terminal=\(terminal), requestedFocus=\(state.focused)")
            #expect((responder is TerminalTextView) == terminal)
            let input = try #require(responder as? UIKeyInput)
            input.insertText("Ciao ")
            try await Task.sleep(for: .milliseconds(100))
            #expect(state.focused)
            #expect(state.text.hasSuffix("Ciao "))
            state.focused = false
            try await Task.sleep(for: .milliseconds(200))
            #expect(findFirstResponder(host.view) == nil)
        }
        #expect(state.text == "Ciao Ciao Ciao ")
    }

    @Test @MainActor func bloccoVisibileEPulsante() async throws {
        let host = UIHostingController(rootView: TerminalPreview(terminal: true, draft: ""))
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        try await Task.sleep(for: .milliseconds(300))
        let editor = try #require(findEditor(host.view))
        editor.becomeFirstResponder()
        try await Task.sleep(for: .milliseconds(250))
        #expect(!editor.blockCursor.isHidden)
        #expect(editor.blockCursor.frame.width >= 10)
        #expect(editor.tintColor == UIColor.clear)
        #expect(editor.blockCursor.layer.animation(forKey: "pulse") != nil)
        let initial = editor.blockCursor.frame
        editor.insertText("Ciao Ernie")
        try await Task.sleep(for: .milliseconds(150))
        #expect(editor.blockCursor.frame.minX > initial.minX)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("terminal-chat-preview")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Capture the actual mounted input including the drawn block, not only caretRect.
        let screenshot = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        try screenshot.pngData()?.write(to: folder.appendingPathComponent("borg-focused-cursor.png"))
        let cursorImage = UIGraphicsImageRenderer(bounds: editor.blockCursor.bounds).image { context in
            editor.blockCursor.layer.render(in: context.cgContext)
        }
        let cgImage = try #require(cursorImage.cgImage)
        let data = try #require(cgImage.dataProvider?.data)
        let bytes = try #require(CFDataGetBytePtr(data))
        // The whole rectangular surface is painted, including its right edge.
        let offset = cgImage.bytesPerRow * (cgImage.height / 2) + (cgImage.width - 2) * 4
        #expect(bytes[offset + 3] > 150)
        #expect(cgImage.width >= 20)
        editor.selectedRange = NSRange(location: 0, length: 4)
        editor.updateBlockCursor()
        #expect(editor.blockCursor.isHidden)
        #expect(editor.tintColor != UIColor.clear)
        #expect(editor.blockCursor.layer.animation(forKey: "pulse") == nil)
        editor.insertText("Salve")
        #expect(editor.text == "Salve Ernie")
        editor.insertText("\nseconda riga")
        try await Task.sleep(for: .milliseconds(100))
        #expect(editor.blockCursor.frame.minY > initial.minY)
        editor.resignFirstResponder()
        #expect(editor.blockCursor.isHidden)
        #expect(editor.blockCursor.layer.animation(forKey: "pulse") == nil)
    }

    @Test @MainActor func palettePerOgniCostumeETema() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("bear-palettes-preview")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        defer { previous?.makeKeyAndVisible() }
        for costume in BearCostume.costumes {
            let palette = ChatPalette(costume: costume)
            #expect(palette.terminal == (costume == .borg))
            for scheme in [ColorScheme.light, .dark] {
                let host = UIHostingController(rootView: TerminalPreview(terminal: palette.terminal, costume: costume)
                    .environment(\.colorScheme, scheme))
                let window = UIWindow(windowScene: scene)
                window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
                window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
                window.rootViewController = host
                window.makeKeyAndVisible()
                try await Task.sleep(for: .milliseconds(120))
                host.view.layoutIfNeeded()
                #expect((findEditor(host.view) != nil) == palette.terminal)
                let data = try #require(UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                    host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
                }.pngData())
                try data.write(to: folder.appendingPathComponent("\(costume.rawValue)-\(scheme == .dark ? "dark" : "light").png"))
                let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
                func luminance(_ color: Color) -> CGFloat {
                    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                    UIColor(color).resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
                    func linear(_ c: CGFloat) -> CGFloat { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
                    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
                }
                for (foreground, background) in [(palette.ink, palette.ground), (palette.inkSecondary, palette.surface),
                                                 (palette.bubbleText, palette.bubble), (palette.accentText, palette.surface)] {
                    let a = luminance(foreground), b = luminance(background)
                    #expect((max(a, b) + 0.05) / (min(a, b) + 0.05) >= 4.5, "\(costume.rawValue) \(scheme)")
                }
                window.isHidden = true
            }
        }
        #expect(BearCostume.resolve(choice: "borg", hour: 23, tools: ["recipe_save"], emotion: "cool") == .borg)
        #expect(BearCostume.resolve(choice: "automatic", hour: 23, tools: [], emotion: "") == .night)
        #expect(BearCostume.resolve(choice: "automatic", hour: 10, tools: ["recipe_save"], emotion: "") == .chef)
        print("BEAR_PALETTES_PREVIEWS: \(folder.path)")
    }

    @MainActor private func findFirstResponder(_ root: UIView) -> UIView? {
        if root.isFirstResponder { return root }
        return root.subviews.lazy.compactMap { findFirstResponder($0) }.first
    }

    @Test @MainActor func anteprimeETemaLocale() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("terminal-chat-preview")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        var captures: [Data] = []
        for (name, terminal, scheme, typeSize) in [
            ("terminal-light", true, ColorScheme.light, DynamicTypeSize.large),
            ("terminal-dark", true, ColorScheme.dark, DynamicTypeSize.large),
            ("classic-light", false, ColorScheme.light, DynamicTypeSize.large),
            ("classic-dark", false, ColorScheme.dark, DynamicTypeSize.large),
            ("terminal-accessible", true, ColorScheme.dark, DynamicTypeSize.accessibility2)
        ] {
            let view = TerminalPreview(terminal: terminal)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, typeSize)
            let host = UIHostingController(rootView: view)
            let window = UIWindow(windowScene: scene)
            window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
            window.rootViewController = host
            window.makeKeyAndVisible()
            try await Task.sleep(for: .milliseconds(250))
            host.view.layoutIfNeeded()
            if terminal {
                let editor = try #require(findEditor(host.view))
                #expect(editor.bounds.height <= 181)
                #expect(editor.bounds.width > 100)
                if typeSize.isAccessibilitySize { #expect((editor.font?.pointSize ?? 0) > 30) }
            }
            let data = try #require(UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }.pngData())
            captures.append(data)
            try data.write(to: folder.appendingPathComponent("\(name).png"))
            window.isHidden = true
        }
        previous?.makeKeyAndVisible()
        #expect(captures[0] != captures[2])
        #expect(captures[2] != captures[3])
        #expect(captures[1] != captures[4])
        #expect(ChatPalette().terminal == false)
        print("TERMINAL_PREVIEWS: \(folder.path)")
    }

    @MainActor private func findEditor(_ root: UIView) -> TerminalTextView? {
        if let editor = root as? TerminalTextView { return editor }
        return root.subviews.lazy.compactMap { findEditor($0) }.first
    }
}

@MainActor @Observable private final class ComposerState {
    var text = ""
    var focused = false
    var terminal = true
}
private struct ComposerHarness: View {
    @Bindable var state: ComposerState
    var body: some View {
        VStack {
            if state.terminal {
                TerminalComposer(text: $state.text, focused: $state.focused, placeholder: "Chiedi a Ernie")
            } else {
                TextField("Chiedi a Ernie", text: $state.text, axis: .vertical)
            }
            Spacer()
        }.padding().chatAppearance(terminal: state.terminal)
    }
}

private struct TerminalPreview: View {
    @Bindable private var state: ComposerState
    private var terminal: Bool { state.terminal }
    private var costume: BearCostume { costumeOverride ?? (terminal ? .borg : .base) }
    private let costumeOverride: BearCostume?
    private let model = AppModel()
    private let conversation: ConversationStore
    private let voice: VoiceController
    private let documents = DocumentComposer()

    init(terminal: Bool, draft: String = "Ricordami di preparare l’impasto", state: ComposerState? = nil, costume: BearCostume? = nil) {
        costumeOverride = costume
        let value = state ?? ComposerState()
        if state == nil { value.text = draft; value.terminal = terminal }
        _state = Bindable(wrappedValue: value)
        let speaker = Speaker()
        let suite = "terminal-preview-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        conversation = ConversationStore(
            credentials: Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "synthetic"),
            speaker: speaker, inbox: InboxStore(), settings: LocalSettings(),
            transcript: TranscriptStore(directory: directory, defaults: defaults), deviceContext: { nil })
        voice = VoiceController(conversation: conversation, speaker: speaker)
        defaults.removePersistentDomain(forName: suite)
        // Nessuna connect(), startListening() o configurazione API: rendering offline.
    }
    var body: some View {
        ZStack {
            ChatBackdrop()
            VStack(spacing: 20) {
                HStack {
                    GlassCircleButton(systemName: "sidebar.leading", label: "Menu") {}
                    Spacer()
                    HStack {
                        BearFrame(costume: costume, index: 0, size: 42)
                        VStack(alignment: .leading) { Text("Ernie").font(.subheadline.weight(.semibold)); Text("pronto").font(.caption2) }
                    }.padding(8).ernieGlass(in: Capsule())
                    Spacer()
                    GlassCircleButton(systemName: "speaker.wave.2.fill", label: "Voce") {}
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        MessageRow(message: ChatMessage(id: "1", correlationId: "1", role: .user, text: "Cosa devo fare oggi?", createdAt: .now))
                        ToolPill(name: "Consultazione delle attività", ok: true)
                        MessageRow(message: ChatMessage(id: "2", correlationId: "1", role: .assistant, text: "Ecco i tuoi impegni:\n\n- **15:00** — accompagna Cloe.\n- **18:00** — vai a riprenderla.\n\nHai tempo per preparare l’impasto della pizza nel pomeriggio.", createdAt: .now))
                    }
                }
                InputBar(draft: $state.text, composing: $state.focused, conversation: conversation, voice: voice, documents: documents)
            }.padding()
            .foregroundStyle(ChatPalette(costume: costume).ink)
        }.chatAppearance(costume: costume).environment(model)
    }
}
