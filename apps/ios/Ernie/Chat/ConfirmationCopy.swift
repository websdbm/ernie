import Foundation

/// Anche le conversazioni salvate prima del riepilogo strutturato restano leggibili.
enum ConfirmationCopy {
    /// Il riepilogo chiuso descrive la conferma, non promette che il tool sia già riuscito.
    static func compactTitle(for card: ConfirmationCard) -> String {
        recipeTitle(for: card) ?? ToolLabels.name(card.toolId, displayName: card.displayName)
    }

    static func compactSummary(for card: ConfirmationCard) -> String {
        guard let title = recipeTitle(for: card) else { return presentation(for: card).summary }
        return "«\(title)» nella tua raccolta. Se già presente, verrà aggiornata."
    }

    static func status(for card: ConfirmationCard, decision: String) -> String {
        switch decision {
        case "approved": card.always == true ? "Confermata · consenso salvato" : "Confermata"
        case "denied": "Annullata"
        default: "Scaduta"
        }
    }

    private static func recipeTitle(for card: ConfirmationCard) -> String? {
        guard card.toolId == "recipe_save" else { return nil }
        let value = presentation(for: card)
        if let title = value.details.first(where: { $0.label == "Titolo" })?.value,
           !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return title }
        // Compatibilità con le schede precedenti, prive del campo Titolo nei dettagli.
        let suffix = "» verrà salvata nella tua raccolta."
        if value.summary.hasPrefix("«"), let end = value.summary.range(of: suffix) {
            return String(value.summary[value.summary.index(after: value.summary.startIndex)..<end.lowerBound])
        }
        return nil
    }

    static func reason(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let lower = raw.lowercased()
        if lower.contains("fuga di dati") || lower.contains("esfiltr") {
            return "Questa azione invia informazioni a un servizio esterno. Controlla quali dati verranno condivisi prima di confermare."
        }
        if lower.contains("contaminat") || lower.contains("rule of two") {
            return "Prima di procedere, controlla i dati ricavati dai contenuti che ho letto."
        }
        if lower.contains("sempre richiesta") { return "Per questa azione è prevista la tua conferma." }
        if lower.contains("effetto esterno") || lower.contains("tool") || lower.contains("policy") {
            return "Questa azione richiede la tua conferma prima di procedere."
        }
        return raw
    }

    static func presentation(for card: ConfirmationCard) -> ConfirmationPresentation {
        if let presentation = card.presentation { return presentation }
        let raw = card.argsPreview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let object = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any]
        let isJSON = raw.hasPrefix("{") || raw.hasPrefix("[")
        let recipe = card.toolId == "recipe_save"
        var summary = ToolLabels.name(card.toolId, displayName: card.displayName)
        if recipe, let title = object?["title"] as? String ?? completeString("title", in: raw) {
            summary = "«\(title)» verrà salvata nella tua raccolta. Se il titolo esiste già, la ricetta verrà aggiornata."
        } else if !isJSON, !raw.isEmpty { summary = raw }
        let details = object?.keys.sorted().map { key in
            ConfirmationPresentation.Detail(label: labels[key] ?? "Dettaglio", value: readable(object?[key], key: key))
        } ?? []
        return ConfirmationPresentation(title: recipe ? "Salvare questa ricetta?" : "Confermi questa azione?",
                                        summary: summary, confirmLabel: recipe ? "Salva ricetta" : "Conferma",
                                        details: details, incomplete: isJSON && object == nil)
    }

    private static let labels = [
        "title": "Titolo", "ingredients": "Ingredienti", "steps": "Preparazione", "time": "Tempo", "servings": "Porzioni",
        "category": "Categoria", "tags": "Tag", "source": "Fonte", "url": "Pagina web", "notes": "Note", "reason": "Modifica richiesta",
        "recipe": "Ricetta", "items": "Prodotti", "names": "Prodotti", "name": "Nome", "quantity": "Quantità", "list": "Lista",
        "text": "Testo", "body": "Contenuto", "at": "Quando avvisarti", "eventAt": "Appuntamento", "place": "Luogo", "address": "Indirizzo",
        "label": "Nome", "into": "Scheda finale", "from": "Nome attuale", "to": "Nuovo nome", "query": "Testo della ricerca", "id": "Riferimento"
    ]

    private static func readable(_ value: Any?, key: String) -> String {
        if let value = value as? String { return value }
        if let values = value as? [Any] {
            return values.enumerated().map { index, value in
                "\(key == "steps" ? "\(index + 1)." : "•") \(readable(value, key: ""))"
            }.joined(separator: "\n")
        }
        if let object = value as? [String: Any] {
            return object.keys.sorted().map { "\(labels[$0] ?? "Dettaglio"): \(readable(object[$0], key: $0))" }.joined(separator: "\n")
        }
        if let value = value as? NSNumber {
            return CFGetTypeID(value) == CFBooleanGetTypeID() ? (value.boolValue ? "Sì" : "No") : value.stringValue
        }
        return "Non indicato"
    }

    /// Estrae solo un valore stringa completo dal vecchio JSON troncato, rispettando gli escape.
    private static func completeString(_ key: String, in raw: String) -> String? {
        let pattern = #"""# + NSRegularExpression.escapedPattern(for: key) + #""\s*:\s*("(?:[^"\\]|\\.)*")"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
              let range = Range(match.range(at: 1), in: raw) else { return nil }
        return try? JSONDecoder().decode(String.self, from: Data(raw[range].utf8))
    }

    static func alwaysLabel(for tool: String) -> String {
        tool == "recipe_save" ? "Salva sempre senza chiedere" : "Consenti sempre questa azione"
    }

    static func alwaysExplanation(for tool: String) -> String {
        let scope = tool == "recipe_save" ? "Vale per tutte le ricette salvate o aggiornate da Ernie." : "Vale per tutte le azioni di tipo «\(ToolLabels.name(tool))»."
        return "\(scope) Puoi revocarlo in Impostazioni → Conferme."
    }

    static func decision(for card: ConfirmationCard, now: Date) -> String? {
        if let decision = card.decision { return decision }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var expires = parser.date(from: card.expiresAt)
        if expires == nil {
            parser.formatOptions = [.withInternetDateTime]
            expires = parser.date(from: card.expiresAt)
        }
        return expires.map { $0 <= now ? "expired" : nil } ?? nil
    }
}
