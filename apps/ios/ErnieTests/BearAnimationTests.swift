import Foundation
import SwiftUI
import Testing
import ImageIO
@testable import Ernie

struct BearAnimationTests {
    @Test @MainActor func animazioneSwiftUICambiaEIlBackgroundLaFerma() async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let previousCostume = UserDefaults.standard.string(forKey: BearCostume.preferenceKey)
        UserDefaults.standard.set("astronaut", forKey: BearCostume.preferenceKey)
        let view = PixelBearView(state: .thinking, mouthOpen: false, size: 120)
            .frame(width: 180, height: 180).background(Color.white)
        let host = UIHostingController(rootView: view.environment(\.scenePhase, .active))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 180, height: 180)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previousWindow?.makeKeyAndVisible()
            if let previousCostume { UserDefaults.standard.set(previousCostume, forKey: BearCostume.preferenceKey) }
            else { UserDefaults.standard.removeObject(forKey: BearCostume.preferenceKey) }
        }
        func snapshot() throws -> Data {
            host.view.layoutIfNeeded()
            let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
            return try #require(renderer.image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }.pngData())
        }
        try await Task.sleep(for: .milliseconds(350))
        let first = try snapshot()
        try await Task.sleep(for: .milliseconds(650))
        #expect(first != (try snapshot()), "L'avatar deve animarsi nel renderer SwiftUI reale")
        host.rootView = view.environment(\.scenePhase, .background)
        try await Task.sleep(for: .milliseconds(350))
        let stopped = try snapshot()
        try await Task.sleep(for: .milliseconds(650))
        #expect(stopped == (try snapshot()), "In background l'avatar deve restare fermo")
    }

    @Test @MainActor func tuttiICostumiHannoEspressioniEGestiReali() throws {
        #expect(BearCostume.costumes.count == 12)
        for costume in BearCostume.costumes {
            let meta = try #require(BearAtlas.metadata[costume.rawValue])
            #expect(meta.count == 40)
            #expect(meta.file == "ernie-bear-v3-\(costume.rawValue)")
            for index in 0..<40 {
                let rect = try #require(meta.rect(index: index, imageWidth: meta.width, imageHeight: meta.height))
                #expect(rect.minX >= 0 && rect.minY >= 0 && rect.maxX <= Double(meta.width) && rect.maxY <= Double(meta.height))
                let cell = try #require(BearAtlas.cell(costume: costume.rawValue, index: index))
                #expect(cell.cgImage?.width == Int(rect.width) && cell.cgImage?.height == Int(rect.height))
                #expect(cell.scale == 1) // Nessun downsampling del foglio o stiramento del rapporto d'aspetto.
                #expect(cell.size.width / cell.size.height == rect.width / rect.height)
            }
            for gesture in BearMotion.Gesture.allCases {
                let frames = try (0..<4).map {
                    try #require(BearAtlas.cell(costume: costume.rawValue, index: gesture.rawValue + $0)?.pngData())
                }
                #expect(Set(frames).count >= 3, "Il gesto deve cambiare davvero in \(costume.title)")
            }
        }
        #expect(BearAtlas.metadata["paws"]?.count == 12)
        for index in 0..<12 { #expect(BearAtlas.cell(costume: "paws", index: index) != nil) }
        #expect(BearAtlas.cell(costume: "base", index: 40) == nil)
        #expect(BearAtlas.cell(costume: "base", index: -1) == nil)
    }

    @Test func frameMapSaltaRigheFisicheSenzaCambiareGliIndiciDeiGesti() throws {
        let mapping = Array(0..<24) + Array(28..<44)
        let json: [String: Any] = ["file": "ernie-bear-v3-base", "width": 400, "height": 1100,
                                  "columns": 4, "rowEdges": Array(stride(from: 0, through: 1100, by: 100)), "frameMap": mapping]
        let meta = try JSONDecoder().decode(BearAtlasMetadata.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(meta.nativeCount == 44 && meta.count == 40 && meta.isValid)
        #expect(meta.rect(index: 23, imageWidth: 400, imageHeight: 1100)?.minY == 500)
        #expect(meta.rect(index: 24, imageWidth: 400, imageHeight: 1100)?.minY == 700)
        #expect(meta.rect(index: 39, imageWidth: 400, imageHeight: 1100)?.minY == 1000)
        #expect(meta.rect(index: 40, imageWidth: 400, imageHeight: 1100) == nil)
        #expect(meta.rect(index: 0, imageWidth: 200, imageHeight: 550) == nil)
    }

    @Test @MainActor func metadatiPatologiciORiferimentiFuoriBundleSonoRifiutati() throws {
        let valid: [String: Any] = ["file": "ernie-bear-v3-base", "width": 400, "height": 1000,
                                   "columns": 4, "rowEdges": Array(stride(from: 0, through: 1000, by: 100))]
        func decode(_ value: [String: Any]) throws -> [String: BearAtlasMetadata] {
            BearAtlas.decodeMetadata(try JSONSerialization.data(withJSONObject: ["base": value]))
        }
        #expect(try decode(valid)["base"]?.count == 40)
        let invalid: [(String, Any)] = [
            ("file", "../../old-cartoon"), ("file", "ernie-bear-base"),
            ("width", Int.max), ("height", 0), ("columns", Int.max),
            ("rowEdges", []), ("rowEdges", [0, 10, 10, 1000]),
            ("rowEdges", [-1, 1000]), ("rowEdges", [0, 1001]),
            ("frameMap", []), ("frameMap", Array(repeating: -1, count: 40)),
            ("frameMap", Array(repeating: 40, count: 40)),
            ("portraitBaselines", []), ("portraitBaselines", Array(repeating: -1, count: 40)),
            ("portraitBaselines", Array(repeating: 101, count: 40)),
            ("portraitBaselines", Array(repeating: Int.max, count: 40)),
            ("insetsByIndex", ["0": ["left": -1, "top": 0, "right": 0, "bottom": 0]]),
            ("insetsByIndex", ["0": ["left": 100, "top": 0, "right": 100, "bottom": 0]])
        ]
        for (key, value) in invalid {
            var bad = valid; bad[key] = value
            #expect(try decode(bad).isEmpty, "Non deve accettare \(key): \(value)")
        }
        #expect(BearAtlas.decodeMetadata(Data(repeating: 32, count: 65_537)).isEmpty)
    }

    @Test @MainActor func widgetUsaNuoviCostumiEspressioniEMascheraTrasparente() throws {
        #expect(BearWidgetArtwork.selection(legacyFrame: 3) == .init(costume: "night", index: 34))
        #expect(BearWidgetArtwork.selection(legacyFrame: 28) == .init(costume: "night", index: 32))
        #expect(BearWidgetArtwork.selection(legacyFrame: 13) == .init(costume: "base", index: 3))
        #expect(BearWidgetArtwork.selection(legacyFrame: 16) == .init(costume: "classic", index: 10))
        #expect(BearWidgetArtwork.selection(legacyFrame: 29) == .init(costume: "base", index: 11))
        #expect(BearWidgetArtwork.selection(legacyFrame: 31) == .init(costume: "base", index: 16))
        #expect(BearWidgetArtwork.selection(legacyFrame: Int.min) == .init(costume: "base", index: 0))
        for legacy in 0..<32 {
            let selection = BearWidgetArtwork.selection(legacyFrame: legacy)
            #expect(BearAtlas.cell(costume: selection.costume, index: selection.index) != nil)
            #expect(BearAtlas.cell(costume: "mono", index: selection.index) != nil)
        }
        #expect(BearAtlas.metadata["mono"]?.count == 40)
        for frame in 0..<40 { #expect(BearAtlas.cell(costume: "mono", index: frame) != nil) }
        let source = try #require(BearAtlas.cell(costume: "mono", index: 0))
        let renderer = ImageRenderer(content: BearPortraitArtwork(image: source,
            baseline: BearAtlas.portraitBaseline(costume: "mono", index: 0, image: source), size: 160, monochrome: true))
        let rendered = try #require(renderer.uiImage?.cgImage)
        let mono = try #require(BearAtlas.cropped(rendered, rect: CGRect(x: 0, y: 0, width: rendered.width, height: rendered.height))?.cgImage)
        let bytes = try #require(mono.dataProvider?.data) as Data
        let alpha = (0..<mono.height).flatMap { row in
            (0..<mono.width).map { bytes[row * mono.bytesPerRow + $0 * 4 + 3] }
        }
        #expect(alpha.contains(0) && alpha.contains(where: { $0 > 0 }), "Il lock screen richiede figura visibile e fondo trasparente")
        #expect(Double(alpha.filter { $0 == 0 }.count) / Double(alpha.count) > 0.2, "Il fondo non deve diventare un disco pieno")
        #expect(BearAtlas.fallback != nil)
        #expect(BearAtlas.metadataResource == "ernie-bear-v3-atlases")
        #expect(BearAtlas.loadMetadata(bundle: Bundle(for: NSObject.self)).isEmpty)
    }

    @Test func travestimentoSceltoRestaAncheConAltreAttivita() {
        for costume in BearCostume.costumes {
            for hour in [0, 6, 12, 23] {
                #expect(BearCostume.resolve(choice: costume.rawValue, hour: hour, tools: ["recipe_save", "ssh_execute"], emotion: "cool") == costume)
            }
        }
        #expect(BearCostume.resolve(choice: "automatic", hour: 22, tools: [], emotion: "neutral") == .night)
        #expect(BearCostume.resolve(choice: "automatic", hour: 9, tools: ["recipe_save"], emotion: "neutral") == .chef)
        #expect(BearCostume.resolve(choice: "automatic", hour: 9, tools: ["ssh_execute"], emotion: "neutral") == .engineer)
        #expect(BearCostume.resolve(choice: "automatic", hour: 9, tools: ["web_search"], emotion: "neutral") == .detective)
        #expect(BearCostume.resolve(choice: "automatic", hour: 9, tools: ["place_get"], emotion: "neutral") == .explorer)
        #expect(BearCostume.resolve(choice: "unknown", hour: 9, tools: [], emotion: "neutral") == .base)
    }

    @Test @MainActor func ritrattoNonMostraLaBaseTagliataDentroIlCerchio() throws {
        // Riproduce il difetto della build 89: fondo viola sotto il taglio del busto.
        let base = try #require(BearAtlas.cell(costume: "base", index: 0))
        let previous = Image(uiImage: base).resizable().interpolation(.none).scaledToFit()
            .frame(width: 112, height: 112).background(BearAtlas.background).clipShape(Circle())
        #expect(try lowerPortraitCoverage(previous, monochrome: false) < 0.1)
        for costume in BearCostume.costumes.map(\.rawValue) + ["mono"] {
            let metadata = try #require(BearAtlas.metadata[costume])
            #expect(metadata.portraitBaselines?.count == 40)
            for index in 0..<40 {
                let image = try #require(BearAtlas.cell(costume: costume, index: index))
                let baseline = BearAtlas.portraitBaseline(costume: costume, index: index, image: image)
                let view = BearPortraitArtwork(image: image, baseline: baseline, size: 112, monochrome: costume == "mono")
                #expect(try lowerPortraitCoverage(view, monochrome: costume == "mono") > 0.5,
                        "Fascia vuota sotto il ritratto: \(costume), fotogramma \(index)")
                for size in [36.8, 40.0, 54.0, 64.0, 112.0, 118.0, 240.0] {
                    let rect = BearPortraitLayout(imageSize: image.size, baseline: baseline, size: size).imageRect
                    #expect(rect.minY + baseline * rect.width / image.size.width > size)
                }
            }
        }
    }

    @MainActor private func lowerPortraitCoverage(_ view: some View, monochrome: Bool) throws -> Double {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let rendered = try #require(renderer.uiImage?.cgImage)
        let image = try #require(BearAtlas.cropped(rendered, rect: CGRect(x: 0, y: 0, width: rendered.width, height: rendered.height))?.cgImage)
        let bytes = try #require(image.dataProvider?.data) as Data
        var covered = 0, count = 0
        // Appena sopra il bordo circolare inferiore, lontano dall'antialias del cerchio.
        for y in Int(Double(image.height) * 0.93)..<Int(Double(image.height) * 0.97) {
            // Comprende anche il pelo ai lati: nel monocromatico le ombre sotto
            // il mento sono intenzionalmente trasparenti, non un taglio del busto.
            for x in Int(Double(image.width) * 0.35)..<Int(Double(image.width) * 0.65) {
                let offset = y * image.bytesPerRow + x * 4
                let r = Double(bytes[offset]), g = Double(bytes[offset + 1]), b = Double(bytes[offset + 2])
                let isPurple = b > r * 1.12 && b > g * 1.2
                if monochrome ? bytes[offset + 3] > 8 : !isPurple { covered += 1 }
                count += 1
            }
        }
        return Double(covered) / Double(count)
    }

    @Test @MainActor func anteprimaDimensioniRealiDiAppEWidget() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-bear-v3-previews")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let source = try #require(BearAtlas.cell(costume: "base", index: 0))
        let previous = Image(uiImage: source).resizable().interpolation(.none).scaledToFit()
            .frame(width: 112, height: 112).background(BearAtlas.background).clipShape(Circle())
        let examples = VStack(spacing: 20) {
            HStack(spacing: 24) {
                VStack { Text("Prima"); previous }
                VStack { Text("Corretto"); BearFrame(costume: .base, index: 0, size: 112) }
            }
            HStack(spacing: 14) {
                BearFrame(costume: .base, index: 0, size: 112)
                    .overlay(Circle().strokeBorder(.white.opacity(0.35), lineWidth: 2))
                VStack(alignment: .leading) {
                    Text("Buongiorno").font(.headline)
                    Text("Prossimo: ritirare il pacco Ikea").font(.caption)
                    HStack { Image(systemName: "mic.fill"); Text("Parla") }.font(.caption).padding(8)
                }
            }.padding(16).frame(width: 338, height: 158).background(Color(red: 0.25, green: 0.15, blue: 0.55), in: RoundedRectangle(cornerRadius: 24))
            HStack(spacing: 10) {
                ForEach([36.8, 40.0, 54.0, 64.0], id: \.self) { size in
                    VStack { BearFrame(costume: .night, index: 0, size: size); Text("\(Int(size)) pt").font(.caption) }
                }
            }
            BearFrame(costume: .base, index: 20, size: 240)
        }.padding(16).background(Color(red: 0.12, green: 0.1, blue: 0.2)).foregroundStyle(.white)
        try render(examples, to: folder.appendingPathComponent("portrait-framing.png"))
    }

    @Test func ascoltoEParlatoNonVengonoInterrottiDaSonnoOStarnuto() {
        for elapsed in [0.0, 48.3, 120.6, 1_000] {
            let speaking = BearMotion.frame(state: .speaking, emotion: "sleep", mouthOpen: true, elapsed: elapsed, idleFor: 1_000)
            #expect((25...27).contains(speaking))
            #expect(BearMotion.frame(state: .speaking, emotion: "angry", mouthOpen: false, elapsed: elapsed, idleFor: 1_000) == 24)
            #expect([0, 18].contains(BearMotion.frame(state: .listening, emotion: "sleep", mouthOpen: false, elapsed: elapsed, idleFor: 1_000)))
            #expect((20...23).contains(BearMotion.frame(state: .thinking, emotion: "sleep", mouthOpen: false, elapsed: elapsed, idleFor: 1_000)))
        }
        #expect((28...31).contains(BearMotion.frame(state: .idle, emotion: "neutral", mouthOpen: false, elapsed: 48.6, idleFor: 48.6)))
        #expect((32...35).contains(BearMotion.frame(state: .idle, emotion: "neutral", mouthOpen: false, elapsed: 160, idleFor: 160)))
    }

    @Test func riduciMovimentoBloccaFotogrammiECelebrazioni() {
        for state in [AgentState.idle, .thinking, .speaking, .listening] {
            let frames = Set((0..<40).map {
                BearMotion.frame(state: state, emotion: "love", mouthOpen: true,
                                 elapsed: Double($0) * 0.2, idleFor: 10,
                                 celebrationFor: 0.3, reduceMotion: true)
            })
            #expect(frames.count == 1)
        }
        #expect(BearActivityIcon.frame(status: .success, elapsed: nil, clock: 0, reduceMotion: false) == 9)
        #expect(BearActivityIcon.frame(status: .success, elapsed: 0.5, clock: 0, reduceMotion: true) == 9)
    }

    @Test func nienteCinquePerErroriInterruzioniOConfermePendenti() {
        var message = ChatMessage(id: "a", correlationId: "t", role: .assistant, text: "Fatto", createdAt: .now)
        message.usage = UsagePayload(inputTokens: 1, outputTokens: 1, llmCalls: 1, toolCalls: 0, latencyMs: 1)
        #expect(BearContext.latest(in: [.message(message)]).completedID == "a")
        message.cancelled = true
        #expect(BearContext.latest(in: [.message(message)]).completedID == nil)
        message.cancelled = false
        message.tools = [ToolActivity(id: "tool", toolId: "recipe_save", ok: nil)]
        #expect(BearContext.latest(in: [.message(message)]).completedID == nil)
        message.tools[0].ok = false
        #expect(BearContext.latest(in: [.message(message)]).completedID == nil)
        message.tools[0].ok = true
        #expect(BearContext.latest(in: [.message(message)]).completedID == "a")
        let user = ChatMessage(id: "u", correlationId: "new", role: .user, text: "Altro", createdAt: .now)
        #expect(BearContext.latest(in: [.message(message), .message(user)]) == BearContext())
    }

    @Test @MainActor func anteprimeDeiRitagliEDelleAttivita() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-bear-v3-previews")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for costume in BearCostume.costumes {
            let sheet = VStack(spacing: 8) {
                Text(costume.title).font(.headline)
                ForEach(0..<10, id: \.self) { row in
                    HStack(spacing: 8) {
                        ForEach(0..<4, id: \.self) { col in
                            BearFrame(costume: costume, index: row * 4 + col, size: 80)
                                .clipShape(Circle())
                        }
                    }
                }
            }.padding(12).background(Theme.surface).environment(\.colorScheme, .light)
            try render(sheet, to: folder.appendingPathComponent("\(costume.rawValue).png"))
        }
        for scheme in [ColorScheme.light, .dark] {
            let view = VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 2) {
                    ForEach(BearCostume.costumes) { BearFrame(costume: $0, index: 0, size: 30).clipShape(Circle()) }
                }
                BearThinkingIndicator()
                ToolPill(name: "Salvataggio della ricetta", ok: nil)
                ToolPill(name: "Salvataggio della ricetta", ok: true)
                ToolPill(name: "Connessione al server", ok: false)
            }.padding(12).frame(width: 320).background(Theme.surface)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, .xxxLarge)
            try render(view, to: folder.appendingPathComponent("activities-\(scheme).png"))
            let monochrome = HStack(spacing: 12) {
                ForEach([0, 3, 20, 26, 34, 38], id: \.self) { frame in
                    if let image = BearAtlas.cell(costume: "mono", index: frame) {
                        BearPortraitArtwork(image: image,
                            baseline: BearAtlas.portraitBaseline(costume: "mono", index: frame, image: image), size: 40, monochrome: true)
                    }
                }
            }.padding(12).background(Color(red: 0.15, green: 0.12, blue: 0.24))
            try render(monochrome, to: folder.appendingPathComponent("lock-screen-\(scheme).png"))
        }
        let monoSheet = VStack(spacing: 8) {
            ForEach(0..<10, id: \.self) { row in
                HStack(spacing: 8) {
                    ForEach(0..<4, id: \.self) { col in
                        let index = row * 4 + col
                        if let image = BearAtlas.cell(costume: "mono", index: index) {
                            BearPortraitArtwork(image: image,
                                baseline: BearAtlas.portraitBaseline(costume: "mono", index: index, image: image),
                                size: 80, monochrome: true)
                        }
                    }
                }
            }
        }.padding(12).background(Color(red: 0.12, green: 0.1, blue: 0.2))
        try render(monoSheet, to: folder.appendingPathComponent("mono.png"))
        print("BEAR_PREVIEWS: \(folder.path)")
    }

    @Test @MainActor func nuoviCostumiInChiaroScuroEAnimazione() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-costumes-95")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for costume in [BearCostume.halloween, .borg, .jedi] {
            for scheme in [ColorScheme.light, .dark] {
                let sheet = VStack(spacing: 8) {
                    Text(costume.title).font(.headline)
                    ForEach(0..<10, id: \.self) { row in
                        HStack(spacing: 8) {
                            ForEach(0..<4, id: \.self) { col in
                                BearFrame(costume: costume, index: row * 4 + col, size: 80)
                            }
                        }
                    }
                }.padding(12).foregroundStyle(Theme.ink).background(Theme.surface).environment(\.colorScheme, scheme)
                try render(sheet, to: folder.appendingPathComponent("\(costume.rawValue)-\(scheme).png"))
            }
        }
        let url = folder.appendingPathComponent("costumes-animated.gif")
        let destination = try #require(CGImageDestinationCreateWithURL(url as CFURL, "com.compuserve.gif" as CFString, 20, nil))
        CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        for index in 20..<40 {
            let view = HStack(spacing: 18) {
                ForEach([BearCostume.halloween, .borg, .jedi]) { costume in
                    VStack {
                        BearFrame(costume: costume, index: index, size: 128)
                        Text(costume.title).font(.headline)
                    }
                }
            }.padding(20).foregroundStyle(Theme.ink).background(Theme.surface).environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try #require(renderer.cgImage)
            CGImageDestinationAddImage(destination, image, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.3]] as CFDictionary)
        }
        #expect(CGImageDestinationFinalize(destination))
        print("COSTUME_PREVIEWS: \(folder.path)")
    }

    @MainActor private func render(_ view: some View, to url: URL) throws {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        try #require(renderer.uiImage?.pngData()).write(to: url)
    }
}
