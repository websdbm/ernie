#if DEBUG
import SwiftUI

/// Solo per le proposte nel simulatore (ERNIE_DEBUG_ICONS=1): le icone candidate per il pulsante Skill,
/// rese nello stesso stile del pulsante accanto al microfono.
struct IconGalleryView: View {
    private let candidates: [(String, String)] = [
        ("shield.lefthalf.filled", "scudo metà"),
        ("shield.fill", "scudo pieno"),
        ("checkmark.shield.fill", "scudo ✓"),
        ("bolt.shield.fill", "scudo fulmine"),
        ("shield.pattern.checkered", "scudo scacchi"),
        ("shield.lefthalf.filled.badge.checkmark", "scudo ✓ badge"),
        ("seal.fill", "sigillo"),
        ("hexagon.fill", "esagono"),
        ("puzzlepiece.extension.fill", "puzzle"),
        ("square.stack.3d.up.fill", "pila"),
        ("circle.hexagongrid.fill", "alveare"),
        ("wand.and.sparkles", "bacchetta"),
        ("sparkle", "stella 4"),
        ("cpu.fill", "chip"),
        ("bolt.circle.fill", "fulmine"),
        ("diamond.fill", "rombo"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 86), spacing: 12)], spacing: 16) {
                    ForEach(candidates, id: \.0) { name, caption in
                        VStack(spacing: 6) {
                            Image(systemName: name)
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                                .frame(width: 44, height: 44)
                                .background(.thinMaterial, in: Circle())
                            Text(caption).font(.caption2).foregroundStyle(.secondary)
                            Text(name).font(.system(size: 8, design: .monospaced)).foregroundStyle(.tertiary).lineLimit(1).minimumScaleFactor(0.6)
                        }
                    }
                }
                .padding()
                Divider().padding(.horizontal)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Nella barra").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(["shield.lefthalf.filled", "checkmark.shield.fill", "bolt.shield.fill", "seal.fill"], id: \.self) { name in
                        HStack(spacing: 10) {
                            Text("Scrivi, o tocca il microfono")
                                .foregroundStyle(.tertiary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14).padding(.vertical, 10)
                                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22))
                            Image(systemName: name)
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                                .frame(width: 44, height: 44)
                                .background(.thinMaterial, in: Circle())
                            Image(systemName: "mic.fill")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(.white)
                                .frame(width: 50, height: 50)
                                .background(Color.accentColor, in: Circle())
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Icone pulsante Skill")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
#endif
