import CryptoKit
import Foundation
import ImageIO
import Observation
import UIKit
import UniformTypeIdentifiers

struct SavedMedia: Codable, Sendable, Identifiable, Equatable {
    var id: String
    var title: String
    var description: String
    var category: String
    var tags: [String]
    var width: Int
    var height: Int
    var source: String
    var organization: String
    var version: Int
    var createdAt: String
    var updatedAt: String
    var location: MediaLocation? = nil
    var aspectRatio: CGFloat { CGFloat(max(1, width)) / CGFloat(max(1, height)) }
    var displayAspectRatio: CGFloat { min(4, max(0.25, aspectRatio)) }
    var year: String {
        let parser = ISO8601DateFormatter(); parser.formatOptions.insert(.withFractionalSeconds)
        guard let date = parser.date(from: createdAt) ?? ISO8601DateFormatter().date(from: createdAt) else { return String(createdAt.prefix(4)) }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Europe/Rome") ?? .gmt
        return String(calendar.component(.year, from: date))
    }
}
struct MediaPage: Codable, Sendable {
    struct Facet: Codable, Sendable, Identifiable { var value: String; var count: Int; var id: String { value } }
    struct Year: Codable, Sendable, Identifiable { var value: Int; var count: Int; var id: Int { value } }
    var items: [SavedMedia]
    var total: Int
    var offset: Int
    var limit: Int
    var categories: [Facet]
    var tags: [Facet]
    var years: [Year]
}
struct MediaQuery: Hashable, Sendable {
    var search = ""
    var category: String?
    var tag: String?
    var year: Int?
    var isFiltered: Bool { !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || category != nil || tag != nil || year != nil }
    func path(offset: Int = 0) -> String {
        var c = URLComponents()
        c.path = "/v1/media"
        c.queryItems = [.init(name: "limit", value: "30"), .init(name: "offset", value: String(max(0, offset)))]
        let text = search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { c.queryItems?.append(.init(name: "q", value: text)) }
        if let category { c.queryItems?.append(.init(name: "category", value: category)) }
        if let tag { c.queryItems?.append(.init(name: "tag", value: tag)) }
        if let year { c.queryItems?.append(.init(name: "year", value: String(year))) }
        c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return c.string ?? "/v1/media"
    }
}
struct MediaUpload: Sendable {
    var clientId = UUID().uuidString
    var data: Data
    var source: String
    var ocrText = ""
    var autoOrganize = true
    var location: MediaLocation? = nil
}
extension ApiClient {
    func media(_ query: MediaQuery, offset: Int = 0) async throws -> MediaPage { try await request("GET", query.path(offset: offset)) }
    func mediaItem(_ id: String) async throws -> SavedMedia {
        struct Out: Decodable { var item: SavedMedia }
        let out: Out = try await request("GET", "/v1/media/\(id)")
        return out.item
    }
    @MainActor func beginMediaUpload(_ upload: MediaUpload) throws -> MediaUploadHandle {
        if usesBackgroundMedia { return try MediaUploadQueue.shared.enqueue(upload, credentials: credentials) }
        let task = Task { try await uploadMedia(upload) }
        return MediaUploadHandle(id: upload.clientId, value: { try await task.value }, cancel: { task.cancel() })
    }
    func uploadMedia(_ upload: MediaUpload) async throws -> SavedMedia {
        if usesBackgroundMedia { return try await beginMediaUpload(upload).value() }
        struct Body: Encodable, Sendable { var clientId: String; var data: String; var source: String; var ocrText: String; var autoOrganize: Bool; var location: MediaLocation? }
        struct Out: Decodable { var item: SavedMedia }
        let body = Body(clientId: upload.clientId, data: upload.data.base64EncodedString(), source: upload.source, ocrText: String(upload.ocrText.prefix(60_000)), autoOrganize: upload.autoOrganize, location: upload.location?.isValid == true ? upload.location : nil)
        for attempt in 0..<3 {
            try Task.checkCancellation()
            do {
                let result: Out = try await request("POST", "/v1/media", body: body)
                return result.item
            } catch {
                let transient = (error as? ApiError).map { [408, 429, 502, 503, 504].contains($0.status) } ?? (error is URLError)
                guard attempt < 2, transient, !Task.isCancelled else { throw error }
                try await Task.sleep(for: .milliseconds(400 * (attempt + 1)))
            }
        }
        throw URLError(.cannotLoadFromNetwork)
    }
    func updateMedia(_ item: SavedMedia) async throws -> SavedMedia {
        struct Body: Encodable, Sendable { var title: String; var description: String; var category: String; var tags: [String]; var version: Int }
        struct Out: Decodable { var item: SavedMedia }
        let result: Out = try await request("PATCH", "/v1/media/\(item.id)", body: Body(title: item.title, description: item.description, category: item.category, tags: item.tags, version: item.version))
        return result.item
    }
    func deleteMedia(_ id: String) async throws { try await requestNoContent("DELETE", "/v1/media/\(id)") }
}

enum MediaPresentation {
    static let categories = ["Foto", "Documenti", "Ricette", "Ispirazioni", "Viaggi", "Casa", "Lavoro", "Altro"]
    static func tags(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
    static func error(_ error: Error) -> String {
        if let api = error as? ApiError {
            if api.status == 404 { return "Questa immagine non è più nella raccolta." }
            if api.status == 409 { return "La scheda è cambiata nel frattempo. Riaprila prima di salvare di nuovo." }
            if api.status == 413 { return api.message }
            if api.status == 403 { return "Non hai accesso a questa raccolta." }
        }
        return "Non riesco a completare l’operazione. Controlla la connessione e riprova."
    }
    /// Assegna le schede alla colonna più corta; nuove pagine non spostano le immagini precedenti.
    static func columns(_ items: [SavedMedia], count: Int, width: CGFloat) -> [[SavedMedia]] {
        let count = max(1, count)
        var result = Array(repeating: [SavedMedia](), count: count)
        var heights = Array(repeating: CGFloat.zero, count: count)
        for item in items {
            let index = heights.indices.min(by: { heights[$0] < heights[$1] }) ?? 0
            result[index].append(item)
            heights[index] += width / item.displayAspectRatio + 110
        }
        return result
    }
    /// Lato massimo del JPEG caricato.
    static let maxPixelSize = 2400

    /// JPEG ridotto, orientamento applicato e metadati EXIF rimossi prima del caricamento, sempre fuori dal main:
    /// decodificare e ricodificare una foto intera durante l'aggiornamento della scena faceva intervenire il
    /// watchdog (0x8BADF00D, build 97–98).
    static func prepare(_ photo: MediaImportPhoto) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            switch photo.content {
            case .encoded(let data): try MediaPresentation.prepare(data: data)
            case .image(let image): try MediaPresentation.prepare(image)
            }
        }.value
    }

    /// Dal file compresso: ImageIO legge solo i pixel della miniatura (lato massimo 2400) e applica l'orientamento,
    /// senza decodificare l'originale intero. Da chiamare fuori dal main.
    static func prepare(data: Data) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0 else { throw DocumentReader.ReadError.unreadable }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              thumbnail.width > 0, thumbnail.height > 0 else { throw DocumentReader.ReadError.unreadable }
        // Sfondo bianco per le immagini trasparenti (PNG, HEIC con alfa), come la versione con UIImage.
        let width = thumbnail.width, height = thumbnail.height
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw DocumentReader.ReadError.unreadable }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1)); context.fill(rect)
        context.interpolationQuality = .high
        context.draw(thumbnail, in: rect)
        guard let flattened = context.makeImage() else { throw DocumentReader.ReadError.unreadable }
        for quality in [0.82, 0.65, 0.45] {
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { break }
            // Nessun dizionario EXIF/GPS: solo la qualità di compressione.
            CGImageDestinationAddImage(destination, flattened, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            if CGImageDestinationFinalize(destination), output.length <= 3_000_000 { return output as Data }
        }
        throw ApiError(status: 413, code: "image_too_large", message: "Questa foto è troppo grande. Scegline una più piccola.")
    }

    /// Da un'immagine già in memoria (fotocamera, scansione). Sicura fuori dal main.
    static func prepare(_ image: UIImage) throws -> Data {
        let size = image.size
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { throw DocumentReader.ReadError.unreadable }
        let scale = min(1, 2400 / max(size.width, size.height))
        let target = CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1; format.opaque = true
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(origin: .zero, size: target))
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        for quality in [0.82, 0.65, 0.45] {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= 3_000_000 { return data }
        }
        throw ApiError(status: 413, code: "image_too_large", message: "Questa foto è troppo grande. Scegline una più piccola.")
    }
}

@MainActor @Observable final class MediaLibraryStore {
    typealias Loader = @MainActor (MediaQuery, Int) async throws -> MediaPage
    private(set) var items: [SavedMedia] = []
    private(set) var categories: [MediaPage.Facet] = []
    private(set) var tags: [MediaPage.Facet] = []
    private(set) var years: [MediaPage.Year] = []
    private(set) var total = 0
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var error: String?
    private(set) var hasMore = false
    private var query = MediaQuery()
    private var offset = 0
    private var generation = UUID()
    private var task: Task<MediaPage, any Error>?
    func load(_ query: MediaQuery, append: Bool = false, debounce: Bool = false, using loader: @escaping Loader) async {
        if append && (loading || !hasMore || query != self.query) { return }
        let token = UUID(); generation = token
        task?.cancel(); task = nil
        if query != self.query { items = []; total = 0; offset = 0; loaded = false; hasMore = false }
        self.query = query; loading = true; error = nil
        let pageOffset = append ? offset : 0
        do {
            if debounce { try await Task.sleep(for: .milliseconds(300)) }
            try Task.checkCancellation()
            let request = Task { try await loader(query, pageOffset) }; task = request
            let page = try await withTaskCancellationHandler(operation: { try await request.value }, onCancel: { request.cancel() })
            guard token == generation else { return }
            task = nil
            guard !Task.isCancelled else { loading = false; return }
            var seen = Set<String>()
            items = (append ? items + page.items : page.items).filter { seen.insert($0.id).inserted }
            categories = page.categories; tags = page.tags; years = page.years; total = page.total
            offset = page.offset + page.items.count; hasMore = !page.items.isEmpty && offset < total
            loaded = true; loading = false
        } catch {
            guard token == generation else { return }
            task = nil; loading = false
            if !Task.isCancelled, !(error is CancellationError) { self.error = MediaPresentation.error(error) }
        }
    }
    func cancel() { generation = UUID(); task?.cancel(); task = nil; loading = false }
}

@MainActor enum MediaImageCache {
    private static let memory: NSCache<NSString, UIImage> = { let cache = NSCache<NSString, UIImage>(); cache.totalCostLimit = 32_000_000; cache.countLimit = 100; return cache }()
    private static var generation = UUID()
    static func clear() { generation = UUID(); memory.removeAllObjects() }
    static func image(_ id: String, thumbnail: Bool = true, api: ApiClient) async throws -> UIImage {
        let token = generation
        let identity = "\(api.credentials.serverURL.absoluteString)|\(api.credentials.apiKey)|\(id)|\(thumbnail)"
        let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined() as NSString
        if let image = memory.object(forKey: key) { return image }
        let data = try await api.mediaImageData(id, thumbnail: thumbnail)
        try Task.checkCancellation()
        guard token == generation else { throw CancellationError() }
        guard let image = UIImage(data: data) else { throw DocumentReader.ReadError.unreadable }
        memory.setObject(image, forKey: key, cost: (image.cgImage?.width ?? 1) * (image.cgImage?.height ?? 1) * 4)
        return image
    }
}
