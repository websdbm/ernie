import Foundation

enum Markdown {
    /// Solo sintassi inline (grassetto, corsivo, codice, link): nessuna immagine remota, niente blocchi.
    static func render(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        options.failurePolicy = .returnPartiallyParsedIfPossible
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
