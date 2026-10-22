import SwiftUI
import Testing
@testable import Ernie

@Suite(.serialized)
struct BearPawTapTests {
    @Test @MainActor func ditaDiverseConPolsoAncorato() throws {
        let meta = try #require(BearAtlas.metadata["paws-tap"])
        #expect(meta.count == 4)
        let frames = try (0..<4).map { try #require(BearAtlas.cell(costume: "paws-tap", index: $0)?.cgImage) }
        let reference = try #require(frames[0].dataProvider?.data) as Data
        for image in frames.dropFirst() {
            #expect(image.width == frames[0].width && image.height == frames[0].height)
            let bytes = try #require(image.dataProvider?.data) as Data
            #expect(bytes != reference, "Le dita devono muoversi davvero")
            var difference = 0, count = 0
            // Solo polso e dorso: le dita sono a sinistra. Piccole differenze di
            // texture sono ammesse, non salti di posizione o un'intera zampa che sale.
            for y in Int(Double(image.height) * 0.36)..<Int(Double(image.height) * 0.72) {
                for x in Int(Double(image.width) * 0.70)..<Int(Double(image.width) * 0.90) {
                    for channel in 0..<3 {
                        let offset = y * image.bytesPerRow + x * 4 + channel
                        difference += abs(Int(bytes[offset]) - Int(reference[offset]))
                        count += 1
                    }
                }
            }
            #expect(Double(difference) / Double(count) < 12, "Il polso deve restare registrato")
        }
        #expect(BearPawTapMotion.frame(at: 0) == BearPawTapMotion.frame(at: BearPawTapMotion.cycle - 0.001))
        for clock in [0.0, 0.4, 0.6, 0.8, 1000, .infinity, .nan] {
            #expect(BearActivityIcon.frame(status: .working, elapsed: nil, clock: clock, reduceMotion: true) == 0)
            #expect((0..<4).contains(BearPawTapMotion.frame(at: clock)))
        }
    }

    @Test @MainActor func zampaRealeSiAnimaESiFerma() async throws {
        #expect(!UIAccessibility.isReduceMotionEnabled, "Usare il simulatore di collaudo con movimento standard")
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let icon = BearActivityIcon(status: .working, size: 80)
            .frame(width: 120, height: 120).background(Color.white)
        let host = UIHostingController(rootView: icon.environment(\.scenePhase, .active))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 120, height: 120)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        func snapshot() throws -> Data {
            host.view.layoutIfNeeded()
            let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
            return try #require(renderer.image { _ in
                host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
            }.pngData())
        }
        var moving = Set<Data>()
        for _ in 0..<24 {
            try await Task.sleep(for: .milliseconds(80))
            moving.insert(try snapshot())
        }
        #expect(moving.count >= 3, "Verifica il TimelineView effettivo, non solo la funzione dei frame")
        host.rootView = icon.environment(\.scenePhase, .background)
        try await Task.sleep(for: .milliseconds(150))
        let background = try snapshot()
        try await Task.sleep(for: .milliseconds(700))
        #expect(background == (try snapshot()))
        host.rootView = icon.environment(\.scenePhase, .active)
        var resumed = Set<Data>()
        for _ in 0..<14 {
            try await Task.sleep(for: .milliseconds(80))
            resumed.insert(try snapshot())
        }
        #expect(resumed.count >= 3, "La zampa deve riprendere il gesto al ritorno in primo piano")
    }

    @Test @MainActor func anteprimaAnimataNativa() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-paw-tap-preview")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for scheme in [ColorScheme.light, .dark] {
            let output = folder.appendingPathComponent(scheme == .light ? "light" : "dark")
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            for index in 0..<66 {
                let clock = Double(index) / 20
                let frame = BearPawTapMotion.frame(at: clock)
                let legacy = try #require(BearAtlas.cell(costume: "paws", index: Int(clock / 0.22) % 4))
                let view = VStack(spacing: 18) {
                    HStack(spacing: 24) {
                        VStack(spacing: 0) {
                            Text("Prima").font(.headline)
                            Image(uiImage: legacy).resizable().interpolation(.none).scaledToFit().frame(width: 128, height: 128)
                        }
                        VStack(spacing: 0) {
                            Text("Nuova").font(.headline)
                            BearActivityArtwork(status: .working, frame: frame, size: 128)
                        }
                    }
                    HStack(spacing: 8) {
                        BearActivityArtwork(status: .working, frame: frame, size: 26)
                        Text("Ci penso…").font(.footnote)
                    }
                    HStack(spacing: 8) {
                        BearActivityArtwork(status: .working, frame: frame, size: 24)
                        Text("Consultazione degli orari").font(.footnote)
                    }.padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Theme.surfaceMuted, in: Capsule())
                }.padding(24).frame(width: 360, height: 300)
                    .foregroundStyle(Theme.ink).background(Theme.surface)
                    .environment(\.colorScheme, scheme)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                try #require(renderer.uiImage?.pngData()).write(to: output.appendingPathComponent(String(format: "%03d.png", index)))
            }
        }
        print("PAW_TAP_PREVIEW: \(folder.path)")
    }
}
