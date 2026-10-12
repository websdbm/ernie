import Foundation
import SwiftUI

enum Markdown {
    /// Solo sintassi inline (grassetto, corsivo, codice, link): nessuna immagine remota.
    static func render(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        options.failurePolicy = .returnPartiallyParsedIfPossible
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    /// Blocchi riconosciuti riga per riga: paragrafi, elenchi puntati e numerati, titoli, citazioni, codice.
    enum Block: Equatable, Identifiable {
        case paragraph(String)
        case bullets([String])
        case numbered(start: Int, [String])
        case heading(String)
        case quote(String)
        case code(String)

        var id: String {
            switch self {
            case .paragraph(let s): "p:\(s)"
            case .bullets(let l): "ul:\(l.joined(separator: "\u{1F}"))"
            case .numbered(let start, let l): "ol:\(start):\(l.joined(separator: "\u{1F}"))"
            case .heading(let s): "h:\(s)"
            case .quote(let s): "q:\(s)"
            case .code(let s): "c:\(s)"
            }
        }
    }

    /// Paragrafi lunghi (più di tre frasi) spezzati in capoversi di due o tre frasi: il testo si legge, non si subisce.
    /// Il modello è istruito a farlo da sé (Soul); qui si rimedia quando non lo fa.
    static func readable(_ paragraph: String) -> [String] {
        let sentences = split(paragraph)
        guard sentences.count > 3, paragraph.count > 220 else { return [paragraph] }
        var out: [String] = []
        var i = 0
        while i < sentences.count {
            let remaining = sentences.count - i
            let take = remaining == 4 ? 2 : min(remaining, 3) // mai una frase sola in coda
            out.append(sentences[i..<(i + take)].joined(separator: " "))
            i += take
        }
        return out
    }

    private static let abbreviations: Set<String> = ["es.", "ecc.", "dott.", "dott.ssa", "sig.", "sig.ra", "prof.", "n.", "pag.", "art.", "ca.", "p.", "pp.", "tel.", "cfr."]

    /// Frasi: dopo . ! ? seguiti da spazio e maiuscola (o virgolette/parentesi), non dopo abbreviazioni o numeri.
    static func split(_ s: String) -> [String] {
        let chars = Array(s)
        var out: [String] = []
        var current = ""
        var i = 0
        while i < chars.count {
            current.append(chars[i])
            if ".!?".contains(chars[i]), i + 1 < chars.count, chars[i + 1] == " " {
                var j = i + 1
                while j < chars.count, chars[j] == " " { j += 1 }
                if j < chars.count, chars[j].isUppercase || "«\"(".contains(chars[j]) {
                    let trimmed = current.trimmingCharacters(in: .whitespaces)
                    let lastWord = trimmed.split(separator: " ").last.map(String.init) ?? ""
                    let numberDot = chars[i] == "." && !lastWord.dropLast().isEmpty && lastWord.dropLast().allSatisfy(\.isNumber)
                    if !abbreviations.contains(lastWord.lowercased()), !numberDot {
                        out.append(trimmed)
                        current = ""
                        i = j
                        continue
                    }
                }
            }
            i += 1
        }
        let tail = current.trimmingCharacters(in: .whitespaces)
        if !tail.isEmpty { out.append(tail) }
        return out
    }

    static func blocks(_ text: String) -> [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbered: [String] = []
        var numberedStart = 1
        var code: [String]?

        func flushParagraph() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        func flushLists() {
            if !bullets.isEmpty { out.append(.bullets(bullets)); bullets = [] }
            if !numbered.isEmpty { out.append(.numbered(start: numberedStart, numbered)); numbered = [] }
        }

        for rawLine in text.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if let c = code { out.append(.code(c.joined(separator: "\n"))); code = nil } else { flushParagraph(); flushLists(); code = [] }
                continue
            }
            if code != nil { code?.append(rawLine); continue }
            if line.isEmpty { flushParagraph(); flushLists(); continue }
            if let m = line.firstMatch(of: /^[-*•]\s+(.+)$/) {
                flushParagraph()
                if !numbered.isEmpty { out.append(.numbered(start: numberedStart, numbered)); numbered = [] }
                bullets.append(String(m.1))
                continue
            }
            if let m = line.firstMatch(of: /^(\d+)[.)]\s+(.+)$/) {
                flushParagraph()
                if !bullets.isEmpty { out.append(.bullets(bullets)); bullets = [] }
                // Il numero di partenza è quello scritto nel testo: un elenco interrotto da un paragrafo non riparte da 1.
                if numbered.isEmpty { numberedStart = Int(m.1) ?? 1 }
                numbered.append(String(m.2))
                continue
            }
            if let m = line.firstMatch(of: /^#{1,6}\s+(.+)$/) {
                flushParagraph(); flushLists()
                out.append(.heading(String(m.1)))
                continue
            }
            if let m = line.firstMatch(of: /^>\s?(.*)$/) {
                flushParagraph(); flushLists()
                out.append(.quote(String(m.1)))
                continue
            }
            flushLists()
            paragraph.append(line)
        }
        if let c = code { out.append(.code(c.joined(separator: "\n"))) }
        flushParagraph()
        flushLists()
        return out
    }
}

/// Testo dell'assistente impaginato a blocchi: elenchi con puntino o numero, titoli, citazioni, codice.
struct MarkdownText: View {
    let text: String
    var font: Font = .body

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Markdown.blocks(text)) { block in
                switch block {
                case .paragraph(let s):
                    // Interlinea più ariosa e capoversi brevi: le risposte lunghe non diventano un muro di testo.
                    ForEach(Array(Markdown.readable(s).enumerated()), id: \.offset) { _, part in
                        Text(Markdown.render(part)).font(font).lineSpacing(3)
                    }
                case .heading(let s):
                    Text(Markdown.render(s)).font(.headline).padding(.top, 2)
                case .quote(let s):
                    HStack(alignment: .top, spacing: 8) {
                        RoundedRectangle(cornerRadius: 2).fill(.secondary.opacity(0.4)).frame(width: 3)
                        Text(Markdown.render(s)).font(font).foregroundStyle(.secondary)
                    }
                case .code(let s):
                    Text(s)
                        .font(.system(.footnote, design: .monospaced))
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                case .bullets(let items):
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("•").font(font)
                                Text(Markdown.render(item)).font(font)
                            }
                        }
                    }
                case .numbered(let start, let items):
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("\(start + index).").font(font).monospacedDigit()
                                Text(Markdown.render(item)).font(font)
                            }
                        }
                    }
                }
            }
        }
        .textSelection(.enabled)
    }
}
