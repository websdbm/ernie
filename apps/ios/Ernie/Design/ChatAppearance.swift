import SwiftUI

/// Ogni costume ha lo stesso repertorio: 20 espressioni e 5 gesti da 4 fotogrammi.
/// Il costume e il fotogramma sono indipendenti: parlare o starnutire non toglie il cappello.
enum BearCostume: String, CaseIterable, Identifiable, Sendable {
    case automatic, base, night, classic, aviator, chef, detective, engineer, explorer, astronaut
    case halloween, borg, jedi
    var id: String { rawValue }
    static let preferenceKey = "ernie.bearCostume"
    static var costumes: [Self] { allCases.filter { $0 != .automatic } }
    var title: String {
        switch self {
        case .automatic: "Automatico"
        case .base: "Ernie classico"
        case .night: "Cappello da notte"
        case .classic: "Occhiali scuri"
        case .aviator: "Occhiali da aviatore"
        case .chef: "Cuoco"
        case .detective: "Detective"
        case .engineer: "Tecnico"
        case .explorer: "Esploratore"
        case .astronaut: "Astronauta"
        case .halloween: "Halloween"
        case .borg: "Borg"
        case .jedi: "Jedi"
        }
    }

    static func resolve(choice: String, hour: Int, tools: [String], emotion: String) -> Self {
        if let chosen = Self(rawValue: choice), chosen != .automatic { return chosen }
        for tool in tools.reversed() {
            if tool.hasPrefix("recipe") || tool.hasPrefix("shopping_") { return .chef }
            if tool.hasPrefix("ssh_") || tool.hasPrefix("server_") || tool.hasPrefix("wp_") { return .engineer }
            if tool.hasPrefix("place_") || tool.hasPrefix("weather") { return .explorer }
            if tool.contains("search") || tool == "web_fetch" { return .detective }
        }
        if hour >= 21 || hour < 7 { return .night }
        if emotion.lowercased() == "cool" { return hour < 15 ? .classic : .aviator }
        return .base
    }
}


/// La palette segue l'avatar effettivamente mostrato. Nessuna preferenza Terminale separata.
struct ChatPalette: Equatable {
    var costume: BearCostume = .base
    var terminal: Bool { costume == .borg }
    // Anche le anteprime e i test precedenti passano per le stesse due palette.
    init(costume: BearCostume = .base) { self.costume = costume == .automatic ? .base : costume }
    init(terminal: Bool) { self.init(costume: terminal ? .borg : .base) }
    static let phosphor = Color(UIColor(hex: 0x8DFFA8))
    private var classic: Bool { costume == .base }
    var description: String {
        switch costume {
        case .automatic: "Segue il costume di Ernie"
        case .base: "Viola e lilla"
        case .night: "Indaco e lavanda"
        case .classic: "Grafite e menta"
        case .aviator: "Petrolio e rame"
        case .chef: "Crema e terracotta"
        case .detective: "Seppia e ambra"
        case .engineer: "Ardesia e ciano"
        case .explorer: "Bosco e salvia"
        case .astronaut: "Blu spazio e ghiaccio"
        case .halloween: "Prugna e arancio"
        case .borg: "Terminale · verde fosforo"
        case .jedi: "Sabbia e verde"
        }
    }
    // Colore delle superfici, accento pieno leggibile con testo bianco, accento chiaro.
    private var colors: (hue: CGFloat, accent: UInt32, bright: UInt32) {
        switch costume {
        case .night: (0.66, 0x454DA0, 0xB8B8FF)
        case .classic: (0.45, 0x226B58, 0x8DE2BB)
        case .aviator: (0.53, 0x95532F, 0xF4BA8B)
        case .chef: (0.09, 0xA13E2A, 0xFFA88F)
        case .detective: (0.10, 0x805713, 0xE8C17A)
        case .engineer: (0.56, 0x12657C, 0x79D8EF)
        case .explorer: (0.30, 0x36633C, 0xABD39D)
        case .astronaut: (0.62, 0x345AA9, 0xA7CEFF)
        case .halloween: (0.79, 0xA34516, 0xFFB064)
        case .jedi: (0.12, 0x366A46, 0xA5E3A6)
        default: (0.71, 0x5B3FD9, 0xB9A8FF)
        }
    }
    private func tone(_ saturation: CGFloat, _ brightness: CGFloat,
                      _ darkSaturation: CGFloat, _ darkBrightness: CGFloat) -> Color {
        let hue = colors.hue
        return Color(UIColor { traits in
            UIColor(hue: hue,
                    saturation: traits.userInterfaceStyle == .dark ? darkSaturation : saturation,
                    brightness: traits.userInterfaceStyle == .dark ? darkBrightness : brightness, alpha: 1)
        })
    }
    var ground: Color { terminal ? Color(UIColor(hex: 0x050C08)) : classic ? Theme.ground : tone(0.045, 0.985, 0.35, 0.075) }
    var surface: Color { terminal ? Color(UIColor(hex: 0x0B1C12)) : classic ? Theme.surface : tone(0.008, 1, 0.25, 0.13) }
    var surfaceMuted: Color { terminal ? Color(UIColor(hex: 0x10291A)) : classic ? Theme.surfaceMuted : tone(0.09, 0.96, 0.30, 0.20) }
    var ink: Color { terminal ? Self.phosphor : classic ? Theme.ink : tone(0.35, 0.14, 0.04, 0.98) }
    var inkSecondary: Color { terminal ? Color(UIColor(hex: 0x9ABD9F)) : classic ? Theme.inkSecondary : tone(0.20, 0.36, 0.12, 0.78) }
    var accent: Color { terminal ? Color(UIColor(hex: 0x286B40)) : classic ? Theme.accent : Color(UIColor(hex: colors.accent)) }
    var accentText: Color { terminal ? Self.phosphor : classic ? Theme.accentText : Theme.dynamic(light: colors.accent, dark: colors.bright) }
    var accentSoft: Color { terminal ? surfaceMuted : classic ? Theme.accentSoft : tone(0.14, 0.97, 0.40, 0.22) }
    var hairline: Color { terminal ? Color(UIColor(hex: 0x386548)) : classic ? Theme.hairline : tone(0.13, 0.86, 0.25, 0.30) }
    var glow: Color { terminal ? Color(UIColor(hex: 0x123A21)) : classic ? Theme.glow : tone(0.18, 0.96, 0.55, 0.28) }
    var positive: Color { terminal ? Self.phosphor : Theme.positive }
    var bubbleText: Color { terminal ? Self.phosphor : .white }
    var bubble: Color { terminal ? surfaceMuted : accent }
}

private struct ChatPaletteKey: EnvironmentKey {
    static let defaultValue = ChatPalette()
}
private struct ResolvedBearCostumeKey: EnvironmentKey {
    static let defaultValue: BearCostume? = nil
}
extension EnvironmentValues {
    var chatPalette: ChatPalette {
        get { self[ChatPaletteKey.self] }
        set { self[ChatPaletteKey.self] = newValue }
    }
    var resolvedBearCostume: BearCostume? {
        get { self[ResolvedBearCostumeKey.self] }
        set { self[ResolvedBearCostumeKey.self] = newValue }
    }
}

private struct ChatAppearanceModifier: ViewModifier {
    let costume: BearCostume
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        let palette = ChatPalette(costume: costume)
        content
            .environment(\.chatPalette, palette)
            .environment(\.resolvedBearCostume, palette.costume)
            .environment(\.colorScheme, palette.terminal ? .dark : colorScheme)
            .fontDesign(palette.terminal ? .monospaced : nil)
            .tint(palette.accentText)
    }
}
extension View {
    func chatAppearance(costume: BearCostume) -> some View {
        modifier(ChatAppearanceModifier(costume: costume))
    }
    func chatAppearance(terminal: Bool) -> some View {
        chatAppearance(costume: terminal ? .borg : .base)
    }
}

struct ChatAppearanceSettings: View {
    @AppStorage(BearCostume.preferenceKey) private var choice = BearCostume.automatic.rawValue
    private var selected: BearCostume { BearCostume(rawValue: choice) ?? .automatic }
    var body: some View {
        Section {
            Picker("Orso e palette", selection: $choice) {
                ForEach(BearCostume.allCases) { costume in Text(costume.title).tag(costume.rawValue) }
            }
            if selected != .automatic {
                let palette = ChatPalette(costume: selected)
                HStack(spacing: 10) {
                    Circle().fill(palette.accentText).frame(width: 18, height: 18)
                    Text(palette.description).foregroundStyle(palette.ink)
                }
                .font(.callout).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.ground, in: RoundedRectangle(cornerRadius: 8))
            }
        } header: {
            Text("Aspetto di Ernie")
        } footer: {
            Text("Ogni orso ha la sua palette per la chat. Borg usa il terminale verde con cursore a blocco. In Automatico, colori e avatar seguono insieme l’attività e l’ora. La scelta vale su questo dispositivo.")
        }
    }
}
