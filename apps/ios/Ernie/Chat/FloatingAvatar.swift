import SwiftUI

/// Dove si aggancia l'avatar quando lo si lascia (come il picture-in-picture): in alto al centro, angoli, lati.
enum AvatarAnchor: String, Codable, CaseIterable, Sendable {
    case top, topLeading, topTrailing, leading, trailing, bottomLeading, bottomTrailing

    var onLeadingEdge: Bool { self == .topLeading || self == .leading || self == .bottomLeading }
}

/// L'avatar galleggia sulla conversazione (proposta del 12 ott 2026, su richiesta dell'utente):
/// - trascinalo: si sposta e, lasciato, si aggancia all'ancora più vicina;
/// - toccalo: alterna badge piccolo e dimensione normale; pizzicalo: dimensione libera (72–220 pt);
/// - tienilo premuto: si nasconde in una linguetta sul bordo; un tocco sulla linguetta lo riporta;
/// - con la tastiera aperta si riduce da solo; nella linguetta l'anello colorato dice comunque cosa fa Ernie.
/// Posizione, dimensione e stato restano nelle preferenze locali.
struct FloatingAvatar: View {
    let state: AgentState
    let name: String
    let connection: ProtocolClient.ConnectionState
    let emotion: String
    let composing: Bool
    let mouthOpen: Bool
    @Environment(AppModel.self) private var model
    @State private var drag: CGSize = .zero
    @State private var pinch: CGFloat = 1

    static let minSize: CGFloat = 72
    static let maxSize: CGFloat = 180
    private let margin: CGFloat = 10

    /// Spazio da lasciare in cima alla lista quando l'avatar è agganciato in alto al centro.
    static func topInset(_ settings: LocalSettings, composing: Bool) -> CGFloat {
        guard !settings.avatarHidden, settings.avatarAnchor == .top else { return 0 }
        if composing { return 56 + 28 }
        if settings.avatarCompact { return 64 + 36 }
        return CGFloat(settings.avatarSize) + 44
    }

    static func center(for anchor: AvatarAnchor, diameter d: CGFloat, in size: CGSize, margin m: CGFloat) -> CGPoint {
        let r = d / 2 + m
        switch anchor {
        case .top: return CGPoint(x: size.width / 2, y: r)
        case .topLeading: return CGPoint(x: r, y: r)
        case .topTrailing: return CGPoint(x: size.width - r, y: r)
        case .leading: return CGPoint(x: r, y: size.height / 2)
        case .trailing: return CGPoint(x: size.width - r, y: size.height / 2)
        case .bottomLeading: return CGPoint(x: r, y: size.height - r)
        case .bottomTrailing: return CGPoint(x: size.width - r, y: size.height - r)
        }
    }

    private var diameter: CGFloat {
        let s = model.settings
        if composing { return 56 }
        if s.avatarCompact { return 64 }
        return min(max(CGFloat(s.avatarSize) * pinch, Self.minSize), Self.maxSize)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if model.settings.avatarHidden {
                    tab(in: geo.size)
                } else {
                    bubble(in: geo.size)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    private func save(_ change: () -> Void) {
        withAnimation(.spring(duration: 0.35)) { change() }
        model.settings.save()
    }

    private func bubble(in size: CGSize) -> some View {
        let d = diameter
        let base = Self.center(for: model.settings.avatarAnchor, diameter: d, in: size, margin: margin)
        let caption = d >= 90 ? AvatarCaption.text(connection: connection, state: state) : nil
        return AvatarBubble(state: state, emotion: emotion, mouthOpen: mouthOpen, size: d)
            // Si tocca e si trascina solo il cerchio: fuori, i tocchi vanno alla conversazione.
            .contentShape(Circle())
            .overlay(alignment: .bottom) {
                if let caption {
                    Text(caption)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.regularMaterial, in: Capsule())
                        .offset(y: 22)
                        .transition(.opacity)
                }
            }
            .position(x: base.x + drag.width, y: base.y + drag.height)
            .gesture(
                DragGesture(minimumDistance: 6)
                    .onChanged { drag = $0.translation }
                    .onEnded { v in
                        let dropped = CGPoint(x: base.x + v.translation.width, y: base.y + v.translation.height)
                        let nearest = AvatarAnchor.allCases.min { a, b in
                            Self.distance(Self.center(for: a, diameter: d, in: size, margin: margin), dropped)
                                < Self.distance(Self.center(for: b, diameter: d, in: size, margin: margin), dropped)
                        } ?? .top
                        save { drag = .zero; model.settings.avatarAnchor = nearest }
                    }
            )
            .simultaneousGesture(
                MagnificationGesture()
                    .onChanged { pinch = $0 }
                    .onEnded { scale in
                        let next = min(max(CGFloat(model.settings.avatarSize) * scale, Self.minSize), Self.maxSize)
                        save { pinch = 1; model.settings.avatarSize = Double(next); model.settings.avatarCompact = false }
                    }
            )
            .onTapGesture { save { model.settings.avatarCompact.toggle() } }
            .onLongPressGesture(minimumDuration: 0.6) { save { model.settings.avatarHidden = true } }
            .accessibilityLabel("\(name)\(caption.map { ", \($0)" } ?? "")")
            .accessibilityHint("Tocca per ridurre o ingrandire, trascina per spostare, tieni premuto per nascondere.")
    }

    /// Linguetta sul bordo: mezzo cerchio con l'orso, l'anello colorato segnala lo stato; un tocco riporta l'avatar.
    private func tab(in size: CGSize) -> some View {
        let anchor = model.settings.avatarAnchor
        let y = Self.center(for: anchor, diameter: 64, in: size, margin: margin).y
        let leading = anchor.onLeadingEdge
        return Button { save { model.settings.avatarHidden = false } } label: {
            AvatarBubble(state: state, emotion: emotion, mouthOpen: mouthOpen, size: 40)
                .padding(.horizontal, 6)
                .frame(width: 60, height: 60)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.35)))
                .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
        }
        .buttonStyle(.plain)
        .position(x: leading ? 22 : size.width - 22, y: y)
        .accessibilityLabel("Mostra \(name)")
    }

    private static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        ((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)).squareRoot()
    }
}
