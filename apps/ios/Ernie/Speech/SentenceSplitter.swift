import Foundation

/// Spezza il testo in streaming in frasi complete per la sintesi incrementale.
enum SentenceSplitter {
    private static let terminators: Set<Character> = [".", "!", "?", ":", ";", "\n"]

    /// Estrae dal buffer le frasi complete (terminatore seguito da spazio o fine riga); lascia il resto nel buffer.
    static func popSentences(from buffer: inout String, minLength: Int = 12) -> [String] {
        var sentences: [String] = []
        var start = buffer.startIndex
        var i = buffer.startIndex
        while i < buffer.endIndex {
            let ch = buffer[i]
            let next = buffer.index(after: i)
            if terminators.contains(ch), next == buffer.endIndex || buffer[next].isWhitespace {
                let candidate = buffer[start..<next].trimmingCharacters(in: .whitespacesAndNewlines)
                // Numeri come "1." o abbreviazioni molto corte restano nel buffer.
                if candidate.count >= minLength || ch == "\n" {
                    if !candidate.isEmpty { sentences.append(candidate) }
                    start = next
                }
            }
            i = next
        }
        buffer = String(buffer[start...])
        return sentences
    }

    /// Mantiene le porzioni originali (offset corretti), limita anche frasi senza punteggiatura.
    /// 1.800 unità UTF-16 rimangono sotto il limite API di 2.000, anche con emoji.
    static func popSpeechChunks(from buffer: inout String, flush: Bool = false) -> [String] {
        var result: [String] = []
        while !buffer.isEmpty {
            var boundary: String.Index?
            var units = 0
            var lastSpace: String.Index?
            for i in buffer.indices {
                let next = buffer.index(after: i)
                let ch = buffer[i]
                if units + String(ch).utf16.count > 1800 {
                    boundary = lastSpace ?? i
                    // Un singolo grafema patologico oltre il limite non si invia alla sintesi.
                    if boundary == buffer.startIndex { boundary = next }
                    break
                }
                units += String(ch).utf16.count
                if ch.isWhitespace { lastSpace = next }
                if terminators.contains(ch), next == buffer.endIndex || buffer[next].isWhitespace {
                    let candidate = buffer[..<next].trimmingCharacters(in: .whitespacesAndNewlines)
                    if candidate.count >= 12 || ch == "\n" { boundary = next; break }
                }
            }
            if boundary == nil, flush { boundary = buffer.endIndex }
            guard let boundary else { break }
            result.append(String(buffer[..<boundary]))
            buffer = String(buffer[boundary...])
        }
        return result
    }

    /// Rimuove la sintassi markdown inline più comune prima della lettura a voce.
    static func plainForSpeech(_ text: String) -> String {
        var s = Markdown.normalizingLineBreaks(text)
        for token in ["**", "__", "`", "#"] { s = s.replacingOccurrences(of: token, with: "") }
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?m)^\s*(?:[-*•]|\d+[.)])\s+"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        // Emoji e simboli pittografici non vanno letti ad alta voce.
        s = s.replacingOccurrences(of: #"[\p{Extended_Pictographic}\x{FE0F}\x{200D}]"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
