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

    /// Rimuove la sintassi markdown inline più comune prima della lettura a voce.
    static func plainForSpeech(_ text: String) -> String {
        var s = text
        for token in ["**", "__", "`", "#"] { s = s.replacingOccurrences(of: token, with: "") }
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^\s*[-*•]\s+"#, with: "", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
