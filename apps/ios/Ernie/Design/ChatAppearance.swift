import SwiftUI

/// Preferenza del dispositivo: non modifica il tema delle altre sezioni o dei widget.
struct ChatPalette: Equatable {
    static let preferenceKey = "ernie.chat.terminal"
    var terminal = false
    static let phosphor = Color(UIColor(hex: 0x8DFFA8))
    var ground: Color { terminal ? Color(UIColor(hex: 0x050C08)) : Theme.ground }
    var surface: Color { terminal ? Color(UIColor(hex: 0x0B1C12)) : Theme.surface }
    var surfaceMuted: Color { terminal ? Color(UIColor(hex: 0x10291A)) : Theme.surfaceMuted }
    var ink: Color { terminal ? Self.phosphor : Theme.ink }
    var inkSecondary: Color { terminal ? Color(UIColor(hex: 0x9ABD9F)) : Theme.inkSecondary }
    var accent: Color { terminal ? Color(UIColor(hex: 0x286B40)) : Theme.accent }
    var accentText: Color { terminal ? Self.phosphor : Theme.accentText }
    var accentSoft: Color { terminal ? surfaceMuted : Theme.accentSoft }
    var hairline: Color { terminal ? Color(UIColor(hex: 0x386548)) : Theme.hairline }
    var glow: Color { terminal ? Color(UIColor(hex: 0x123A21)) : Theme.glow }
    var positive: Color { terminal ? Self.phosphor : Theme.positive }
    var bubbleText: Color { terminal ? Self.phosphor : .white }
    var bubble: Color { terminal ? surfaceMuted : Theme.accent }
}

private struct ChatPaletteKey: EnvironmentKey {
    static let defaultValue = ChatPalette()
}
extension EnvironmentValues {
    var chatPalette: ChatPalette {
        get { self[ChatPaletteKey.self] }
        set { self[ChatPaletteKey.self] = newValue }
    }
}

private struct ChatAppearanceModifier: ViewModifier {
    let terminal: Bool
    @Environment(\.colorScheme) private var colorScheme
    func body(content: Content) -> some View {
        content
            .environment(\.chatPalette, ChatPalette(terminal: terminal))
            .environment(\.colorScheme, terminal ? .dark : colorScheme)
            .fontDesign(terminal ? .monospaced : nil)
            .tint(terminal ? ChatPalette.phosphor : nil)
    }
}
extension View {
    func chatAppearance(terminal: Bool) -> some View {
        modifier(ChatAppearanceModifier(terminal: terminal))
    }
}

struct ChatAppearanceSettings: View {
    @AppStorage(ChatPalette.preferenceKey) private var terminal = false
    var body: some View {
        Section {
            Toggle(isOn: $terminal) {
                Label("Skin Terminale", systemImage: "terminal")
            }
            if terminal {
                HStack(spacing: 8) {
                    Text(">_").accessibilityHidden(true)
                    Text("Ernie è pronto.")
                    Rectangle().frame(width: 9, height: 16).accessibilityHidden(true)
                }
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(ChatPalette.phosphor)
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(ChatPalette(terminal: true).ground, in: RoundedRectangle(cornerRadius: 8))
            }
        } header: {
            Text("Aspetto della chat")
        } footer: {
            Text("Verde fosforo, caratteri monospaziati e cursore a blocco. Vale su questo dispositivo; disattivala per tornare all’aspetto classico.")
        }
    }
}
