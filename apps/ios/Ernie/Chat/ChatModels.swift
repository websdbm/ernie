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
        return "\(toolId): \(args?.compact ?? "")"
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

/// Macchina a stati dell'agente, di cui l'avatar (M10) è consumatore.
enum AgentState: Sendable, Equatable {
    case idle, listening, thinking, speaking
}
