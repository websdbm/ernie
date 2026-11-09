import SwiftUI
import UIKit

/// Sistema visivo comune (nuova interfaccia, 13 ott 2026, bozzetti approvati dall'utente): fondo lilla tenue,
/// superfici bianche, viola come accento, un colore per ogni skill, titoli in carattere arrotondato, barre in vetro.
/// Ogni colore ha la sua variante per il tema scuro.
enum Theme {
    // MARK: colori di base

    /// Fondo delle schermate (lilla tenue; quasi nero viola di sera).
    static let ground = dynamic(light: 0xF5F3FA, dark: 0x121019)
    /// Superficie delle schede.
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x1E1A2B)
    /// Superficie secondaria (chip, campi, celle).
    static let surfaceMuted = dynamic(light: 0xF1EEF8, dark: 0x2A2539)
    static let ink = dynamic(light: 0x1B1730, dark: 0xF2EFFA)
    static let inkSecondary = dynamic(light: 0x5E5873, dark: 0xB3ABC9)
    static let hairline = dynamic(light: 0xECE8F4, dark: 0x332D45)
    /// Accento (pulsanti pieni, fumetti dell'utente): con il testo bianco sopra il contrasto regge in entrambi i temi.
    static let accent = dynamic(light: 0x5B3FD9, dark: 0x6D4FF0)
    /// Accento per testo e icone su superficie (più chiaro di sera).
    static let accentText = dynamic(light: 0x45309F, dark: 0xB9A8FF)
    static let accentSoft = dynamic(light: 0xEEE9FF, dark: 0x2E2650)
    /// Alone dietro l'orso.
    static let glow = dynamic(light: 0xE6DEFF, dark: 0x3B2A8C)
    static let positive = dynamic(light: 0x16A34A, dark: 0x86EFAC)

    // MARK: caratteri

    /// Titoli: SF Rounded, in tono con l'orso.
    static func title(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }
    /// Etichetta maiuscola delle schede («PROMEMORIA IMPOSTATO»).
    static let eyebrow = Font.caption.weight(.semibold)
    static let cardTitle = Font.system(.headline, design: .rounded, weight: .bold)
    static let actionFont = Font.subheadline.weight(.semibold)
    static let actionHeight: CGFloat = 44
    static let actionRadius: CGFloat = 12

    // MARK: forme e ombre

    static let cardRadius: CGFloat = 22
    static let chipRadius: CGFloat = 999

    static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

/// Colore di ogni skill: icona, etichetta e tinta tenue dello sfondo dell'icona.
enum SkillTint {
    case reminders, recipes, documents, brain, health, sentinels, shopping, neutral

    var color: Color {
        switch self {
        case .reminders: Theme.dynamic(light: 0xC2410C, dark: 0xFDBA74)
        case .recipes: Theme.dynamic(light: 0x15803D, dark: 0x86EFAC)
        case .documents: Theme.dynamic(light: 0x1D5FC2, dark: 0x93C5FD)
        case .brain: Theme.dynamic(light: 0x5B3FD9, dark: 0xB9A8FF)
        case .health: Theme.dynamic(light: 0xBE185D, dark: 0xF9A8D4)
        case .sentinels: Theme.dynamic(light: 0x0F766E, dark: 0x5EEAD4)
        case .shopping: Theme.dynamic(light: 0xA16207, dark: 0xFDE047)
        case .neutral: Theme.inkSecondary
        }
    }

    var soft: Color {
        switch self {
        case .reminders: Theme.dynamic(light: 0xFFEDE3, dark: 0x3A2418)
        case .recipes: Theme.dynamic(light: 0xE5F4EA, dark: 0x16301F)
        case .documents: Theme.dynamic(light: 0xE3EEFD, dark: 0x172A45)
        case .brain: Theme.dynamic(light: 0xEEE9FF, dark: 0x2E2650)
        case .health: Theme.dynamic(light: 0xFCE4EE, dark: 0x3D1A2B)
        case .sentinels: Theme.dynamic(light: 0xDDF3F0, dark: 0x123330)
        case .shopping: Theme.dynamic(light: 0xFEF3C7, dark: 0x3A2F10)
        case .neutral: Theme.surfaceMuted
        }
    }
}

/// Icona della skill in un riquadro arrotondato con la tinta tenue.
struct SkillIcon: View {
    let systemName: String
    let tint: SkillTint
    var size: CGFloat = 32

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(tint.color)
            .frame(width: size, height: size)
            .background(tint.soft, in: RoundedRectangle(cornerRadius: size * 0.31, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// La scheda comune: intestazione con icona della skill, etichetta maiuscola (o titolo), azione facoltativa a destra,
/// poi il contenuto. Stessi margini, angoli e ombra per tutte le schede della chat.
struct ErnieCard<Content: View, Action: View>: View {
    @Environment(\.chatPalette) private var palette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let icon: String
    let tint: SkillTint
    let eyebrow: String
    var title: String?
    var subtitle: String?
    @ViewBuilder var action: () -> Action
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) {
                    heading
                    action()
                }
            } else {
                HStack(alignment: .center, spacing: 10) {
                    heading
                    Spacer(minLength: 4)
                    action()
                }
            }
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ernieSurface()
    }

    private var heading: some View {
        HStack(alignment: .top, spacing: 10) {
            SkillIcon(systemName: icon, tint: tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(eyebrow.uppercased())
                    .font(Theme.eyebrow)
                    .kerning(0.4)
                    .foregroundStyle(tint.color)
                    .fixedSize(horizontal: false, vertical: true)
                if let title, !title.isEmpty {
                    Text(title)
                        .font(palette.terminal ? .headline.monospaced() : Theme.cardTitle)
                        .foregroundStyle(palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(palette.inkSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

extension ErnieCard where Action == EmptyView {
    init(icon: String, tint: SkillTint, eyebrow: String, title: String? = nil, subtitle: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.init(icon: icon, tint: tint, eyebrow: eyebrow, title: title, subtitle: subtitle, action: { EmptyView() }, content: content)
    }
}

extension View {
    /// Superficie delle schede: bianca con ombra morbida (di sera: viola scuro con filo chiaro).
    func ernieSurface(radius: CGFloat = Theme.cardRadius) -> some View {
        modifier(ChatSurfaceModifier(radius: radius))
    }

    /// Vetro (Liquid Glass di iOS 26) per barre e pulsanti che galleggiano sul contenuto.
    func ernieGlass<S: Shape>(in shape: S) -> some View {
        modifier(ChatGlassModifier(shape: shape))
    }
}

/// Azione riconoscibile anche senza il colore: superficie, bordo e area tattile minima.
struct CardActionButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(title, action: action)
            .buttonStyle(ErnieButtonStyle())
    }
}

/// Stesso linguaggio per le azioni dentro schede e pagine. Le righe di navigazione mantengono il loro chevron;
/// i pulsanti di toolbar, menu e dialoghi conservano lo stile nativo del sistema.
struct ErnieButtonStyle: ButtonStyle {
    enum Emphasis { case primary, secondary, destructive }
    var emphasis: Emphasis = .secondary
    var fillsWidth = false
    @Environment(\.chatPalette) private var palette
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorSchemeContrast) private var contrast

    func makeBody(configuration: Configuration) -> some View {
        let destructive = emphasis == .destructive || configuration.role == .destructive
        let warning = Theme.dynamic(light: 0xA61B1B, dark: 0xFFB4B4)
        let foreground = destructive ? warning : emphasis == .primary ? palette.bubbleText : palette.accentText
        let background = destructive ? Theme.dynamic(light: 0xFDECEC, dark: 0x351A20) : emphasis == .primary ? palette.accent : palette.accentSoft
        let shape = RoundedRectangle(cornerRadius: Theme.actionRadius, style: .continuous)
        return configuration.label
            .font(Theme.actionFont)
            .fontDesign(palette.terminal ? .monospaced : .default)
            .multilineTextAlignment(.center)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minWidth: Theme.actionHeight, maxWidth: fillsWidth ? .infinity : nil, minHeight: Theme.actionHeight)
            .foregroundStyle(foreground)
            .background(background, in: shape)
            .overlay(shape.strokeBorder(destructive ? warning.opacity(0.45) : palette.accentText.opacity(contrast == .increased ? 0.7 : 0.3), lineWidth: contrast == .increased ? 2 : 1))
            .contentShape(shape)
            .opacity(!enabled ? 0.48 : configuration.isPressed ? 0.72 : 1)
    }
}

/// Chip: neutro (dati), selezionato (accento tenue) o suggerimento toccabile (bordo accento).
struct ErnieChip: View {
    @Environment(\.chatPalette) private var palette
    enum Style { case neutral, selected, suggestion, tinted(SkillTint) }
    let text: String
    var systemImage: String?
    var style: Style = .neutral

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage { Image(systemName: systemImage).font(.caption.weight(.semibold)) }
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
        .font(isAction ? Theme.actionFont : .subheadline)
        .foregroundStyle(foreground)
        .padding(.horizontal, isAction ? 14 : 12)
        .padding(.vertical, isAction ? 10 : 7)
        .frame(minHeight: isAction ? Theme.actionHeight : nil)
        .background {
            if isAction {
                RoundedRectangle(cornerRadius: Theme.actionRadius, style: .continuous).fill(background)
            } else {
                Capsule().fill(background)
            }
        }
        .overlay {
            if isAction { RoundedRectangle(cornerRadius: Theme.actionRadius, style: .continuous).strokeBorder(palette.accentText.opacity(0.3)) }
        }
    }

    private var isAction: Bool { if case .suggestion = style { true } else { false } }

    private var foreground: Color {
        switch style {
        case .neutral: palette.ink
        case .selected, .suggestion: palette.accentText
        case .tinted(let t): t.color
        }
    }

    private var background: Color {
        switch style {
        case .neutral: palette.surfaceMuted
        case .selected, .suggestion: palette.accentSoft
        case .tinted(let t): t.soft
        }
    }
}

/// Pulsante tondo in vetro (barra in alto, azioni secondarie).
struct GlassCircleButton: View {
    let systemName: String
    var tint: Color = Theme.ink
    var size: CGFloat = 44
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .ernieGlass(in: Circle())
        .accessibilityLabel(label)
    }
}

/// Questi modificatori leggono l'ambiente: fuori dalla chat restano identici.
private struct ChatSurfaceModifier: ViewModifier {
    @Environment(\.chatPalette) private var palette
    let radius: CGFloat
    func body(content: Content) -> some View {
        content.background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(palette.surface)
                .shadow(color: .black.opacity(0.05), radius: 12, y: 6)
                .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
        )
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous)
            .strokeBorder(palette.hairline.opacity(palette.terminal ? 1 : 0.6), lineWidth: palette.terminal ? 1 : 0.5))
    }
}

private struct ChatGlassModifier<S: Shape>: ViewModifier {
    @Environment(\.chatPalette) private var palette
    let shape: S
    @ViewBuilder func body(content: Content) -> some View {
        if palette.terminal {
            content.background(palette.surface, in: shape)
                .overlay(shape.stroke(palette.hairline, lineWidth: 1).allowsHitTesting(false))
        } else {
            content.glassEffect(.regular, in: shape)
        }
    }
}
