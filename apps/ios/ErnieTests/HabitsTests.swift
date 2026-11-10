import CryptoKit
import CoreLocation
import Foundation
import SwiftUI
import Testing
import UIKit
import Vision
@testable import Ernie

private let habitsFixture = """
{"revision":1,"epoch":"11111111-1111-4111-8111-111111111111","skillEnabled":true,"collecting":true,"aiAllowed":false,"enabledAt":"2020-01-01T08:00:00Z","retentionDays":30,"policyVersion":1,"policy":"Fixture","visits":[],"places":[],"patterns":[],"lastReviewDay":null}
"""
private actor HabitsTransportFixture {
    var paths: [String] = []
    var heldPath: String?
    var continuation: CheckedContinuation<Void,Never>?
    var state = habitsFixture
    var questionBody = #"{"question":null}"#
    var unavailable = false
    var disabled = false
    func hold(_ path: String = "/v1/habits") { heldPath = path }
    func release(holdingNext path: String? = nil) {
        heldPath = path
        continuation?.resume(); continuation = nil
    }
    func count(_ path: String? = nil) -> Int { paths.filter { path == nil || $0 == path }.count }
    func setState(_ value: String) { state = value }
    func fail() { unavailable = true }
    func disable() { disabled = true }
    func offerQuestion() {
        state = habitsFixture.replacingOccurrences(of: #""places":[]"#, with: #""places":[{"id":"place","latitude":45,"longitude":12,"label":"Luogo","purpose":"","frequency":"unknown","excluded":false}]"#)
        questionBody = #"{"question":{"placeId":"place","title":"Un luogo","question":"Che luogo è?"}}"#
    }
    func send(_ request: URLRequest) async throws -> (Data,URLResponse) {
        let path = request.url!.path
        paths.append(path)
        let body = path.hasSuffix("/visits") ? #"{"accepted":1}"# : path.hasSuffix("/question") ? questionBody : state
        if heldPath == path {
            heldPath = nil
            await withCheckedContinuation { continuation = $0 }
        }
        if unavailable { throw URLError(.notConnectedToInternet) }
        if disabled {
            return (Data(#"{"error":"habits_disabled"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil)!)
        }
        return (Data(body.utf8),HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:nil)!)
    }
}

@MainActor private final class HabitsLocationFixture: HabitsLocationManaging {
    var authorizationStatus: CLAuthorizationStatus = .notDetermined
    var monitoring = false
    var requests: [String] = []
    func startMonitoringVisits() { monitoring = true }
    func stopMonitoringVisits() { monitoring = false }
    func requestWhenInUseAuthorization() { requests.append("whenInUse") }
    func requestAlwaysAuthorization() { requests.append("always") }
}

private final class HabitsVisitFixture: CLVisit, @unchecked Sendable {
    private let start: Date
    private let end: Date
    init(arrival: Date, departure: Date = .distantFuture) {
        start = arrival; end = departure
        super.init()
    }
    required init?(coder: NSCoder) { fatalError("Synthetic visits are not decoded") }
    override var arrivalDate: Date { start }
    override var departureDate: Date { end }
    override var coordinate: CLLocationCoordinate2D { .init(latitude: 45, longitude: 12) }
    override var horizontalAccuracy: CLLocationAccuracy { 20 }
}

@MainActor struct HabitsTests {
    private func queue(directory: URL? = nil) -> HabitsQueue {
        HabitsQueue(scope: UUID().uuidString, directory: directory ?? FileManager.default.temporaryDirectory.appendingPathComponent("habits-tests-\(UUID().uuidString)"), suppliedKey: SymmetricKey(data: Data(repeating: 12,count:32)))
    }
    private func client(_ fixture: HabitsTransportFixture) -> HabitsClient {
        HabitsClient(credentials: .init(serverURL: URL(string:"https://example.test")!, apiKey:"synthetic"),transport:{try await fixture.send($0)})
    }
    private func state() throws -> HabitsSnapshot {
        try JSONDecoder().decode(HabitsSnapshot.self, from: Data(habitsFixture.utf8))
    }
    private func payload(visits: [HabitVisit] = [], lease: Date = Date().addingTimeInterval(3600)) -> HabitsQueue.Payload {
        .init(epoch: "11111111-1111-4111-8111-111111111111", enabledAt: Date().addingTimeInterval(-3600),
              leaseUntil: lease, visits: visits, wasAuthorizedAlways: true)
    }
    private func observation(arrival: Date, departure: Date? = nil) -> HabitVisit {
        let iso = ISO8601DateFormatter()
        return HabitVisit(id: HabitsQueue.visitID(arrival: arrival, departure: departure, latitude: 45, longitude: 12),
                          latitude: 45, longitude: 12, accuracyM: 20, arrival: iso.string(from: arrival),
                          departure: departure.map { iso.string(from: $0) }, observedAt: iso.string(from: .now), timezone: "Europe/Rome")
    }
    private func makeStore(location: HabitsLocationFixture = HabitsLocationFixture()) -> HabitsStore {
        HabitsStore(observeLocation: false, location: location, isActive: { false })
    }
    private func waitForRequest(_ fixture: HabitsTransportFixture, path: String, count: Int = 1) async {
        for _ in 0..<1000 {
            if await fixture.count(path) >= count { return }
            await Task.yield()
        }
        #expect(await fixture.count(path) >= count)
    }
    @Test func decodificaContrattoBackendEDate() throws {
        let state=try JSONDecoder().decode(HabitsSnapshot.self,from:Data(habitsFixture.utf8))
        #expect(state.visits.isEmpty);#expect(!state.aiAllowed)
        #expect(HabitVisit.date("2026-11-10T08:00:00.000Z") == HabitVisit.date("2026-11-10T08:00:00Z"))
    }
    @Test func codaCifrataERipresaSoloDopoConsensoEsplicito() throws {
        let q=queue();defer {q.clear()}
        let payload=HabitsQueue.Payload(epoch:UUID().uuidString,enabledAt:.now,leaseUntil:Date().addingTimeInterval(3600),visits:[])
        #expect(throws: HabitsFailure.self) { try q.save(payload) }
        try q.begin(payload);#expect(try q.load()?.epoch == payload.epoch)
        q.clear();#expect(try q.load() == nil)
        // Even a delayed writer cannot undo the persisted pause.
        #expect(throws: HabitsFailure.self) { try q.save(payload) };#expect(try q.load() == nil)
        try q.begin(payload);#expect(try q.load()?.epoch == payload.epoch)
    }
    @Test func identitaLocaleSeparaAccountEServer() {
        let a=Credentials(serverURL:URL(string:"https://a.example")!,apiKey:"fixture")
        let b=Credentials(serverURL:URL(string:"https://b.example")!,apiKey:"fixture")
        #expect(HabitsQueue.scope(credentials:a,userID:"one") != HabitsQueue.scope(credentials:a,userID:"two"))
        #expect(HabitsQueue.scope(credentials:a,userID:"one") != HabitsQueue.scope(credentials:b,userID:"one"))
    }
    @Test func optInFallitoNonLasciaUsabileIlConsensoPrecedente() throws {
        let q = queue()
        defer { q.clear() }
        try q.begin(payload())
        let visit = observation(arrival: Date().addingTimeInterval(-60))
        #expect(throws: HabitsFailure.self) { try q.begin(payload(visits: Array(repeating: visit, count: 1001))) }
        #expect(try q.load() == nil)
    }
    @Test func serverAttivoNonAttivaQuestoTelefono() async throws {
        let fixture=HabitsTransportFixture(),store=makeStore(),q=queue();defer {store.deactivate();q.clear()}
        store.testConfigure(client:client(fixture),queue:q);await store.refresh()
        #expect(!store.deviceEnabled);#expect(try q.load() == nil)
        #expect(await fixture.count() == 1)
    }
    @Test func pausaDuranteLetturaNonRiattivaIlDispositivo() async throws {
        let fixture=HabitsTransportFixture(),store=makeStore(),q=queue();defer {store.deactivate();q.clear()}
        await fixture.hold();store.testConfigure(client:client(fixture),queue:q)
        let task=Task {await store.refresh()}
        for _ in 0..<100 where await fixture.count() == 0 { await Task.yield() }
        store.stopLocally();await fixture.release();await task.value
        #expect(!store.deviceEnabled);#expect(store.snapshot == nil);#expect(try q.load() == nil)
        await store.refresh();#expect(await fixture.count() == 2)
    }
    @Test func cambioAccountIgnoraLaRispostaVecchiaESbloccaLeLetture() async {
        let old=HabitsTransportFixture(),fresh=HabitsTransportFixture(),store=makeStore()
        defer { store.deactivate() }
        await old.hold();store.testConfigure(client:client(old),queue:queue());let task=Task {await store.refresh()}
        for _ in 0..<100 where await old.count() == 0 {await Task.yield()}
        store.deactivate();store.testConfigure(client:client(fresh),queue:queue());await store.refresh();await old.release();await task.value
        #expect(await fresh.count() == 1);#expect(store.snapshot == nil)
    }
    @Test func revocaLocaleNonCancellaLaPossibilitaDiConsultareLoStorico() async {
        let fixture=HabitsTransportFixture(),location=HabitsLocationFixture()
        let store=HabitsStore(observeLocation:false,location:location,isActive:{true})
        defer {store.deactivate()}
        store.testConfigure(client:client(fixture),queue:queue());store.stopLocally();await store.refresh()
        #expect(store.snapshot != nil);#expect(!store.deviceEnabled)
    }
    @Test func consensoEsplicitoPrimaDeiPermessiEPassaggioASempre() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        let store = HabitsStore(observeLocation: false, location: location, isActive: { true })
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q, snapshot: try state())
        await store.refresh()
        #expect(location.requests.isEmpty)
        #expect(try q.load() == nil)
        await store.configure(collecting: true, aiAllowed: false, retentionDays: 30, startOnDevice: true)
        #expect(location.requests == ["whenInUse"])
        #expect(try q.load() != nil)
        #expect(!location.monitoring)
        location.authorizationStatus = .authorizedWhenInUse
        store.locationManagerDidChangeAuthorization(CLLocationManager())
        #expect(location.requests == ["whenInUse", "always"])
        location.authorizationStatus = .authorizedAlways
        store.locationManagerDidChangeAuthorization(CLLocationManager())
        #expect(location.monitoring)
        #expect(store.collectingOnDevice)
    }
    @Test func permessoIOSDaSoloNonAbilitaIlTelefono() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        await store.testActivate(client: client(fixture), queue: q)
        store.locationManager(CLLocationManager(), didVisit: HabitsVisitFixture(arrival: Date().addingTimeInterval(-60)))
        #expect(!location.monitoring)
        #expect(!store.deviceEnabled)
        #expect(location.requests.isEmpty)
        #expect(try q.load() == nil)
        #expect(await fixture.count("/v1/habits/visits") == 0)
    }
    @Test func modificaRetentionNonConcedeConsensoLocale() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q, snapshot: try state())
        await store.configure(collecting: true, aiAllowed: false, retentionDays: 7)
        #expect(try q.load() == nil); #expect(!store.deviceEnabled)
        #expect(!location.monitoring); #expect(location.requests.isEmpty)
    }
    @Test func richiestaSempreGiaAvviataNonVieneRipetutaDalCallback() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedWhenInUse
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q, snapshot: try state())
        await store.configure(collecting: true, aiAllowed: false, retentionDays: 30, startOnDevice: true)
        store.locationManagerDidChangeAuthorization(CLLocationManager())
        #expect(location.requests == ["always"])
        #expect(!location.monitoring)
    }
    @Test(arguments: ["/v1/habits", "/v1/habits/config", "/v1/habits/visits"])
    func revocaIOSDuranteRichiestaNonRichiedeCallback(path: String) async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload(visits: [observation(arrival: Date().addingTimeInterval(-60))]))
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q, snapshot: try state())
        await fixture.hold(path)
        let task = Task {
            if path.hasSuffix("/config") {
                await store.configure(collecting: true, aiAllowed: true, retentionDays: 30, startOnDevice: true)
            } else { await store.refresh() }
        }
        await waitForRequest(fixture, path: path)
        location.authorizationStatus = .authorizedWhenInUse
        await fixture.release()
        await task.value
        #expect(!location.monitoring)
        #expect(!store.deviceEnabled)
        #expect(try q.load() == nil)
        #expect(location.requests.isEmpty)
        #expect(!store.busy)
    }
    @Test(arguments: ["/v1/habits/config", "/v1/habits/visits"])
    func pausaDuranteScritturaNonRipristinaConsenso(path: String) async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload(visits: [observation(arrival: Date().addingTimeInterval(-60))]))
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q, snapshot: try state())
        await fixture.hold(path)
        let task = Task {
            if path.hasSuffix("/config") {
                await store.configure(collecting: true, aiAllowed: false, retentionDays: 30, startOnDevice: true)
            } else { await store.refresh() }
        }
        await waitForRequest(fixture, path: path)
        store.stopLocally()
        await fixture.release(); await task.value
        #expect(!store.deviceEnabled); #expect(!location.monitoring)
        #expect(try q.load() == nil); #expect(!store.busy)
    }
    @Test func erroreConfigureDopoRevocaIOSFermaComunqueLaRaccolta() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload())
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q, snapshot: try state())
        await fixture.hold("/v1/habits/config")
        let task = Task { await store.configure(collecting: true, aiAllowed: false, retentionDays: 7) }
        await waitForRequest(fixture, path: "/v1/habits/config")
        location.authorizationStatus = .denied
        await fixture.fail(); await fixture.release(); await task.value
        #expect(!location.monitoring); #expect(!store.deviceEnabled)
        #expect(try q.load() == nil); #expect(!store.busy)
    }
    @Test func skillDisabilitataDuranteConfigureBloccaAncheIlTelefono() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload())
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q, snapshot: try state())
        await fixture.disable()
        await store.configure(collecting: true, aiAllowed: false, retentionDays: 7)
        #expect(!location.monitoring); #expect(!store.deviceEnabled)
        #expect(try q.load() == nil); #expect(store.error != nil); #expect(!store.busy)
    }
    @Test(arguments: ["/v1/habits", "/v1/habits/config", "/v1/habits/visits"])
    func cambioAccountDuranteRichiestaNonContaminaIlNuovo(path: String) async throws {
        let old = HabitsTransportFixture(), fresh = HabitsTransportFixture(), location = HabitsLocationFixture()
        let oldQueue = queue(), freshQueue = queue()
        location.authorizationStatus = .authorizedAlways
        try oldQueue.begin(payload(visits: [observation(arrival: Date().addingTimeInterval(-60))]))
        let store = HabitsStore(observeLocation: false, location: location, isActive: { true })
        defer { store.deactivate(); oldQueue.clear(); freshQueue.clear() }
        store.testConfigure(client: client(old), queue: oldQueue, snapshot: try state())
        await old.hold(path)
        let task = Task {
            if path.hasSuffix("/config") {
                await store.configure(collecting: true, aiAllowed: false, retentionDays: 30, startOnDevice: true)
            } else { await store.refresh() }
        }
        await waitForRequest(old, path: path)
        await fresh.setState(habitsFixture.replacingOccurrences(of: #""revision":1"#, with: #""revision":9"#))
        await store.testActivate(client: client(fresh), queue: freshQueue)
        await old.release(); await task.value
        #expect(store.snapshot?.revision == 9)
        #expect(try oldQueue.load() == nil); #expect(try freshQueue.load() == nil)
        #expect(!location.monitoring); #expect(!store.deviceEnabled); #expect(!store.busy)
    }
    @Test func avvioBackgroundRipristinaSoloLeaseValidoPrimaDellaRete() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload())
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        await fixture.hold()
        let task = Task { await store.testActivate(client: client(fixture), queue: q) }
        await waitForRequest(fixture, path: "/v1/habits")
        #expect(location.monitoring); #expect(store.deviceEnabled)
        #expect(store.snapshot == nil); #expect(location.requests.isEmpty)
        await fixture.release(); await task.value
        #expect(await fixture.count("/v1/habits/question") == 0)
    }
    @Test func autorizzazioneSemprePersistitaAnchePrimaDellaRete() throws {
        let location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        var consent = payload()
        consent.wasAuthorizedAlways = false
        try q.begin(consent)
        let store = makeStore(location: location)
        let resumedLocation = HabitsLocationFixture()
        resumedLocation.authorizationStatus = .authorizedWhenInUse
        let resumed = makeStore(location: resumedLocation)
        defer { store.deactivate(); resumed.deactivate(); q.clear() }
        store.testConfigure(client: nil, queue: q)
        #expect(location.monitoring)
        #expect(try q.load()?.wasAuthorizedAlways == true)
        resumed.testConfigure(client: nil, queue: q)
        #expect(!resumed.deviceEnabled); #expect(!resumedLocation.monitoring)
        #expect(try q.load() == nil)
    }
    @Test func leaseScadutoNonRaccoglieOfflineERiprendeDopoConfermaServer() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload(lease: Date().addingTimeInterval(-1)))
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        await fixture.fail()
        await store.testActivate(client: client(fixture), queue: q)
        store.locationManager(CLLocationManager(), didVisit: HabitsVisitFixture(arrival: Date().addingTimeInterval(-60)))
        #expect(!location.monitoring); #expect(!store.deviceEnabled)
        #expect(try q.load()?.visits.isEmpty == true); #expect(store.error != nil)
        let online = HabitsTransportFixture()
        await store.testActivate(client: client(online), queue: q)
        #expect(location.monitoring); #expect(store.deviceEnabled)
        #expect(location.requests.isEmpty)
    }
    @Test func leaseScadeAncheSenzaNuoveVisite() async throws {
        let location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        var instant = Date()
        let store = HabitsStore(observeLocation: false, location: location, now: { instant }, isActive: { false })
        defer { store.deactivate(); q.clear() }
        try q.begin(payload(lease: instant.addingTimeInterval(0.05)))
        store.testConfigure(client: nil, queue: q)
        #expect(location.monitoring)
        instant = instant.addingTimeInterval(1)
        try await Task.sleep(for: .milliseconds(150))
        #expect(!location.monitoring); #expect(!store.deviceEnabled)
        #expect(store.error != nil)
    }
    @Test func erroreLetturaProtettaFermaIlMonitoraggio() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("habits-corrupt-\(UUID().uuidString)")
        let q = queue(directory: directory), location = HabitsLocationFixture()
        location.authorizationStatus = .authorizedAlways
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear(); try? FileManager.default.removeItem(at: directory) }
        try q.begin(payload())
        store.testConfigure(client: nil, queue: q)
        #expect(location.monitoring)
        try Data("corrupt".utf8).write(to: directory.appendingPathComponent(q.scope + ".sealed"))
        store.locationManager(CLLocationManager(), didVisit: HabitsVisitFixture(arrival: Date().addingTimeInterval(-60)))
        #expect(!location.monitoring); #expect(!store.deviceEnabled)
        #expect(store.error != nil)
    }
    @Test func erroreScritturaNonContinuaARaccogliereENonPerdeLaCoda() throws {
        let location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        let visits = (0..<1000).map { index in observation(arrival: Date().addingTimeInterval(Double(-index - 120))) }
        try q.begin(payload(visits: visits))
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: nil, queue: q)
        let visit = HabitsVisitFixture(arrival: Date().addingTimeInterval(-10))
        store.locationManager(CLLocationManager(), didVisit: visit)
        #expect(!location.monitoring); #expect(!store.deviceEnabled)
        #expect(store.error != nil); #expect(try q.load()?.visits == visits)
        store.locationManager(CLLocationManager(), didVisit: visit)
        #expect(!location.monitoring)
    }
    @Test func callbackParzialiFuoriOrdineMantengonoLaPartenza() throws {
        let location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload())
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: nil, queue: q)
        let arrival = Date().addingTimeInterval(-600), departure = Date().addingTimeInterval(-60)
        let manager = CLLocationManager()
        store.locationManager(manager, didVisit: HabitsVisitFixture(arrival: arrival, departure: departure))
        store.locationManager(manager, didVisit: HabitsVisitFixture(arrival: arrival))
        store.locationManager(manager, didVisit: HabitsVisitFixture(arrival: arrival, departure: departure.addingTimeInterval(-30)))
        let saved = try #require(try q.load())
        #expect(saved.visits.count == 1)
        #expect(saved.visits.first?.departure == ISO8601DateFormatter().string(from: departure))
    }
    @Test func confermaUploadNonRimuoveUnaPartenzaArrivataDuranteInvio() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        let arrival = Date().addingTimeInterval(-600), departure = Date().addingTimeInterval(-60)
        try q.begin(payload(visits: [observation(arrival: arrival)]))
        let store = makeStore(location: location)
        defer { store.deactivate(); q.clear() }
        store.testConfigure(client: client(fixture), queue: q)
        await fixture.hold("/v1/habits/visits")
        let task = Task { await store.refresh() }
        await waitForRequest(fixture, path: "/v1/habits/visits")
        store.locationManager(CLLocationManager(), didVisit: HabitsVisitFixture(arrival: arrival, departure: departure))
        let departureBeforeAcknowledgement = try? q.load()?.visits.first?.departure
        await fixture.release(holdingNext: "/v1/habits/visits")
        await waitForRequest(fixture, path: "/v1/habits/visits", count: 2)
        let queuedDeparture = try? q.load()?.visits.first?.departure
        await fixture.release(); await task.value
        #expect(departureBeforeAcknowledgement != nil)
        #expect(queuedDeparture == ISO8601DateFormatter().string(from: departure))
        #expect(try q.load()?.visits.isEmpty == true)
    }
    @Test func domandaVisibileSenzaConsensoLocaleERiaperturaNonLaConsuma() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        await fixture.offerQuestion()
        location.authorizationStatus = .denied
        let store = HabitsStore(observeLocation: false, location: location, isActive: { true })
        defer { store.deactivate(); q.clear() }
        await store.testActivate(client: client(fixture), queue: q)
        #expect(store.question?.placeId == "place")
        #expect(store.snapshot?.places.count == 1)
        #expect(!store.deviceEnabled); #expect(location.requests.isEmpty)
        store.scrubPresentation()
        #expect(store.snapshot == nil); #expect(store.question?.placeId == "place")
        await store.refresh()
        #expect(store.question?.placeId == "place")
        #expect(await fixture.count("/v1/habits/question") == 1)
        await fixture.setState(habitsFixture.replacingOccurrences(of: #""collecting":true"#, with: #""collecting":false"#))
        await store.refresh()
        #expect(store.question == nil); #expect(store.snapshot?.collecting == false)
    }
    @Test func rispostaDomandaInBackgroundNonRipubblicaDatiERestaDisponibileAlRientro() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        var active = true
        let store = HabitsStore(observeLocation: false, location: location, isActive: { active })
        defer { store.deactivate(); q.clear() }
        await fixture.offerQuestion(); await fixture.hold("/v1/habits/question")
        store.testConfigure(client: client(fixture), queue: q)
        let task = Task { await store.refresh() }
        await waitForRequest(fixture, path: "/v1/habits/question")
        active = false; store.scrubPresentation()
        await fixture.release(); await task.value
        #expect(store.question == nil); #expect(store.snapshot == nil)
        active = true
        await store.refresh()
        #expect(store.question?.placeId == "place")
        #expect(await fixture.count("/v1/habits/question") == 1)
        #expect(location.requests.isEmpty)
    }
    @Test func secondaLetturaRecepiscePausaRemota() async throws {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        location.authorizationStatus = .authorizedAlways
        try q.begin(payload())
        let store = HabitsStore(observeLocation: false, location: location, isActive: { true })
        defer { store.deactivate(); q.clear() }
        await fixture.offerQuestion(); await fixture.hold("/v1/habits/question")
        store.testConfigure(client: client(fixture), queue: q)
        let task = Task { await store.refresh() }
        await waitForRequest(fixture, path: "/v1/habits/question")
        await fixture.setState(habitsFixture.replacingOccurrences(of: #""collecting":true"#, with: #""collecting":false"#))
        await fixture.release(); await task.value
        #expect(store.snapshot?.collecting == false); #expect(store.question == nil)
        #expect(!location.monitoring); #expect(!store.deviceEnabled); #expect(try q.load() == nil)
    }
    @Test func riaperturaDuranteLetturaAggiornaLaNuovaPresentazione() async {
        let fixture = HabitsTransportFixture(), location = HabitsLocationFixture(), q = queue()
        let store = HabitsStore(observeLocation: false, location: location, isActive: { true })
        defer { store.deactivate(); q.clear() }
        await fixture.hold()
        store.testConfigure(client: client(fixture), queue: q)
        let task = Task { await store.refresh() }
        await waitForRequest(fixture, path: "/v1/habits")
        store.scrubPresentation()
        await store.refresh()
        await fixture.release(); await task.value
        for _ in 0..<1000 {
            if store.snapshot != nil { break }
            await Task.yield()
        }
        #expect(store.snapshot != nil)
        #expect(await fixture.count("/v1/habits") >= 2)
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
        let state=try JSONDecoder().decode(HabitsSnapshot.self,from:Data(habitsFixture.utf8));let store=makeStore();store.testConfigure(client:nil,queue:nil,snapshot:state)
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
