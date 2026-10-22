import Foundation
import ImageIO
import UIKit
import SwiftUI
import WidgetKit

/// Inquadratura unica, anche per il lock screen: la base del busto resta sotto
/// il bordo del cerchio. La scala dipende dalla larghezza, non dall'altezza delle
/// righe dell'atlas, così cappelli e gesti non fanno ingrandire/rimpicciolire il viso.
struct BearPortraitLayout {
    let imageSize: CGSize
    let baseline: CGFloat
    let size: CGFloat
    var imageRect: CGRect {
        let scale = size * 1.15 / imageSize.width
        let width = imageSize.width * scale, height = imageSize.height * scale
        return CGRect(x: (size - width) / 2, y: size * 1.025 - baseline * scale,
                      width: width, height: height)
    }
}

struct BearPortraitArtwork: View {
    let image: UIImage
    let baseline: CGFloat
    let size: CGFloat
    var monochrome = false

    var body: some View {
        Group {
            if monochrome {
                Color.white.mask { framedImage.luminanceToAlpha() }
            } else {
                // Il fondo del PNG ha piccole variazioni fra i fotogrammi: usare
                // un viola fisso renderebbe visibile il bordo superiore della cella.
                framedImage.background(BearAtlas.edgeBackground(image))
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var framedImage: some View {
        let rect = BearPortraitLayout(imageSize: image.size, baseline: baseline, size: size).imageRect
        return sprite
            .frame(width: rect.width, height: rect.height)
            .position(x: rect.midX, y: rect.midY)
            .frame(width: size, height: size)
            .clipped()
    }

    @ViewBuilder private var sprite: some View {
        if monochrome {
            Image(uiImage: image).resizable().interpolation(.none)
        } else {
            // Mantiene i colori anche con le icone Home colorate/trasparenti.
            Image(uiImage: image).resizable().interpolation(.none)
                .widgetAccentedRenderingMode(.fullColor)
        }
    }
}

/// Contratto unico per app e widget. Gli indici pubblici sono logici: alcuni fogli possono avere righe extra.
struct BearAtlasMetadata: Decodable {
    struct Insets: Decodable {
        var left: Int
        var top: Int
        var right: Int
        var bottom: Int
    }
    let file: String
    let width: Int
    let height: Int
    let columns: Int
    let rowEdges: [Int]
    let insetsByIndex: [String: Insets]?
    var frameMap: [Int]? = nil
    /// Coordinata Y della base del busto nella cella logica, prima dell'inquadratura.
    var portraitBaselines: [Int]? = nil

    // Limiti controllati prima di qualunque prodotto, conversione o decodifica PNG.
    static let maximumPixels = 8_388_608
    var nativeCount: Int {
        guard (1...16).contains(columns), (2...65).contains(rowEdges.count) else { return 0 }
        return (rowEdges.count - 1) * columns
    }
    var count: Int { frameMap?.count ?? nativeCount }
    var isValid: Bool {
        guard (1...8192).contains(width), (1...8192).contains(height), width <= Self.maximumPixels / height,
              columns > 0, columns <= width, nativeCount > 0, nativeCount <= 256,
              (1...256).contains(count), rowEdges.first! >= 0, rowEdges.last! <= height else { return false }
        for pair in zip(rowEdges, rowEdges.dropFirst()) where pair.0 >= pair.1 { return false }
        if let frameMap, !frameMap.allSatisfy({ (0..<nativeCount).contains($0) }) { return false }
        if let insetsByIndex {
            for (key, value) in insetsByIndex {
                guard let index = Int(key), (0..<count).contains(index),
                      [value.left, value.top, value.right, value.bottom].allSatisfy({ (0...8192).contains($0) }) else { return false }
            }
        }
        if let portraitBaselines {
            guard portraitBaselines.count == count else { return false }
            for (index, baseline) in portraitBaselines.enumerated() {
                let row = (frameMap?[index] ?? index) / columns
                let inset = insetsByIndex?[String(index)]
                let cellHeight = rowEdges[row + 1] - rowEdges[row] - (inset?.top ?? 0) - (inset?.bottom ?? 0)
                guard baseline > 0, baseline <= cellHeight else { return false }
            }
        }
        return true
    }

    func rect(index: Int, imageWidth: Int, imageHeight: Int) -> CGRect? {
        guard isValid, (0..<count).contains(index), imageWidth == width, imageHeight == height else { return nil }
        let physical = frameMap?[index] ?? index
        let row = physical / columns, column = physical % columns
        let inset = insetsByIndex?[String(index)]
        let x0 = (Double(column) * Double(width) / Double(columns)).rounded(.up) + Double(inset?.left ?? 0)
        let x1 = (Double(column + 1) * Double(width) / Double(columns)).rounded(.down) - Double(inset?.right ?? 0)
        let y0 = rowEdges[row] + (inset?.top ?? 0)
        let y1 = rowEdges[row + 1] - (inset?.bottom ?? 0)
        guard x0 >= 0, x1 <= Double(width), x1 > x0, y0 >= 0, y1 <= height, y1 > y0 else { return nil }
        return CGRect(x: x0, y: Double(y0), width: x1 - x0, height: Double(y1 - y0))
    }
}

/// Nessun thumbnail interpolato: si ritaglia il PNG alla risoluzione originale e si conserva soltanto la cella.
@MainActor enum BearAtlas {
    static let background = Color(red: 48 / 255, green: 32 / 255, blue: 79 / 255)
    static let metadataResource = "ernie-bear-v3-atlases"
    static let fallbackResource = "ernie-bear-v3-fallback"
    private static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 64
        cache.totalCostLimit = 4 * 1_024 * 1_024
        return cache
    }()
    static let metadata: [String: BearAtlasMetadata] = loadMetadata(bundle: .main)
    static func resource(_ name: String, extension ext: String, bundle: Bundle) -> URL? {
        bundle.url(forResource: name, withExtension: ext, subdirectory: "BearV3")
            ?? bundle.url(forResource: name, withExtension: ext)
    }
    static func loadMetadata(bundle: Bundle) -> [String: BearAtlasMetadata] {
        guard let url = resource(metadataResource, extension: "json", bundle: bundle),
              let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 65_536,
              let data = try? Data(contentsOf: url) else { return [:] }
        return decodeMetadata(data)
    }
    static func decodeMetadata(_ data: Data) -> [String: BearAtlasMetadata] {
        guard data.count <= 65_536,
              let values = try? JSONDecoder().decode([String: BearAtlasMetadata].self, from: data) else { return [:] }
        let names = ["base", "night", "classic", "aviator", "chef", "detective", "engineer", "explorer", "astronaut", "paws", "paws-tap", "mono"]
        return values.filter { name, meta in
            names.contains(name) && meta.file == "ernie-bear-v3-\(name)" && meta.isValid
                && meta.count == (name == "paws" ? 12 : (name == "paws-tap" ? 4 : 40))
                && (0..<meta.count).allSatisfy { meta.rect(index: $0, imageWidth: meta.width, imageHeight: meta.height) != nil }
        }
    }
    static func cell(costume: String, index: Int) -> UIImage? {
        guard let meta = metadata[costume], (0..<meta.count).contains(index) else { return nil }
        let key = "\(costume):\(index)" as NSString
        if let image = cache.object(forKey: key) { return image }
        guard let url = resource(meta.file, extension: "png", bundle: .main),
              let image = loadCell(url: url, metadata: meta, index: index) else { return nil }
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
        cache.setObject(image, forKey: key, cost: cost)
        return image
    }

    static func portraitBaseline(costume: String, index: Int, image: UIImage) -> CGFloat {
        guard let baselines = metadata[costume]?.portraitBaselines, baselines.indices.contains(index) else { return image.size.height }
        return CGFloat(baselines[index])
    }

    /// Le celle sono copie RGBA native. Campiona solo gli angoli superiori del
    /// margine, senza cambiare i pixel del personaggio o creare altre immagini.
    static func edgeBackground(_ image: UIImage) -> Color {
        guard let cg = image.cgImage, cg.bitsPerPixel == 32, cg.bitsPerComponent == 8,
              cg.width >= 8, let data = cg.dataProvider?.data,
              let bytes = CFDataGetBytePtr(data) else { return background }
        var r = 0, g = 0, b = 0
        for x in Array(0..<4) + Array((cg.width - 4)..<cg.width) {
            r += Int(bytes[x * 4]); g += Int(bytes[x * 4 + 1]); b += Int(bytes[x * 4 + 2])
        }
        return Color(red: Double(r) / (8 * 255), green: Double(g) / (8 * 255), blue: Double(b) / (8 * 255))
    }

    static func loadCell(url: URL, metadata meta: BearAtlasMetadata, index: Int) -> UIImage? {
        guard meta.isValid, (0..<meta.count).contains(index) else { return nil }
        return autoreleasepool {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                  CGImageSourceGetCount(source) == 1,
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
                  let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
                  width == meta.width, height == meta.height,
                  let rect = meta.rect(index: index, imageWidth: width, imageHeight: height),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
            return cropped(image, rect: rect)
        }
    }
    /// Una semplice CGImage.cropping può trattenere l'intero atlas: la copia 1:1 evita quel costo nascosto.
    static func cropped(_ image: CGImage, rect: CGRect) -> UIImage? {
        guard rect.width > 0, rect.height > 0, rect.minX >= 0, rect.minY >= 0,
              rect.maxX <= Double(image.width), rect.maxY <= Double(image.height),
              rect == rect.integral, let piece = image.cropping(to: rect),
              let context = CGContext(data: nil, width: piece.width, height: piece.height, bitsPerComponent: 8,
                                      bytesPerRow: piece.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .none
        context.setShouldAntialias(false)
        context.draw(piece, in: CGRect(x: 0, y: 0, width: piece.width, height: piece.height))
        guard let detached = context.makeImage() else { return nil }
        return UIImage(cgImage: detached, scale: 1, orientation: .up)
    }
    static let fallback: UIImage? = {
        guard let url = resource(fallbackResource, extension: "png", bundle: .main) else { return nil }
        return UIImage(contentsOfFile: url.path)
    }()
}

/// Traduzione semantica della timeline widget v1. Le azioni e la cadenza della timeline restano invariate.
enum BearWidgetArtwork {
    struct Selection: Equatable, Sendable {
        let costume: String
        let index: Int
    }
    static func selection(legacyFrame: Int) -> Selection {
        let indices = [0, 0, 0, 34, 18, 18, 20, 22, 24, 25, 26, 27, 1, 3, 6, 8,
                       10, 1, 18, 11, 12, 12, 13, 12, 9, 2, 14, 15, 32, 11, 4, 16]
        guard indices.indices.contains(legacyFrame) else { return Selection(costume: "base", index: 0) }
        let costume = [3, 28].contains(legacyFrame) ? "night" : ((16...19).contains(legacyFrame) ? "classic" : "base")
        return Selection(costume: costume, index: indices[legacyFrame])
    }
}
