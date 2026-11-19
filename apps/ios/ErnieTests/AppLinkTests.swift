import Foundation
import Testing
@testable import Ernie

struct AppLinkTests {
    @Test func domandaAbitudiniApreLaSezioneSenzaPosizioniNelPayload() {
        #expect(AppLink.habits.url.absoluteString == "ernie://habits")
        #expect(AppLink(url: AppLink.habits.url) == .habits)
        #expect(AppDelegate.habitsLink(["ernie": ["kind": "proactive.habit_learning"]]) == .habits)
        #expect(AppDelegate.habitsLink(["ernie": ["kind": "family_message"]]) == nil)
        #expect(AppLink(url: URL(string: "ernie://habits?latitude=45")!) == nil)
    }
    @Test func saluteSiApreSenzaDatiSensibiliNelLink() throws {
        #expect(AppLink.health.url.absoluteString == "ernie://health")
        #expect(AppLink(url: AppLink.health.url) == .health)
        #expect(AppLink(url: URL(string: "ernie://health?report=private")!) == nil)
        #expect(AppLink(url: URL(string: "ernie://health/private")!) == nil)
        let raw = Data(#"{"kind":"health_access","title":"Salute","message":"Apri la sezione protetta."}"#.utf8)
        let block = try JSONDecoder().decode(ContentBlock.self, from: raw)
        #expect(block == .healthAccess(.init(title: "Salute", message: "Apri la sezione protetta.")))
        #expect(try JSONDecoder().decode(ContentBlock.self, from: JSONEncoder().encode(block)) == block)
    }
}
