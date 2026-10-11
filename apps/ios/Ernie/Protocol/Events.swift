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

struct UserMessagePayload: Codable, Sendable, Equatable {
    var text: String
    var inputMode: String
    var locale: String?
}

struct UserCancelPayload: Codable, Sendable, Equatable {
    var targetCorrelationId: String
    var spokenThroughIndex: Int?
}

struct ToolConfirmationRespondPayload: Codable, Sendable, Equatable {
    var approvalId: String
    var decision: String
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
}

struct ToolConfirmationResolvedPayload: Codable, Sendable, Equatable {
    var approvalId: String
    var decision: String
}

struct AvatarEmotionPayload: Codable, Sendable, Equatable {
    var name: String
    var intensity: Double?
    var charOffset: Int?
}

struct AvatarGesturePayload: Codable, Sendable, Equatable {
    var name: String
    var charOffset: Int?
}

struct AvatarGazePayload: Codable, Sendable, Equatable {
    var target: String
    var charOffset: Int?
}

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

/// Contenuti con schema chiuso resi come schede native; i tipi sconosciuti vengono ignorati.
enum ContentBlock: Sendable, Equatable, Codable {
    case webResults(query: String, results: [WebResultItem])
    case list(title: String, items: [ListBlockItem])
    case recipes([RecipeItem])
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
