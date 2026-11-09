import SwiftUI
import Testing
import UIKit
@testable import Ernie

@MainActor struct ActionStyleTests {
    private func render<Content: View>(_ content: Content, width: CGFloat? = nil,
                                      costume: BearCostume = .base, scheme: ColorScheme = .light,
                                      size: DynamicTypeSize = .large) throws -> UIImage {
        let renderer = ImageRenderer(content: content
            .frame(width: width)
            .environment(\.chatPalette, ChatPalette(costume: costume))
            .environment(\.colorScheme, scheme)
            .environment(\.dynamicTypeSize, size))
        renderer.scale = 2
        return try #require(renderer.uiImage)
    }

    @Test func azioniBreviHannoAreaTattileMinimaAncheConTestoPiccolo() throws {
        for size: DynamicTypeSize in [.xSmall, .large, .accessibility3] {
            for emphasis: ErnieButtonStyle.Emphasis in [.primary, .secondary, .destructive] {
                let image = try render(Button("Sì") {}.buttonStyle(ErnieButtonStyle(emphasis: emphasis)), size: size)
                #expect(image.size.height >= 44)
                #expect(image.size.width >= 44)
            }
            let chip = try render(ErnieChip(text: "Apri", style: .suggestion), size: size)
            #expect(chip.size.height >= 44)
        }
    }

    @Test func etichetteLungheVannoACapoSenzaRidurreIlCarattere() throws {
        let short = try render(Button("Apri") {}.buttonStyle(ErnieButtonStyle(fillsWidth: true)), width: 250)
        let label = "Apri la conversazione e consulta tutti i messaggi citati nella risposta di Ernie"
        let full = try render(Button(label) {}.buttonStyle(ErnieButtonStyle(fillsWidth: true)), width: 250)
        let large = try render(Button(label) {}.buttonStyle(ErnieButtonStyle(fillsWidth: true)), width: 250, size: .accessibility3)
        #expect(full.size.width == 250)
        #expect(large.size.width == 250)
        #expect(full.size.height > short.size.height)
        #expect(large.size.height > full.size.height)
    }

    @Test func scelteLungheRestanoCompleteNelLayoutCompatto() throws {
        func card(_ label: String) -> ChoicesCard {
            ChoicesCard(block: .init(question: "Come vuoi procedere?", options: [.init(id: "one", label: label)]))
        }
        let short = try render(card("Nuovo incarico").padding(16), width: 320)
        let long = try render(card(String(repeating: "Aggiungi questa informazione al lavoro in corso. ", count: 7)).padding(16), width: 320)
        let accessible = try render(card(String(repeating: "Aggiungi questa informazione al lavoro in corso. ", count: 7)).padding(16), width: 320, size: .accessibility3)
        #expect(long.size.width == 320)
        #expect(long.size.height > short.size.height + 120)
        #expect(accessible.size.height > long.size.height)
    }

    @Test func contrastoDelleAzioniPerTuttiGliOrsiInChiaroEScuro() {
        func luminance(_ color: Color, _ style: UIUserInterfaceStyle) -> Double {
            let resolved = UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            func linear(_ value: CGFloat) -> Double {
                let v = Double(value)
                return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
            }
            return linear(red) * 0.2126 + linear(green) * 0.7152 + linear(blue) * 0.0722
        }
        func contrast(_ foreground: Color, _ background: Color, _ style: UIUserInterfaceStyle) -> Double {
            let a = luminance(foreground, style), b = luminance(background, style)
            return (max(a, b) + 0.05) / (min(a, b) + 0.05)
        }
        for costume in BearCostume.costumes {
            let palette = ChatPalette(costume: costume)
            for scheme: UIUserInterfaceStyle in [.light, .dark] {
                #expect(contrast(palette.bubbleText, palette.accent, scheme) >= 4.5, "Azione primaria: \(costume) \(scheme.rawValue)")
                #expect(contrast(palette.accentText, palette.accentSoft, scheme) >= 4.5, "Azione secondaria: \(costume) \(scheme.rawValue)")
            }
        }
    }

    @Test func anteprimeDiSchedeAzioniETestiAccessibili() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-action-style")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (name, costume, scheme, width, size): (String, BearCostume, ColorScheme, CGFloat, DynamicTypeSize) in [
            ("light", .base, .light, 390, .large),
            ("dark", .base, .dark, 390, .large),
            ("borg", .borg, .dark, 390, .large),
            ("accessible", .base, .light, 320, .accessibility3),
        ] {
            let palette = ChatPalette(costume: costume)
            let content = VStack(alignment: .leading, spacing: 16) {
                ErnieCard(icon: "calendar", tint: .brain, eyebrow: "La tua giornata", title: "Piano del pomeriggio", subtitle: "Due impegni da organizzare", action: { CardActionButton(title: "Modifica") {} }) {
                    Text("Gli impegni fissi mantengono il loro orario.").font(.body).foregroundStyle(palette.ink)
                    Button("Apri timeline", systemImage: "calendar") {}.buttonStyle(ErnieButtonStyle(emphasis: .primary, fillsWidth: true))
                    FlowLayout(spacing: 8) {
                        Button("Aggiungi attività", systemImage: "plus") {}.buttonStyle(ErnieButtonStyle())
                        Button("Annulla", role: .destructive) {}.buttonStyle(ErnieButtonStyle())
                    }
                }
                ErnieCard(icon: "books.vertical", tint: .recipes, eyebrow: "Ricetta", title: "Muffin al cioccolato") {
                    ErnieChip(text: "Dolci", systemImage: "tag")
                    Button("Mostra ingredienti e preparazione") {}.buttonStyle(ErnieButtonStyle())
                    Button("Salvataggio in corso…") {}.buttonStyle(ErnieButtonStyle(emphasis: .primary)).disabled(true)
                }
            }.padding(16).background(palette.ground)
            let image = try render(content, width: width, costume: costume, scheme: scheme, size: size)
            #expect(image.size.width == width)
            let destination = folder.appendingPathComponent("\(name).png")
            try #require(image.pngData()).write(to: destination)
            print("ACTION_STYLE_SNAPSHOT: \(destination.path)")
        }
    }
}
