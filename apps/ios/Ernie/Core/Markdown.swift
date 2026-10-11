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
        case numbered([String])
        case heading(String)
        case quote(String)
        case code(String)

        var id: String {
            switch self {
            case .paragraph(let s): "p:\(s)"
            case .bullets(let l): "ul:\(l.joined(separator: "\u{1F}"))"
            case .numbered(let l): "ol:\(l.joined(separator: "\u{1F}"))"
            case .heading(let s): "h:\(s)"
            case .quote(let s): "q:\(s)"
            case .code(let s): "c:\(s)"
            }
        }
    }

    static func blocks(_ text: String) -> [Block] {
        var out: [Block] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbered: [String] = []
        var code: [String]?

        func flushParagraph() {
            if !paragraph.isEmpty { out.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        func flushLists() {
            if !bullets.isEmpty { out.append(.bullets(bullets)); bullets = [] }
            if !numbered.isEmpty { out.append(.numbered(numbered)); numbered = [] }
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
                if !numbered.isEmpty { out.append(.numbered(numbered)); numbered = [] }
                bullets.append(String(m.1))
                continue
            }
            if let m = line.firstMatch(of: /^\d+[.)]\s+(.+)$/) {
                flushParagraph()
                if !bullets.isEmpty { out.append(.bullets(bullets)); bullets = [] }
                numbered.append(String(m.1))
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
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Markdown.blocks(text)) { block in
                switch block {
                case .paragraph(let s):
                    Text(Markdown.render(s)).font(font)
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
                case .numbered(let items):
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("\(index + 1).").font(font).monospacedDigit()
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
