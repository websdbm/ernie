import Foundation
import ImageIO
import UIKit

struct MediaLocation: Codable, Sendable, Equatable {
    var lat: Double
    var lon: Double
    var capturedAt: String? = nil
    var accuracy: Double? = nil
    var isValid: Bool {
        lat.isFinite && lon.isFinite && (-90...90).contains(lat) && (-180...180).contains(lon)
            && (accuracy == nil || (accuracy!.isFinite && (0...100).contains(accuracy!)))
    }
    static func cameraFix(lat: Double, lon: Double, accuracy: Double, fixAt: Date, capturedAt: Date) -> MediaLocation? {
        guard abs(fixAt.timeIntervalSince(capturedAt)) <= 30, accuracy.isFinite, (0...100).contains(accuracy) else { return nil }
        let result = MediaLocation(lat: lat, lon: lon, capturedAt: ISO8601DateFormatter().string(from: capturedAt), accuracy: accuracy)
        return result.isValid ? result : nil
    }
    /// Solo per uno scatto della fotocamera in-app: il suo orologio usa il fuso corrente.
    static func cameraDate(properties: [String: Any], now: Date = .now) -> Date {
        if let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any],
           let raw = exif[kCGImagePropertyExifDateTimeOriginal as String] as? String {
            let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX"); parser.timeZone = .current
            parser.dateFormat = "yyyy:MM:dd HH:mm:ss"
            if let date = parser.date(from: raw), abs(now.timeIntervalSince(date)) < 3600 { return date }
        }
        return now
    }
    static func read(_ data: Data) -> MediaLocation? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else { return nil }
        return read(properties: properties)
    }
    static func read(properties: [String: Any]) -> MediaLocation? {
        guard let gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any],
              let latitude = gps[kCGImagePropertyGPSLatitude as String] as? NSNumber,
              let longitude = gps[kCGImagePropertyGPSLongitude as String] as? NSNumber,
              let north = gps[kCGImagePropertyGPSLatitudeRef as String] as? String,
              let east = gps[kCGImagePropertyGPSLongitudeRef as String] as? String,
              ["N", "S"].contains(north.uppercased()), ["E", "W"].contains(east.uppercased()),
              latitude.doubleValue >= 0, longitude.doubleValue >= 0 else { return nil }
        var result = MediaLocation(lat: latitude.doubleValue * (north.uppercased() == "S" ? -1 : 1),
                                   lon: longitude.doubleValue * (east.uppercased() == "W" ? -1 : 1))
        if let precision = gps["HPositioningError"] as? NSNumber, precision.doubleValue.isFinite, precision.doubleValue >= 0 {
            result.accuracy = precision.doubleValue
        }
        // La data GPS è UTC. Un DateTimeOriginal senza fuso non viene interpretato come ora del telefono.
        if let date = gps[kCGImagePropertyGPSDateStamp as String] as? String,
           let time = gps[kCGImagePropertyGPSTimeStamp as String] as? String {
            let parser = DateFormatter(); parser.locale = Locale(identifier: "en_US_POSIX"); parser.timeZone = .gmt
            for format in ["yyyy:MM:dd HH:mm:ss", "yyyy:MM:dd HH:mm:ss.SSS"] {
                parser.dateFormat = format
                if let captured = parser.date(from: "\(date) \(time)") {
                    result.capturedAt = ISO8601DateFormatter().string(from: captured); break
                }
            }
        }
        return result.isValid ? result : nil
    }
}

/// Il JPEG pronto perde EXIF; la posizione esplicita viene conservata separatamente.
/// Una foto della libreria o di un file resta compressa (`encoded`): la riduzione legge dal file solo i pixel che
/// servono, fuori dal main (`MediaPresentation.prepare`), senza decodificare l'originale intero.
struct MediaImportPhoto: Sendable {
    enum Content: Sendable {
        case encoded(Data)
        case image(UIImage)
    }
    var content: Content
    var location: MediaLocation? = nil
    init(image: UIImage, location: MediaLocation? = nil) { self.content = .image(image); self.location = location?.isValid == true ? location : nil }
    init(data: Data) throws {
        // Solo l'intestazione: un file che non è un'immagine si scarta subito, come prima con UIImage(data:).
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0, CGImageSourceGetType(source) != nil,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              (properties[kCGImagePropertyPixelWidth as String] as? NSNumber)?.intValue ?? 0 > 0 else { throw DocumentReader.ReadError.unreadable }
        content = .encoded(data)
        location = MediaLocation.read(properties: properties)
    }
}
