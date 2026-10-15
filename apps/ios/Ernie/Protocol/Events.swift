import Foundation

/// Porting Swift del protocollo Ernie v1.1 (`packages/protocol`): envelope + payload per tipo.
enum ErnieProtocol {
    static let version = 1
    static let minor = 2
}

// MARK: - payload client → server

struct ClientInfo: Codable, Sendable, Equatable {
    var platform = "ios"
    var appVersion: String?
    var locale: String?
}

struct SessionStartPayload: Codable, Sendable, Equatable {
    var clientInfo: ClientInfo?
    var resumeFromSeq: Int?
}

struct DocumentAttachment: Codable, Sendable, Equatable {
    var kind = "document"
    var id: String
}

struct UserMessagePayload: Codable, Sendable, Equatable {
    var text: String
    var inputMode: String
    var locale: String?
    /// v1.3: documenti già caricati con `POST /v1/documents`.
    var attachments: [DocumentAttachment]?
    /// v1.10: ora locale, fuso e (con permesso) posizione approssimata del telefono.
    var device: DeviceContextPayload? = nil
}

struct DeviceContextPayload: Codable, Sendable, Equatable {
    struct Location: Codable, Sendable, Equatable {
        var latitude: Double
        var longitude: Double
        var accuracyM: Double?
        var place: String?
        var at: String?
    }

    var timezone: String?
    var localTime: String?
    var location: Location?
}

struct UserCancelPayload: Codable, Sendable, Equatable {
    var targetCorrelationId: String
    var spokenThroughIndex: Int?
}

struct ToolConfirmationRespondPayload: Codable, Sendable, Equatable {
    var approvalId: String
    var decision: String
    /// v1.9: «Consenti sempre» (crea la regola per il tool sul server).
    var always: Bool?
}

struct EmptyPayload: Codable, Sendable, Equatable {}

// MARK: - payload server → client

struct SessionStartedPayload: Codable, Sendable, Equatable {
    var serverTime: String
    var protocolVersion: Int
    var protocolMinor: Int?
    var resumedFromSeq: Int?
    var replayed: Int?
}

struct SessionPongPayload: Codable, Sendable, Equatable { var serverTime: String }

struct AssistantStartedPayload: Codable, Sendable, Equatable {
    var route: String?
    var modelClass: String?
}

struct TextDeltaPayload: Codable, Sendable, Equatable { var delta: String }
struct TextCompletedPayload: Codable, Sendable, Equatable { var text: String }

struct ToolStartedPayload: Codable, Sendable, Equatable {
    var toolCallId: String
    var toolId: String
    var displayName: String?
    var argsPreview: String?
}

struct ToolCompletedPayload: Codable, Sendable, Equatable {
    var toolCallId: String
    var toolId: String
    var ok: Bool
    var durationMs: Int
    var resultPreview: String?
    var error: String?
}

struct UsagePayload: Codable, Sendable, Equatable {
    var inputTokens: Int
    var outputTokens: Int
    var reasoningTokens: Int?
    var cachedInputTokens: Int?
    var routerTokens: Int?
    var memoryTokens: Int?
    var llmCalls: Int
    var toolCalls: Int
    var costUsdEstimated: Double?
    var costUsdActual: Double?
    var latencyMs: Int
    var model: String?
    var route: String?
}

struct AssistantCompletedPayload: Codable, Sendable, Equatable {
    var usage: UsagePayload?
    var finishReason: String?
}

struct AssistantCancelledPayload: Codable, Sendable, Equatable { var reason: String }

struct ToolConfirmationRequestedPayload: Codable, Sendable, Equatable {
    var approvalId: String
    var toolCallId: String
    var toolId: String
    var displayName: String?
    var argsPreview: String?
    var reason: String?
    var expiresAt: String
    /// v1.9: il server ammette «Consenti sempre» per questo tool.
    var allowAlways: Bool?
}

struct ToolConfirmationResolvedPayload: Codable, Sendable, Equatable {
    var approvalId: String
    var decision: String
}

struct AvatarEmotionPayload: Codable, Sendable, Equatable {
    var name: String
    var intensity: Double?
    var charOffset: Int?
    /// v1.9: per quanto mostrarla dopo il parlato (poi l'orso torna neutro).
    var durationMs: Int?
}

struct AvatarGesturePayload: Codable, Sendable, Equatable {
    var name: String
    var charOffset: Int?
}

struct AvatarGazePayload: Codable, Sendable, Equatable {
    var target: String
    var charOffset: Int?
}

/// v1.9: nuove notifiche nella casella (es. messaggio spontaneo passato dal gate).
struct InboxUpdatedPayload: Codable, Sendable, Equatable { var kind: String? }

struct AutomationRunUpdatedPayload: Codable, Sendable, Equatable {
    var automationId: String
    var runId: String
    var status: String
    var summary: String?
}

// MARK: - blocchi strutturati (v1.2)

struct WebResultItem: Codable, Sendable, Equatable, Identifiable {
    var id: String { url }
    var title: String
    var url: String
    var site: String?
    var snippet: String?
}

struct ListBlockItem: Codable, Sendable, Equatable, Identifiable {
    var id: String { name }
    var name: String
    var quantity: String?
    var checked: Bool?
}

struct RecipeItem: Codable, Sendable, Equatable, Identifiable {
    var id: String { title }
    var title: String
    var time: String?
    var servings: String?
    var source: String?
    var url: String?
    var ingredients: [String]
    var steps: [String]?
}

// MARK: - Documenti (v1.3)

struct GlossaryEntry: Codable, Sendable, Equatable, Identifiable {
    var id: String { term }
    var term: String
    var definition: String
}

struct QuizQuestion: Codable, Sendable, Equatable, Identifiable {
    var id: String { question }
    var question: String
    var answer: String
}

/// Scheda di un documento letto: prodotti da studio (il testo intero resta sul server).
struct DocumentBlock: Codable, Sendable, Equatable {
    var documentId: String
    var title: String
    var pages: Int
    var source: String
    var abstract: String
    var keyPoints: [String]
    var glossary: [GlossaryEntry]?
    var questions: [QuizQuestion]?
}

/// Nodo della mappa (ricorsivo).
/// Schema «a frecce» da studio (v1.8): sezioni per paragrafo; un solo `next` = la catena prosegue, più `next` = ramificazione.
struct OutlineNode: Codable, Sendable, Equatable {
    var label: String
    var next: [OutlineNode]?
}

struct OutlineSection: Codable, Sendable, Equatable {
    var title: String
    var nodes: [OutlineNode]
}

struct MindNode: Codable, Sendable, Equatable {
    var label: String
    var note: String?
    var children: [MindNode]?
}

struct FlowStep: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var label: String
    var note: String?
}

struct FlowLink: Codable, Sendable, Equatable {
    var from: String
    var to: String
    var label: String?
}

struct TimelineEvent: Codable, Sendable, Equatable {
    var when: String
    var label: String
    var note: String?
}

/// Schema grafico di un testo: dati chiusi, disegnati nativamente (mai immagini).
enum SchemaDiagram: Sendable, Equatable, Codable {
    case outline(sections: [OutlineSection])
    case mindmap(root: MindNode)
    case flow(steps: [FlowStep], links: [FlowLink])
    case timeline(events: [TimelineEvent])

    var typeName: String {
        switch self {
        case .outline: "outline"
        case .mindmap: "mindmap"
        case .flow: "flow"
        case .timeline: "timeline"
        }
    }

    private enum CodingKeys: String, CodingKey { case type, root, steps, links, events, sections }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "outline": self = .outline(sections: try c.decode([OutlineSection].self, forKey: .sections))
        case "mindmap": self = .mindmap(root: try c.decode(MindNode.self, forKey: .root))
        case "flow": self = .flow(steps: try c.decode([FlowStep].self, forKey: .steps), links: try c.decodeIfPresent([FlowLink].self, forKey: .links) ?? [])
        case "timeline": self = .timeline(events: try c.decode([TimelineEvent].self, forKey: .events))
        case let other: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "schema sconosciuto: \(other)")
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(typeName, forKey: .type)
        switch self {
        case .outline(let sections): try c.encode(sections, forKey: .sections)
        case .mindmap(let root): try c.encode(root, forKey: .root)
        case .flow(let steps, let links):
            try c.encode(steps, forKey: .steps)
            try c.encode(links, forKey: .links)
        case .timeline(let events): try c.encode(events, forKey: .events)
        }
    }
}

struct SchemaBlock: Codable, Sendable, Equatable {
    var documentId: String
    var title: String
    var diagram: SchemaDiagram
}

// MARK: - Liste della spesa (v1.4)

struct ShoppingListItem: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var quantity: String?
    var checked: Bool
}

/// Scheda interattiva: le voci si spuntano, aggiungono e tolgono via REST; il server restituisce il blocco aggiornato.
struct ShoppingListBlock: Codable, Sendable, Equatable {
    var listId: String
    var name: String
    var status: String
    var items: [ShoppingListItem]
}

struct ShoppingListSummary: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var open: Int
    var bought: Int
    var archived: Bool
}

/// Scelta tra più liste: toccandone una si rimanda `pendingText` con il nome al posto di `{lista}`.
struct ShoppingListsBlock: Codable, Sendable, Equatable {
    var title: String
    var lists: [ShoppingListSummary]
    var pendingText: String?
}

/// Documenti letti (v1.5): scelta toccabile; si rimanda `pendingText` con il titolo al posto di `{documento}`.
struct DocumentSummaryItem: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String
    var pages: Int
    var source: String
    var summarized: Bool
    var createdAt: String
}

struct DocumentsBlock: Codable, Sendable, Equatable {
    var title: String
    var documents: [DocumentSummaryItem]
    var pendingText: String?
}

/// Promemoria (v1.6): elenco con annullamento dalla scheda; l'app programma anche una notifica locale.
struct ReminderItem: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var text: String
    /// Assente nei promemoria legati a un luogo (v1.14).
    var at: String?
    var status: String
    /// v1.14: promemoria geolocalizzato («quando arrivo a casa»): scatta sul telefono entrando o uscendo dalla zona.
    var place: ReminderPlaceInfo? = nil
    /// Famiglia (v1.7): messo da me a «Giorgio» / messo a me da «papà».
    var forLabel: String? = nil
    var fromLabel: String? = nil
    /// v1.11: canali (email, sveglia) del singolo promemoria; assente = impostazione generale.
    var channels: ReminderChannels? = nil
    /// v1.11: ricorrenza («ogni venerdì alle 9»); in quel caso `at` è la prossima occorrenza.
    var repeatInfo: ReminderRepeatInfo? = nil
    /// v1.13: preavviso di un appuntamento: `at` è l'avviso, `eventAt` l'ora dell'appuntamento.
    var eventAt: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, text, at, status, channels, eventAt, place
        case forLabel = "for"
        case fromLabel = "from"
        case repeatInfo = "repeat"
    }
}

/// Luogo di un promemoria (v1.14): etichetta della scheda e, quando il luogo ha una posizione, indirizzo e zona.
struct ReminderPlaceInfo: Codable, Sendable, Equatable {
    var label: String
    /// "arrive" (quando arrivo) o "leave" (quando esco).
    var on: String
    /// Ogni volta, non solo la prossima.
    var repeats: Bool? = nil
    var placeId: String? = nil
    var address: String? = nil
    var lat: Double? = nil
    var lng: Double? = nil
    var radius: Double? = nil

    enum CodingKeys: String, CodingKey {
        case label, on, placeId, address, lat, lng, radius
        case repeats = "repeat"
    }

    var located: Bool { lat != nil && lng != nil }
    var leaving: Bool { on == "leave" }

    /// Persone e professioni (stesse regole del server): «dal dentista», «dalla nonna», «dai nonni».
    private var personPrep: String? {
        let persons: Set<String> = ["medico", "dottore", "dottoressa", "parrucchiere", "parrucchiera", "barbiere", "meccanico",
                                    "veterinario", "avvocato", "notaio", "fisioterapista", "psicologo", "psicologa", "nonno", "nonna",
                                    "nonni", "zio", "zia", "zii", "mamma", "papà", "papa", "suocera", "suocero", "suoceri",
                                    "amico", "amica", "amici"]
        guard label.hasSuffix("ista") || persons.contains(label) else { return nil }
        if ["nonni", "zii", "suoceri", "amici"].contains(label) { return "dai \(label)" }
        if label.hasSuffix("a") && !label.hasSuffix("ista") { return "dalla \(label)" }
        if label.range(of: "^(s[^aeiou]|z|ps|gn)", options: .regularExpression) != nil { return "dallo \(label)" }
        return "dal \(label)"
    }

    /// «a casa» / «di casa», «al lavoro» / «dal lavoro»… (stesse forme del server).
    private var preps: (to: String, from: String) {
        if let p = personPrep { return (p, p) }
        return switch label {
        case "casa": ("a casa", "di casa")
        case "lavoro": ("al lavoro", "dal lavoro")
        case "ufficio": ("in ufficio", "dall'ufficio")
        case "scuola": ("a scuola", "da scuola")
        case "palestra": ("in palestra", "dalla palestra")
        case "università": ("all'università", "dall'università")
        case "stazione": ("in stazione", "dalla stazione")
        case "supermercato": ("al supermercato", "dal supermercato")
        default: ("a «\(label)»", "da «\(label)»")
        }
    }

    /// «quando arrivi a casa», «ogni volta che esci dal lavoro».
    var phrase: String {
        let when = repeats == true ? "ogni volta che" : "quando"
        return leaving ? "\(when) esci \(preps.from)" : "\(when) arrivi \(preps.to)"
    }

    /// Titolo della notifica: «Arrivo a casa», «Uscita dal lavoro».
    var notificationTitle: String { leaving ? "Uscita \(preps.from)" : "Arrivo \(preps.to)" }
}

/// Canali di un promemoria: `nil` = impostazione generale.
struct ReminderChannels: Codable, Sendable, Equatable {
    var email: Bool?
    var alarm: Bool?
}

/// Ricorrenza di un promemoria (v1.11). `weekdays`: 0 = domenica … 6 = sabato.
struct ReminderRepeatInfo: Codable, Sendable, Equatable {
    var kind: String
    var weekdays: [Int]?
    var day: Int?
    var hour: Int
    var minute: Int
    var label: String
}

struct RemindersBlock: Codable, Sendable, Equatable {
    var title: String
    var reminders: [ReminderItem]
}

/// Domanda chiusa (v1.13): Ernie propone poche opzioni; il tocco su una manda la sua etichetta come messaggio.
struct ChoiceOption: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var label: String
}

struct ChoicesBlock: Codable, Sendable, Equatable {
    var question: String
    var options: [ChoiceOption]
}

/// Fonti (v1.9): pagine dei documenti davvero usate e citate nella risposta, con il passo originale.
struct CitationItem: Codable, Sendable, Equatable, Identifiable {
    var documentId: String
    var title: String
    var page: Int
    var heading: String?
    var excerpt: String

    var id: String { "\(documentId):\(page)" }
}

struct CitationsBlock: Codable, Sendable, Equatable {
    var title: String
    var items: [CitationItem]
}

/// Tabellina della salute (v1.12). `mode`: "parameter" (storico di un parametro, una riga per data, la più recente prima)
/// oppure "report" (valori di un referto con il confronto con l'analisi precedente). Flag e trend restano stringhe:
/// un valore nuovo del server non fa fallire la decodifica.
struct HealthBlock: Codable, Sendable, Equatable {
    struct Previous: Codable, Sendable, Equatable {
        var value: Double
        /// YYYY-MM-DD
        var date: String
    }

    struct Row: Codable, Sendable, Equatable {
        var label: String
        /// YYYY-MM-DD (righe dello storico).
        var date: String?
        var value: Double?
        /// Risultati non numerici, es. "negativo".
        var valueText: String?
        var unit: String?
        var refLow: Double?
        var refHigh: Double?
        var refText: String?
        /// "alto" | "basso" | "normale" | "n/d"
        var flag: String
        /// Valore dell'analisi precedente con la stessa unità (righe di un referto).
        var previous: Previous?
        /// "su" | "giu" | "stabile"
        var trend: String?
    }

    var mode: String
    var title: String
    var subtitle: String?
    var rows: [Row]
    var summary: String?
}

/// Contenuti con schema chiuso resi come schede native; i tipi sconosciuti vengono ignorati.
enum ContentBlock: Sendable, Equatable, Codable {
    case webResults(query: String, results: [WebResultItem])
    case list(title: String, items: [ListBlockItem])
    case recipes([RecipeItem])
    case document(DocumentBlock)
    case schema(SchemaBlock)
    case shoppingList(ShoppingListBlock)
    case shoppingLists(ShoppingListsBlock)
    case documents(DocumentsBlock)
    case reminders(RemindersBlock)
    case citations(CitationsBlock)
    case health(HealthBlock)
    case choices(ChoicesBlock)
    case unknown(kind: String)

    private enum CodingKeys: String, CodingKey { case kind, query, results, title, items, recipes }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "web_results":
            self = .webResults(query: try c.decode(String.self, forKey: .query), results: try c.decode([WebResultItem].self, forKey: .results))
        case "list":
            self = .list(title: try c.decode(String.self, forKey: .title), items: try c.decode([ListBlockItem].self, forKey: .items))
        case "recipes":
            self = .recipes(try c.decode([RecipeItem].self, forKey: .recipes))
        case "document":
            self = .document(try DocumentBlock(from: decoder))
        case "schema":
            self = .schema(try SchemaBlock(from: decoder))
        case "shopping_list":
            self = .shoppingList(try ShoppingListBlock(from: decoder))
        case "shopping_lists":
            self = .shoppingLists(try ShoppingListsBlock(from: decoder))
        case "documents":
            self = .documents(try DocumentsBlock(from: decoder))
        case "reminders":
            self = .reminders(try RemindersBlock(from: decoder))
        case "citations":
            self = .citations(try CitationsBlock(from: decoder))
        case "health":
            self = .health(try HealthBlock(from: decoder))
        case "choices":
            self = .choices(try ChoicesBlock(from: decoder))
        default:
            self = .unknown(kind: kind)
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .webResults(let query, let results):
            try c.encode("web_results", forKey: .kind)
            try c.encode(query, forKey: .query)
            try c.encode(results, forKey: .results)
        case .list(let title, let items):
            try c.encode("list", forKey: .kind)
            try c.encode(title, forKey: .title)
            try c.encode(items, forKey: .items)
        case .recipes(let recipes):
            try c.encode("recipes", forKey: .kind)
            try c.encode(recipes, forKey: .recipes)
        case .document(let block):
            try c.encode("document", forKey: .kind)
            try block.encode(to: encoder)
        case .schema(let block):
            try c.encode("schema", forKey: .kind)
            try block.encode(to: encoder)
        case .shoppingList(let block):
            try c.encode("shopping_list", forKey: .kind)
            try block.encode(to: encoder)
        case .shoppingLists(let block):
            try c.encode("shopping_lists", forKey: .kind)
            try block.encode(to: encoder)
        case .documents(let block):
            try c.encode("documents", forKey: .kind)
            try block.encode(to: encoder)
        case .reminders(let block):
            try c.encode("reminders", forKey: .kind)
            try block.encode(to: encoder)
        case .citations(let block):
            try c.encode("citations", forKey: .kind)
            try block.encode(to: encoder)
        case .health(let block):
            try c.encode("health", forKey: .kind)
            try block.encode(to: encoder)
        case .choices(let block):
            try c.encode("choices", forKey: .kind)
            try block.encode(to: encoder)
        case .unknown(let kind):
            try c.encode(kind, forKey: .kind)
        }
    }
}

struct AssistantBlockPayload: Codable, Sendable, Equatable {
    var blockId: String
    var block: ContentBlock
}

struct ErrorPayload: Codable, Sendable, Equatable {
    var code: String
    var message: String
    var retryable: Bool
}

// MARK: - unione

enum EventPayload: Sendable, Equatable {
    case sessionStart(SessionStartPayload)
    case userMessage(UserMessagePayload)
    case userCancel(UserCancelPayload)
    case sessionPing
    case toolConfirmationRespond(ToolConfirmationRespondPayload)

    case sessionStarted(SessionStartedPayload)
    case sessionPong(SessionPongPayload)
    case assistantStarted(AssistantStartedPayload)
    case assistantTextDelta(TextDeltaPayload)
    case assistantTextCompleted(TextCompletedPayload)
    case toolStarted(ToolStartedPayload)
    case toolCompleted(ToolCompletedPayload)
    case assistantCompleted(AssistantCompletedPayload)
    case assistantCancelled(AssistantCancelledPayload)
    case toolConfirmationRequested(ToolConfirmationRequestedPayload)
    case toolConfirmationResolved(ToolConfirmationResolvedPayload)
    case avatarEmotion(AvatarEmotionPayload)
    case avatarGesture(AvatarGesturePayload)
    case avatarGaze(AvatarGazePayload)
    case automationRunUpdated(AutomationRunUpdatedPayload)
    case inboxUpdated(InboxUpdatedPayload)
    case assistantBlock(AssistantBlockPayload)
    case error(ErrorPayload)
    /// Tipo non conosciuto da questa versione del client: ignorato, non è un errore.
    case unknown(type: String)

    var typeName: String {
        switch self {
        case .sessionStart: "session.start"
        case .userMessage: "user.message"
        case .userCancel: "user.cancel"
        case .sessionPing: "session.ping"
        case .toolConfirmationRespond: "tool.confirmation.respond"
        case .sessionStarted: "session.started"
        case .sessionPong: "session.pong"
        case .assistantStarted: "assistant.started"
        case .assistantTextDelta: "assistant.text.delta"
        case .assistantTextCompleted: "assistant.text.completed"
        case .toolStarted: "tool.started"
        case .toolCompleted: "tool.completed"
        case .assistantCompleted: "assistant.completed"
        case .assistantCancelled: "assistant.cancelled"
        case .toolConfirmationRequested: "tool.confirmation.requested"
        case .toolConfirmationResolved: "tool.confirmation.resolved"
        case .avatarEmotion: "avatar.emotion"
        case .avatarGesture: "avatar.gesture"
        case .avatarGaze: "avatar.gaze"
        case .automationRunUpdated: "automation.run.updated"
        case .inboxUpdated: "inbox.updated"
        case .assistantBlock: "assistant.block"
        case .error: "error"
        case .unknown(let type): type
        }
    }
}

/// Envelope v1: identificativo, sessione, correlazione (tutti gli eventi di un turno), sequenza per direzione, timestamp.
struct AgentEvent: Codable, Sendable, Equatable {
    var v: Int
    var id: String
    var sessionId: String
    var correlationId: String
    var seq: Int
    var ts: String
    var persist: Bool?
    var payload: EventPayload

    var type: String { payload.typeName }

    init(
        payload: EventPayload,
        sessionId: String,
        correlationId: String,
        seq: Int,
        id: String = Ids.new(),
        ts: String = Ids.timestamp(),
        persist: Bool? = nil
    ) {
        self.v = ErnieProtocol.version
        self.id = id
        self.sessionId = sessionId
        self.correlationId = correlationId
        self.seq = seq
        self.ts = ts
        self.persist = persist
        self.payload = payload
    }

    private enum CodingKeys: String, CodingKey { case v, id, sessionId, correlationId, seq, ts, persist, type, payload }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = try c.decode(Int.self, forKey: .v)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        correlationId = try c.decode(String.self, forKey: .correlationId)
        seq = try c.decode(Int.self, forKey: .seq)
        ts = try c.decode(String.self, forKey: .ts)
        persist = try c.decodeIfPresent(Bool.self, forKey: .persist)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "session.start": payload = .sessionStart(try c.decode(SessionStartPayload.self, forKey: .payload))
        case "user.message": payload = .userMessage(try c.decode(UserMessagePayload.self, forKey: .payload))
        case "user.cancel": payload = .userCancel(try c.decode(UserCancelPayload.self, forKey: .payload))
        case "session.ping": payload = .sessionPing
        case "tool.confirmation.respond": payload = .toolConfirmationRespond(try c.decode(ToolConfirmationRespondPayload.self, forKey: .payload))
        case "session.started": payload = .sessionStarted(try c.decode(SessionStartedPayload.self, forKey: .payload))
        case "session.pong": payload = .sessionPong(try c.decode(SessionPongPayload.self, forKey: .payload))
        case "assistant.started": payload = .assistantStarted(try c.decode(AssistantStartedPayload.self, forKey: .payload))
        case "assistant.text.delta": payload = .assistantTextDelta(try c.decode(TextDeltaPayload.self, forKey: .payload))
        case "assistant.text.completed": payload = .assistantTextCompleted(try c.decode(TextCompletedPayload.self, forKey: .payload))
        case "tool.started": payload = .toolStarted(try c.decode(ToolStartedPayload.self, forKey: .payload))
        case "tool.completed": payload = .toolCompleted(try c.decode(ToolCompletedPayload.self, forKey: .payload))
        case "assistant.completed": payload = .assistantCompleted(try c.decode(AssistantCompletedPayload.self, forKey: .payload))
        case "assistant.cancelled": payload = .assistantCancelled(try c.decode(AssistantCancelledPayload.self, forKey: .payload))
        case "tool.confirmation.requested": payload = .toolConfirmationRequested(try c.decode(ToolConfirmationRequestedPayload.self, forKey: .payload))
        case "tool.confirmation.resolved": payload = .toolConfirmationResolved(try c.decode(ToolConfirmationResolvedPayload.self, forKey: .payload))
        case "avatar.emotion": payload = .avatarEmotion(try c.decode(AvatarEmotionPayload.self, forKey: .payload))
        case "avatar.gesture": payload = .avatarGesture(try c.decode(AvatarGesturePayload.self, forKey: .payload))
        case "avatar.gaze": payload = .avatarGaze(try c.decode(AvatarGazePayload.self, forKey: .payload))
        case "automation.run.updated": payload = .automationRunUpdated(try c.decode(AutomationRunUpdatedPayload.self, forKey: .payload))
        case "inbox.updated": payload = .inboxUpdated(try c.decode(InboxUpdatedPayload.self, forKey: .payload))
        case "assistant.block": payload = .assistantBlock(try c.decode(AssistantBlockPayload.self, forKey: .payload))
        case "error": payload = .error(try c.decode(ErrorPayload.self, forKey: .payload))
        default: payload = .unknown(type: type)
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(v, forKey: .v)
        try c.encode(id, forKey: .id)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(correlationId, forKey: .correlationId)
        try c.encode(seq, forKey: .seq)
        try c.encode(ts, forKey: .ts)
        try c.encodeIfPresent(persist, forKey: .persist)
        try c.encode(type, forKey: .type)
        switch payload {
        case .sessionStart(let p): try c.encode(p, forKey: .payload)
        case .userMessage(let p): try c.encode(p, forKey: .payload)
        case .userCancel(let p): try c.encode(p, forKey: .payload)
        case .sessionPing, .unknown: try c.encode(EmptyPayload(), forKey: .payload)
        case .toolConfirmationRespond(let p): try c.encode(p, forKey: .payload)
        case .sessionStarted(let p): try c.encode(p, forKey: .payload)
        case .sessionPong(let p): try c.encode(p, forKey: .payload)
        case .assistantStarted(let p): try c.encode(p, forKey: .payload)
        case .assistantTextDelta(let p): try c.encode(p, forKey: .payload)
        case .assistantTextCompleted(let p): try c.encode(p, forKey: .payload)
        case .toolStarted(let p): try c.encode(p, forKey: .payload)
        case .toolCompleted(let p): try c.encode(p, forKey: .payload)
        case .assistantCompleted(let p): try c.encode(p, forKey: .payload)
        case .assistantCancelled(let p): try c.encode(p, forKey: .payload)
        case .toolConfirmationRequested(let p): try c.encode(p, forKey: .payload)
        case .toolConfirmationResolved(let p): try c.encode(p, forKey: .payload)
        case .avatarEmotion(let p): try c.encode(p, forKey: .payload)
        case .avatarGesture(let p): try c.encode(p, forKey: .payload)
        case .avatarGaze(let p): try c.encode(p, forKey: .payload)
        case .automationRunUpdated(let p): try c.encode(p, forKey: .payload)
        case .inboxUpdated(let p): try c.encode(p, forKey: .payload)
        case .assistantBlock(let p): try c.encode(p, forKey: .payload)
        case .error(let p): try c.encode(p, forKey: .payload)
        }
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()
    static let decoder = JSONDecoder()

    func encoded() throws -> String {
        String(decoding: try Self.encoder.encode(self), as: UTF8.self)
    }

    static func decode(_ json: String) throws -> AgentEvent {
        try decoder.decode(AgentEvent.self, from: Data(json.utf8))
    }
}
