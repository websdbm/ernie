import Photos
import SwiftUI
import UIKit

/// Esporta una scheda (riassunto, schema) come PDF o immagine, per condividerla o archiviarla:
/// resa fuori schermo a larghezza fissa, sfondo bianco, una sola pagina alta quanto il contenuto.
@MainActor
enum CardExport {
    static func pdf<V: View>(_ content: V, name: String, width: CGFloat = 560) -> URL? {
        let renderer = ImageRenderer(content: printable(content, width: width))
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

    static func png<V: View>(_ content: V, name: String, width: CGFloat = 560) -> URL? {
        guard let image = image(content, width: width), let data = image.pngData() else { return nil }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(fileName(name)).png")
        try? data.write(to: url, options: .atomic)
        return url
    }

    /// Immagine della scheda (per il foglio di condivisione, che così offre «Salva immagine», e per la galleria).
    static func image<V: View>(_ content: V, width: CGFloat = 560) -> UIImage? {
        let renderer = ImageRenderer(content: printable(content, width: width))
        renderer.scale = 3
        return renderer.uiImage
    }

    /// Salva nella galleria (solo aggiunta: permesso «Aggiungi foto», mai lettura). Fuori dal thread principale:
    /// Photos esegue la modifica su una propria coda, quindi la chiusura non deve essere isolata al MainActor.
    nonisolated static func saveToPhotos(_ image: UIImage) async -> Bool {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited, let data = image.pngData() else { return false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
            }
            return true
        } catch {
            return false
        }
    }

    private static func printable<V: View>(_ content: V, width: CGFloat) -> some View {
        content
            .frame(width: width, alignment: .leading)
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

/// Pulsante «Esporta» con PDF, immagine e salvataggio nella galleria, usato dalle schede.
struct ExportMenu<Content: View>: View {
    let name: String
    /// Larghezza della resa (gli schemi a frecce larghi passano la propria).
    var width: CGFloat = 560
    @ViewBuilder let content: () -> Content
    @State private var shareItems: [Any]?
    @State private var saved: Bool?

    var body: some View {
        Menu {
            Button("Salva nella galleria", systemImage: "photo.badge.plus") {
                Task {
                    if let image = CardExport.image(content(), width: width) {
                        saved = await CardExport.saveToPhotos(image)
                    } else {
                        saved = false
                    }
                    try? await Task.sleep(for: .seconds(2))
                    saved = nil
                }
            }
            Button("Condividi immagine", systemImage: "photo") {
                if let image = CardExport.image(content(), width: width) { shareItems = [image] }
            }
            Button("Condividi PDF", systemImage: "doc.richtext") {
                if let url = CardExport.pdf(content(), name: name, width: width) { shareItems = [url] }
            }
        } label: {
            if let saved {
                Label(saved ? "Salvata" : "Non salvata", systemImage: saved ? "checkmark.circle.fill" : "xmark.circle")
                    .font(.caption)
                    .foregroundStyle(saved ? Color.green : Color.red)
            } else {
                Label("Esporta", systemImage: "square.and.arrow.up").font(.caption)
            }
        }
        .sheet(isPresented: Binding(get: { shareItems != nil }, set: { if !$0 { shareItems = nil } })) {
            if let shareItems { ActivityView(items: shareItems) }
        }
    }
}
