import Foundation

enum ChatRole: String, Codable, Sendable { case user, assistant, system }

struct ToolActivity: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var toolId: String
    var displayName: String?
    var argsPreview: String?
    var ok: Bool?
    var durationMs: Int?
    var error: String?
}

struct ChatMessage: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var correlationId: String
    var role: ChatRole
    var text: String
    var isStreaming = false
    var tools: [ToolActivity] = []
    /// Schede strutturate ricevute durante il turno (risultati web, elenchi, ricette).
    var blocks: [ContentBlock] = []
    var usage: UsagePayload?
    var route: String?
    var modelClass: String?
    var inputMode: String?
    var cancelled = false
    var createdAt: Date
    /// Documenti allegati al messaggio (titolo e pagine), per il fumetto dell'utente.
    var attachments: [AttachmentInfo]?
    /// Messaggio in coda: parte da solo appena Ernie finisce il turno in corso (mai «un turno è già in corso»).
    var queued: Bool?
    var requestPayload: UserMessagePayload? = nil
    var awaitingResponse: Bool? = nil
    var recoveryNeeded: Bool? = nil

    /// I tool inviano snapshot completi: creazione, aggiunta e rilettura della stessa lista aggiornano
    /// una sola scheda nel turno. Conserva la posizione iniziale e l'ultimo contenuto, anche se vuoto.
    mutating func coalesceListSnapshots() {
        var positions: [String: Int] = [:]
        var result: [ContentBlock] = []
        for block in blocks {
            if case .todoList(let todo) = block {
                let key = "todo:" + todo.list.id
                if let index = positions[key] {
                    if case .todoList(let previous) = result[index], previous.list.revision > todo.list.revision { continue }
                    result[index] = block
                    continue
                }
                positions[key] = result.count
            }
            if case .shoppingList(let list) = block {
                let key = "shopping:" + list.listId
                if let index = positions[key] {
                    result[index] = block
                    continue
                }
                positions[key] = result.count
            }
            result.append(block)
        }
        blocks = result
    }

    /// Le vecchie versioni salvavano il broadcast Todo come una risposta vuota e separata.
    var isStandaloneTodoUpdate: Bool {
        role == .assistant && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        tools.isEmpty && route == nil && modelClass == nil && usage == nil && !cancelled &&
        !blocks.isEmpty && blocks.allSatisfy { if case .todoList = $0 { return true }; return false }
    }
}

struct AttachmentInfo: Codable, Sendable, Equatable {
    var id: String
    var title: String
    var pages: Int
}

/// Richiesta di conferma di un tool durante un turno (Policy Engine: `ask`).
struct ConfirmationCard: Codable, Sendable, Equatable, Identifiable {
    var id: String { approvalId }
    var approvalId: String
    var correlationId: String
    var toolId: String
    var displayName: String?
    var argsPreview: String?
    var reason: String?
    var expiresAt: String
    var decision: String?
    /// Il server ammette «Consenti sempre» (tool senza effetto esterno).
    var allowAlways: Bool? = nil
    /// L'utente ha scelto «Consenti sempre».
    var always: Bool? = nil
    var presentation: ConfirmationPresentation? = nil
}

/// Azione sospesa da un'automazione (run headless): si approva o rifiuta dalla scheda.
struct PendingActionSummary: Codable, Sendable, Equatable, Identifiable {
    var id: String { approvalId }
    var approvalId: String
    var toolId: String
    var summary: String
    var decision: String?
}

/// Notifica del server (automazioni) mostrata come scheda nella conversazione.
struct NotificationCard: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var body: String
    var createdAt: String
    var pendingActions: [PendingActionSummary] = []
    /// Automazione a cui si riferisce (per «Riprendi» dopo una pausa automatica).
    var automationId: String?
    /// Esito di «Riprendi»: true ripresa, false non riuscita, nil non ancora toccato.
    var resumed: Bool?

    var needsApproval: Bool { pendingActions.contains { $0.decision == nil } }
    var isPaused: Bool { kind == "automation.paused" }

    init(_ n: NotificationItem) {
        id = n.id
        kind = n.kind
        title = n.title
        body = n.body
        createdAt = n.createdAt
        automationId = n.payload?["automationId"]?.stringValue
        pendingActions = (n.payload?["pendingActions"]?.arrayValue ?? []).compactMap { a in
            guard let approvalId = a["approvalId"]?.stringValue, let toolId = a["toolId"]?.stringValue else { return nil }
            return PendingActionSummary(
                approvalId: approvalId,
                toolId: toolId,
                summary: Self.describe(toolId: toolId, args: a["args"]),
                decision: a["decision"]?.stringValue
            )
        }
    }

    static func describe(toolId: String, args: JSONValue?) -> String {
        if toolId.hasPrefix("shopping_list"), let items = args?["items"]?.arrayValue {
            let names = items.compactMap { item -> String? in
                guard let name = item["name"]?.stringValue else { return nil }
                if let q = item["quantity"]?.stringValue { return "\(name) (\(q))" }
                return name
            }
            return "Aggiungi alla lista: " + names.joined(separator: ", ")
        }
        return "\(ToolLabels.name(toolId)): \(args?.compact ?? "")"
    }
}

enum ChatItem: Codable, Sendable, Equatable, Identifiable {
    case message(ChatMessage)
    case confirmation(ConfirmationCard)
    case notification(NotificationCard)
    /// Messaggio in famiglia (v1.16): fumetto suo, né dell'utente né di Ernie.
    case family(FamilyMessageBlock)

    var id: String {
        switch self {
        case .message(let m): "m:\(m.id)"
        case .confirmation(let c): "c:\(c.approvalId)"
        case .notification(let n): "n:\(n.id)"
        case .family(let f): "f:\(f.id)"
        }
    }
}

extension Array where Element == ChatItem {
    /// Un broadcast aggiorna le schede già mostrate, senza creare una risposta dell'assistente.
    @discardableResult mutating func refreshTodoList(_ list: TodoList) -> Bool {
        var changed = false
        for index in indices {
            guard case .message(var message) = self[index], message.role == .assistant else { continue }
            let previous = message.blocks
            message.blocks = message.blocks.map { block in
                guard case .todoList(let current) = block, current.list.id == list.id,
                      current.list.revision <= list.revision else { return block }
                return .todoList(.init(list: list))
            }
            message.coalesceListSnapshots()
            if previous != message.blocks { self[index] = .message(message); changed = true }
        }
        return changed
    }

    func normalizingListSnapshots() -> Self {
        let requestedTurns = Set(compactMap { item -> String? in
            guard case .message(let message) = item, message.role == .user else { return nil }
            return message.correlationId
        })
        var result: Self = []
        for item in self {
            guard case .message(var message) = item, message.role == .assistant else { result.append(item); continue }
            message.coalesceListSnapshots()
            if message.isStandaloneTodoUpdate && !requestedTurns.contains(message.correlationId) {
                for block in message.blocks {
                    if case .todoList(let update) = block { result.refreshTodoList(update.list) }
                }
            } else { result.append(.message(message)) }
        }
        return result
    }
}

/// Macchina a stati dell'agente, di cui l'avatar (M10) è consumatore.
enum AgentState: Sendable, Equatable {
    case idle, listening, thinking, speaking
}

/// Fallback anche per le attività già salvate nelle conversazioni precedenti.
enum ToolLabels {
    static let italian: [String: String] = [
        "brain_merge": "Unione delle schede",
        "brain_search": "Ricerca nel Second Brain",
        "brain_read": "Lettura della scheda",
        "brain_write": "Aggiornamento del Second Brain",
        "brain_knowledge_update": "Aggiornamento di informazioni e orari",
        "brain_agenda": "Consultazione degli orari abituali",
        "present_choices": "Proposta delle opzioni",
        "present_recipes": "Presentazione delle ricette",
        "get_time": "Consultazione di data e ora",
        "health_parameter": "Lettura dei valori degli esami",
        "health_report": "Lettura del referto",
        "health_overview": "Riepilogo della salute",
        "health_import": "Acquisizione del referto",
        "memory_search": "Ricerca nei ricordi",
        "operating_preferences_list": "Lettura delle tue preferenze",
        "operating_preference_save": "Aggiornamento delle tue preferenze",
        "operating_preference_remove": "Rimozione della preferenza",
        "document_summarize": "Riassunto del documento",
        "document_schema": "Creazione dello schema",
        "document_get": "Lettura del documento",
        "document_list": "Elenco dei documenti",
        "document_search": "Ricerca nei documenti",
        "document_focus": "Selezione del documento",
        "web_search": "Ricerca sul web",
        "web_fetch": "Lettura della pagina web",
        "sentinel_create": "Attivazione del monitoraggio",
        "sentinel_list": "Elenco dei monitoraggi",
        "sentinel_remove": "Rimozione del monitoraggio",
        "recipe_search": "Ricerca delle ricette",
        "recipe_get": "Lettura della ricetta",
        "recipe_save": "Salvataggio della ricetta",
        "recipe_delete": "Eliminazione della ricetta",
        "todo_lists": "Ricerca delle liste attività",
        "todo_get": "Lettura delle attività",
        "todo_save": "Organizzazione delle attività",
        "shopping_list_get": "Lettura della lista della spesa",
        "shopping_list_add": "Aggiunta alla lista della spesa",
        "shopping_list_remove": "Rimozione dalla lista della spesa",
        "shopping_list_check": "Aggiornamento degli acquisti",
        "shopping_list_clear": "Pulizia della lista della spesa",
        "shopping_lists": "Elenco delle liste della spesa",
        "shopping_list_create": "Creazione della lista della spesa",
        "shopping_list_archive": "Archiviazione della lista della spesa",
        "shopping_list_rename": "Rinomina della lista della spesa",
        "shopping_list_delete": "Eliminazione della lista della spesa",
        "reminder_create": "Creazione del promemoria",
        "reminder_list": "Elenco dei promemoria",
        "reminder_cancel": "Annullamento del promemoria",
        "place_set": "Salvataggio del luogo",
        "place_rename": "Rinomina del luogo",
    ]
    static func name(_ id: String, displayName: String? = nil) -> String {
        if let label = italian[id] { return label }
        if let label = displayName, !label.isEmpty, label != id, !label.contains("_") { return label }
        return "Operazione di Ernie"
    }
}

/// Identità e contenuto congelati: un recupero non diventa mai un nuovo messaggio «Riprova».
struct ChatRequestRecovery: Codable, Sendable, Equatable {
    var messageId: String
    var correlationId: String
    var payload: UserMessagePayload
    var attempts = 0
    var createdAt = Date.now
    var isRecoverable: Bool { Date.now.timeIntervalSince(createdAt) < 23 * 3600 }
    mutating func nextAttempt() -> Bool {
        guard attempts < 3 else { return false }
        attempts += 1
        return true
    }
    static func from(_ message: ChatMessage) -> Self? {
        guard message.role == .user, let payload = message.requestPayload else { return nil }
        let request = Self(messageId: message.id, correlationId: message.correlationId, payload: payload, createdAt: message.createdAt)
        return request.isRecoverable ? request : nil
    }
}
