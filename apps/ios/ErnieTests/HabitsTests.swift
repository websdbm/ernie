import CryptoKit
import Foundation
import SwiftUI
import Testing
import UIKit
import Vision
@testable import Ernie

private let habitsFixture = """
{"revision":1,"epoch":"11111111-1111-4111-8111-111111111111","skillEnabled":true,"collecting":true,"aiAllowed":false,"enabledAt":"2026-11-10T08:00:00Z","retentionDays":30,"policyVersion":1,"policy":"Fixture","visits":[],"places":[],"patterns":[],"lastReviewDay":null}
"""
private actor HabitsTransportFixture {
    var paths: [String] = []
    var suspended = false
    var continuation: CheckedContinuation<Void,Never>?
    func hold() { suspended = true }
    func release() { suspended = false; continuation?.resume(); continuation = nil }
    func count() -> Int { paths.count }
    func send(_ request: URLRequest) async throws -> (Data,URLResponse) {
        paths.append(request.url!.path)
        if suspended { await withCheckedContinuation { continuation = $0 } }
        return (Data(habitsFixture.utf8),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
    }
}
@MainActor struct HabitsTests {
    private func queue() -> HabitsQueue {
        HabitsQueue(scope: UUID().uuidString, directory: FileManager.default.temporaryDirectory.appendingPathComponent("habits-tests-\(UUID().uuidString)"), suppliedKey: SymmetricKey(data: Data(repeating: 12,count:32)))
    }
    private func client(_ fixture: HabitsTransportFixture) -> HabitsClient {
        HabitsClient(credentials: .init(serverURL: URL(string:"https://example.test")!, apiKey:"synthetic"),transport:{try await fixture.send($0)})
    }
    @Test func decodificaContrattoBackendEDate() throws {
        let state=try JSONDecoder().decode(HabitsSnapshot.self,from:Data(habitsFixture.utf8))
        #expect(state.visits.isEmpty);#expect(!state.aiAllowed)
        #expect(HabitVisit.date("2026-11-10T08:00:00.000Z") == HabitVisit.date("2026-11-10T08:00:00Z"))
    }
    @Test func codaCifrataERipresaSoloDopoConsensoEsplicito() throws {
        let q=queue();defer {q.clear()}
        let payload=HabitsQueue.Payload(epoch:UUID().uuidString,enabledAt:.now,leaseUntil:Date().addingTimeInterval(3600),visits:[])
        try q.begin(payload);#expect(try q.load()?.epoch == payload.epoch)
        q.clear();#expect(try q.load() == nil)
        // Even a delayed writer cannot undo the persisted pause.
        try q.save(payload);#expect(try q.load() == nil)
        try q.begin(payload);#expect(try q.load()?.epoch == payload.epoch)
    }
    @Test func identitaLocaleSeparaAccountEServer() {
        let a=Credentials(serverURL:URL(string:"https://a.example")!,apiKey:"fixture")
        let b=Credentials(serverURL:URL(string:"https://b.example")!,apiKey:"fixture")
        #expect(HabitsQueue.scope(credentials:a,userID:"one") != HabitsQueue.scope(credentials:a,userID:"two"))
        #expect(HabitsQueue.scope(credentials:a,userID:"one") != HabitsQueue.scope(credentials:b,userID:"one"))
    }
    @Test func serverAttivoNonAttivaQuestoTelefono() async throws {
        let fixture=HabitsTransportFixture(),store=HabitsStore(observeLocation: false),q=queue();defer {q.clear()}
        store.testConfigure(client:client(fixture),queue:q);await store.refresh()
        #expect(store.snapshot?.collecting == true);#expect(!store.deviceEnabled);#expect(try q.load() == nil)
        #expect(await fixture.count() == 1)
    }
    @Test func pausaDuranteLetturaNonRiattivaIlDispositivo() async throws {
        let fixture=HabitsTransportFixture(),store=HabitsStore(observeLocation: false),q=queue();defer {q.clear()}
        await fixture.hold();store.testConfigure(client:client(fixture),queue:q)
        let task=Task {await store.refresh()}
        for _ in 0..<100 where await fixture.count() == 0 { await Task.yield() }
        store.stopLocally();await fixture.release();await task.value
        #expect(!store.deviceEnabled);#expect(store.snapshot == nil);#expect(try q.load() == nil)
        await store.refresh();#expect(await fixture.count() == 2)
    }
    @Test func cambioAccountIgnoraLaRispostaVecchiaESbloccaLeLetture() async {
        let old=HabitsTransportFixture(),fresh=HabitsTransportFixture(),store=HabitsStore(observeLocation: false)
        await old.hold();store.testConfigure(client:client(old),queue:queue());let task=Task {await store.refresh()}
        for _ in 0..<100 where await old.count() == 0 {await Task.yield()}
        store.deactivate();store.testConfigure(client:client(fresh),queue:queue());await store.refresh();await old.release();await task.value
        #expect(await fresh.count() == 1);#expect(store.snapshot?.revision == 1)
    }
    @Test func revocaLocaleNonCancellaLaPossibilitaDiConsultareLoStorico() async {
        let fixture=HabitsTransportFixture(),store=HabitsStore(observeLocation: false);store.testConfigure(client:client(fixture),queue:queue());store.stopLocally();await store.refresh()
        #expect(store.snapshot != nil);#expect(!store.deviceEnabled)
    }
    @Test func invioVisitaEscludeIdentificatoreLuogoDelServer() async throws {
        let c=HabitsClient(credentials:.init(serverURL:URL(string:"https://example.test")!,apiKey:"synthetic"),transport:{ request in
            let body=try #require(request.httpBody)
            let json=try #require(JSONSerialization.jsonObject(with:body) as? [String:Any])
            let visits=try #require(json["visits"] as? [[String:Any]])
            #expect(visits.first?["placeId"] == nil)
            #expect(request.value(forHTTPHeaderField:"Cache-Control") == "no-store")
            return (Data(#"{"accepted":1}"#.utf8),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
        })
        let v=HabitVisit(id:UUID().uuidString,latitude:45,longitude:12,accuracyM:20,arrival:"2026-11-10T08:00:00Z",departure:nil,observedAt:"2026-11-10T08:10:00Z",timezone:"Europe/Rome",placeId:"server-owned")
        try await c.upload(epoch:UUID().uuidString,visits:[v])
    }
    @Test func renderingChiaroScuroECaratteriGrandi() async throws {
        let state=try JSONDecoder().decode(HabitsSnapshot.self,from:Data(habitsFixture.utf8));let store=HabitsStore(observeLocation: false);store.testConfigure(client:nil,queue:nil,snapshot:state)
        for dark in [false,true] {
            let controller=UIHostingController(rootView:HabitsView(store:store).environment(\.colorScheme,dark ? .dark : .light).environment(\.dynamicTypeSize,.accessibility1))
            let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
            let previousKey = scene.windows.first(where: \.isKeyWindow)
            let window=UIWindow(windowScene:scene);window.frame=CGRect(x:0,y:0,width:390,height:844)
            window.rootViewController=controller;controller.view.frame=window.bounds;window.makeKeyAndVisible();controller.view.layoutIfNeeded()
            try await Task.sleep(for:.milliseconds(150))
            let image=UIGraphicsImageRenderer(size:window.bounds.size).image { _ in controller.view.drawHierarchy(in:controller.view.bounds,afterScreenUpdates:true) }
            #expect(image.size.width == 390)
            let request = VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.recognitionLanguages = ["it-IT"]
            try VNImageRequestHandler(cgImage:try #require(image.cgImage),options:[:]).perform([request])
            let text=(request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator:" ").lowercased()
            #expect(text.contains("abitudini"));#expect(text.contains("attiva"));#expect(text.contains("raccolta"))
            try image.pngData()!.write(to:FileManager.default.temporaryDirectory.appendingPathComponent(dark ? "habits-dark.png" : "habits-light.png"))
            window.isHidden=true;previousKey?.makeKey()
        }
    }
}
