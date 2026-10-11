import SwiftUI
import UIKit

/// Esporta una scheda (riassunto, schema) come PDF o immagine, per condividerla o archiviarla:
/// resa fuori schermo a larghezza fissa, sfondo bianco, una sola pagina alta quanto il contenuto.
@MainActor
enum CardExport {
    static func pdf<V: View>(_ content: V, name: String) -> URL? {
        let renderer = ImageRenderer(content: printable(content))
        renderer.scale = 2
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(fileName(name)).pdf")
        try? FileManager.default.removeItem(at: url)
        guard let consumer = CGDataConsumer(url: url as CFURL) else { return nil }
        var written = false
        renderer.render { size, draw in
            var box = CGRect(origin: .zero, size: size)
            guard let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return }
            ctx.beginPDFPage(nil)
            draw(ctx)
            ctx.endPDFPage()
            ctx.closePDF()
            written = true
        }
        return written ? url : nil
    }

    static func png<V: View>(_ content: V, name: String) -> URL? {
        let renderer = ImageRenderer(content: printable(content))
        renderer.scale = 3
        guard let image = renderer.uiImage, let data = image.pngData() else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(fileName(name)).png")
        try? data.write(to: url, options: .atomic)
        return url
    }

    private static func printable<V: View>(_ content: V) -> some View {
        content
            .frame(width: 560, alignment: .leading)
            .padding(28)
            .background(Color.white)
            .environment(\.colorScheme, .light)
    }

    static func fileName(_ s: String) -> String {
        let allowed = s.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == " " ? Character($0) : Character("-") }
        let base = String(allowed).trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "-")
        return base.isEmpty ? "ernie" : String(base.prefix(60))
    }
}

/// Foglio di condivisione di sistema.
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

/// Pulsante «Esporta» con PDF e immagine, usato dalle schede.
struct ExportMenu<Content: View>: View {
    let name: String
    @ViewBuilder let content: () -> Content
    @State private var shareURL: URL?

    var body: some View {
        Menu {
            Button("PDF", systemImage: "doc.richtext") { shareURL = CardExport.pdf(content(), name: name) }
            Button("Immagine", systemImage: "photo") { shareURL = CardExport.png(content(), name: name) }
        } label: {
            Label("Esporta", systemImage: "square.and.arrow.up").font(.caption)
        }
        .sheet(isPresented: Binding(get: { shareURL != nil }, set: { if !$0 { shareURL = nil } })) {
            if let shareURL { ActivityView(items: [shareURL]) }
        }
    }
}
