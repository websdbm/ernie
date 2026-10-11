import Foundation
import Testing
@testable import Ernie

struct EventsCodingTests {
    @Test func decodificaEventiDelServer() throws {
        let json = """
        {"v":1,"id":"6b1a7f1e-2c7a-4e4e-9b0e-6d7f2a1c3b4d","sessionId":"1caaa18b-0446-44a9-9faa-3da78e1e6aac","correlationId":"9e2d0c4a-1111-4222-8333-444455556666","seq":4,"ts":"2026-10-11T09:21:20.564Z","type":"automation.run.updated","payload":{"automationId":"b591231d-2944-4c45-b12b-115b1719c181","runId":"60f402fa-a8f4-4261-aa24-ef5bf3fbaea0","status":"awaiting_approval","summary":"Tre ricette"}}
        """
        let e = try AgentEvent.decode(json)
        #expect(e.seq == 4)
        guard case .automationRunUpdated(let p) = e.payload else { Issue.record("payload inatteso"); return }
        #expect(p.status == "awaiting_approval")
        #expect(p.summary == "Tre ricette")
    }

    @Test func decodificaUsageEConferme() throws {
        let completed = """
        {"v":1,"id":"a","sessionId":"s","correlationId":"c","seq":7,"ts":"2026-10-11T09:00:00.000Z","type":"assistant.completed","payload":{"finishReason":"stop","usage":{"inputTokens":6470,"outputTokens":186,"cachedInputTokens":2104,"routerTokens":930,"llmCalls":2,"toolCalls":1,"latencyMs":3366,"costUsdActual":0.00696,"model":"anthropic/claude-sonnet-5.5","route":"llm"}}}
        """
        let e = try AgentEvent.decode(completed)
        guard case .assistantCompleted(let p) = e.payload else { Issue.record("payload inatteso"); return }
        #expect(p.usage?.cachedInputTokens == 2104)
        #expect(p.usage?.route == "llm")

        let ask = """
        {"v":1,"id":"b","sessionId":"s","correlationId":"c","seq":8,"ts":"2026-10-11T09:00:00.000Z","type":"tool.confirmation.requested","payload":{"approvalId":"23f24cd9-cd53-41e6-99e9-8e5a7744ddbc","toolCallId":"t1","toolId":"shopping_list_add","argsPreview":"{\\"items\\":[{\\"name\\":\\"uova\\"}]}","reason":"run contaminata","expiresAt":"2026-10-11T09:02:00.000Z"}}
        """
        guard case .toolConfirmationRequested(let q) = try AgentEvent.decode(ask).payload else { Issue.record("payload inatteso"); return }
        #expect(q.toolId == "shopping_list_add")
        #expect(q.argsPreview?.contains("uova") == true)
    }

    @Test func tipoSconosciutoNonEUnErrore() throws {
        let json = """
        {"v":1,"id":"z","sessionId":"s","correlationId":"c","seq":1,"ts":"2026-10-11T09:00:00.000Z","type":"futuro.evento","payload":{"x":1}}
        """
        let e = try AgentEvent.decode(json)
        #expect(e.payload == .unknown(type: "futuro.evento"))
    }

    @Test func codificaMessaggioUtenteComeIlServerLoAttende() throws {
        let e = AgentEvent(
            payload: .userMessage(UserMessagePayload(text: "ciao", inputMode: "voice", locale: "it-IT")),
            sessionId: "1caaa18b-0446-44a9-9faa-3da78e1e6aac",
            correlationId: "9e2d0c4a-1111-4222-8333-444455556666",
            seq: 3
        )
        let data = Data(try e.encoded().utf8)
        let obj = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(obj["type"] as? String == "user.message")
        #expect(obj["v"] as? Int == 1)
        #expect(obj["seq"] as? Int == 3)
        let payload = try #require(obj["payload"] as? [String: Any])
        #expect(payload["text"] as? String == "ciao")
        #expect(payload["inputMode"] as? String == "voice")
        #expect(obj["persist"] == nil)
        let ts = try #require(obj["ts"] as? String)
        #expect(ts.hasSuffix("Z") && ts.contains("T"))
        let roundTrip = try AgentEvent.decode(try e.encoded())
        #expect(roundTrip == e)
    }

    @Test func pingNonPersistito() throws {
        let e = AgentEvent(payload: .sessionPing, sessionId: "s", correlationId: "c", seq: 9, persist: false)
        let obj = try #require(JSONSerialization.jsonObject(with: Data(try e.encoded().utf8)) as? [String: Any])
        #expect(obj["persist"] as? Bool == false)
        #expect((obj["payload"] as? [String: Any])?.isEmpty == true)
    }

    @Test func decodificaBlocchiStrutturati() throws {
        let json = """
        {"v":1,"id":"k","sessionId":"s","correlationId":"c","seq":2,"ts":"2026-10-11T09:00:00.000Z","type":"assistant.block","payload":{"blockId":"c:0","block":{"kind":"recipes","recipes":[{"title":"Zuppa di legumi","time":"30 min","ingredients":["legumi misti","carote"],"url":"https://esempio.it/zuppa","source":"esempio.it"}]}}}
        """
        guard case .assistantBlock(let p) = try AgentEvent.decode(json).payload,
              case .recipes(let recipes) = p.block else { Issue.record("payload inatteso"); return }
        #expect(recipes.first?.title == "Zuppa di legumi")
        #expect(recipes.first?.ingredients.count == 2)
        let unknown = """
        {"v":1,"id":"k2","sessionId":"s","correlationId":"c","seq":3,"ts":"2026-10-11T09:00:00.000Z","type":"assistant.block","payload":{"blockId":"c:1","block":{"kind":"grafico","serie":[1,2]}}}
        """
        guard case .assistantBlock(let u) = try AgentEvent.decode(unknown).payload else { Issue.record("payload inatteso"); return }
        #expect(u.block == .unknown(kind: "grafico"))
    }
}
