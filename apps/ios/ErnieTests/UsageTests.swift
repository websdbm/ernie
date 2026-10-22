import Foundation
import SwiftUI
import UIKit
import Testing
@testable import Ernie

private enum UsageFixtures {
    static let accountID = "00000000-0000-4000-8000-000000000001"
    static let now = UsagePresentation.date("2026-10-20T12:00:00Z")!
    static var query: UsageQuery { UsageQuery(date: now, timezone: TimeZone(identifier: "Europe/Rome")!) }
    static func report(scope: String = "personal", amount: Double = 0.034876) -> UsageReport {
        let series: [UsageReport.Bucket] = (1...31).map { day in
            let cost = day < 21 ? Double(day % 5) * 0.0007 : 0.0
            let calls = day < 21 ? day % 5 : 0
            return UsageReport.Bucket(date: String(format: "2026-10-%02dT12:00:00Z", day), amountUsd: cost, calls: calls)
        }
        let accounts: [UsageReport.Account]? = scope == "all" ? [
            .init(id: accountID, name: "Anna Rossi", companionName: "Ernie", deleted: false, amountUsd: 0.024876, calls: 30),
            .init(id: "00000000-0000-4000-8000-000000000002", name: "Luca Bianchi", companionName: "Orso blu", deleted: true, amountUsd: 0.01, calls: 12)
        ] : nil
        let provider: UsageReport.ProviderAccount? = scope == "all" ? .init(provider: "openrouter", status: "available", balanceUsd: 8.4265, totalCreditsUsd: 10, totalUsageUsd: 1.5735, checkedAt: "2026-10-20T12:00:00Z") : nil
        return UsageReport(currency: "USD", timezone: "Europe/Rome", period: "month", from: "2026-09-30T22:00:00Z", to: "2026-10-31T23:00:00Z", generatedAt: "2026-10-20T12:00:00Z", scope: scope,
                    totals: .init(amountUsd: amount, reportedUsd: 0.030001, estimatedUsd: 0.004875, calls: 42, inputTokens: 18240, outputTokens: 2170),
                    series: series,
                    byModel: [.init(id: "test/model", label: "Modello conversazione", amountUsd: 0.024876, calls: 30), .init(id: "voice", label: "Sintesi vocale", amountUsd: 0.01, calls: 12)],
                    byActivity: [.init(id: "chat", label: "Conversazione", amountUsd: 0.02, calls: 25), .init(id: "brain", label: "Organizzazione del Second Brain", amountUsd: 0.014876, calls: 17)],
                    byProvider: [.init(id: "openrouter", label: "OpenRouter", amountUsd: amount, calls: 42)],
                    coverage: .init(since: "2026-10-18T10:00:00Z", historicalMayBeIncomplete: true, note: "I costi stimati sono approssimativi. I dispositivi dello stesso account condividono i consumi."), adminAvailable: scope != "personal",
                    accounts: accounts,
                    account: nil,
                    providerAccount: provider)
    }
}

struct UsageTests {
    @Test func APIUsaEndpointPersonaleEPermessiEsplicitiCompatibili() async throws {
        let response = try JSONEncoder().encode(UsageFixtures.report())
        let api = ApiClient(credentials: .init(serverURL: URL(string: "https://example.test")!, apiKey: "test"), transport: { request in
            #expect(request.httpMethod == "GET")
            #expect(request.url?.path == "/v1/usage")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test")
            return (response, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        #expect(try await api.usage(UsageFixtures.query).totals.calls == 42)
        let legacy = #"{"userId":"1","displayName":"Anna","companionName":"Ernie","role":"owner","settings":{}}"#
        let decoder = JSONDecoder()
        #expect(try decoder.decode(Profile.self, from: Data(legacy.utf8)).capabilities?.usageAdmin != true)
        let granted = legacy.replacingOccurrences(of: #""settings":{}"#, with: #""settings":{},"capabilities":{"usageAdmin":true}"#)
        #expect(try decoder.decode(Profile.self, from: Data(granted.utf8)).capabilities?.usageAdmin == true)
    }

    @Test func decodificaPersonaleAdminSaldoEAccountEliminato() throws {
        let decoder = JSONDecoder()
        let personal = try decoder.decode(UsageReport.self, from: JSONEncoder().encode(UsageFixtures.report()))
        #expect(personal.accounts == nil)
        #expect(personal.providerAccount == nil)
        #expect(personal.series.count == 31)
        #expect(personal.series.last?.amountUsd == 0)
        let all = try decoder.decode(UsageReport.self, from: JSONEncoder().encode(UsageFixtures.report(scope: "all")))
        #expect(all.accounts?.last?.deleted == true)
        #expect(all.providerAccount?.balanceUsd == 8.4265)
        #expect(all.coverage.historicalMayBeIncomplete)
        let account = #"{"id":"1","name":"Anna","companionName":"Ernie","deleted":false}"#
        #expect(try decoder.decode(UsageReport.Account.self, from: Data(account.utf8)).amountUsd == nil)
        var unavailable = all
        unavailable.providerAccount = .init(provider: "openrouter", status: "unavailable", checkedAt: all.generatedAt)
        #expect(try decoder.decode(UsageReport.self, from: JSONEncoder().encode(unavailable)).providerAccount?.balanceUsd == nil)
    }

    @Test func queryAmministrativaEsplicitaConFusoEAccountCodificati() throws {
        var query = UsageFixtures.query
        #expect(try #require(URLComponents(string: query.path())).path == "/v1/usage")
        query.scope = .all
        var components = try #require(URLComponents(string: query.path()))
        #expect(components.path == "/v1/usage/admin")
        #expect(!components.queryItems!.contains { $0.name == "accountId" })
        query.scope = .account(id: UsageFixtures.accountID, name: "Anna & Luca")
        query.timezone = "Etc/GMT+3"
        components = try #require(URLComponents(string: query.path()))
        #expect(query.path().contains("%2B"))
        #expect(components.queryItems?.first { $0.name == "accountId" }?.value == UsageFixtures.accountID)
        #expect(components.queryItems?.first { $0.name == "timezone" }?.value == "Etc/GMT+3")
        #expect(!query.path().contains("Anna"))
        #expect(UsageScope.personal.requiresAdmin == false)
        #expect(UsageScope.all.requiresAdmin)
    }

    @Test func periodiCalendarioLunediMesiBisestiliECambioOra() throws {
        var query = UsageFixtures.query
        query.period = .week; query.date = "2026-10-18" // domenica
        #expect(UsageQuery.dateString(try #require(query.interval?.start), timezone: query.calendar.timeZone) == "2026-10-12")
        #expect(query.shifted(1).date == "2026-10-19")
        query.period = .month; query.date = "2024-01-31"
        #expect(query.shifted(1).date == "2024-02-01")
        #expect(query.shifted(2).date == "2024-03-01")
        #expect(query.shifted(1).shifted(-1).date == "2024-01-01")
        query.period = .day; query.date = "2026-03-29"
        #expect(query.interval?.duration == Double(23 * 3600))
        #expect(query.shifted(1).date == "2026-03-30")
        query.date = "2026-10-25"
        #expect(query.interval?.duration == Double(25 * 3600))
        query.period = .year; query.date = "2024-02-29"
        #expect(query.shifted(1).date == "2025-01-01")
        query = UsageFixtures.query
        #expect(!query.canAdvance(now: UsageFixtures.now))
        #expect(query.shifted(-1).canAdvance(now: UsageFixtures.now))
        query.date = "not-a-date"
        #expect(query.interval == nil)
        #expect(!query.canAdvance(now: UsageFixtures.now))
    }

    @Test func importiPiccoliNonDiventanoZeroEErroriDistinti() {
        #expect(UsagePresentation.amount(0) == "0,000 USD")
        #expect(UsagePresentation.amount(0.00001234) == "<0,001 USD")
        #expect(UsagePresentation.amount(0.000000001).hasPrefix("<"))
        #expect(UsagePresentation.amount(8.4267) == "8,427 USD")
        #expect(UsagePresentation.amount(0.001) == "0,001 USD")
        #expect(UsagePresentation.amount(12.340001) == "12,340 USD")
        #expect(UsagePresentation.amount(.infinity) == "— USD")
        #expect(UsagePresentation.error(ApiError(status: 401, code: "", message: "")).contains("Accedi"))
        #expect(UsagePresentation.error(ApiError(status: 403, code: "", message: "")).contains("non può"))
        #expect(UsagePresentation.error(ApiError(status: 400, code: "", message: "")).contains("data"))
        #expect(UsagePresentation.error(URLError(.notConnectedToInternet)).contains("connessione"))
        #expect(UsagePresentation.date("2026-10-20T12:00:00.123Z") != nil)
        #expect(UsagePresentation.date("2026-10-20T12:00:00Z") != nil)
        let scope = UsageScope.account(id: UsageFixtures.accountID, name: "Nome nella route precedente")
        #expect(UsagePresentation.navigationTitle(scope: scope, report: nil, authorized: true) == "Consumi account")
        var report = UsageFixtures.report(scope: "account")
        report.account = .init(id: UsageFixtures.accountID, name: "Anna Rossi", companionName: "Ernie", deleted: false)
        #expect(UsagePresentation.navigationTitle(scope: scope, report: report, authorized: true) == "Anna Rossi")
        #expect(UsagePresentation.navigationTitle(scope: scope, report: report, authorized: false) == "Consumi")
    }

    @Test func graficoHaPocheEtichetteDistinteEScalaLeggibile() {
        for count in [7, 12, 23, 24, 25, 28, 30, 31] {
            for maximum in [3, 4] {
                let ticks = UsagePresentation.chartTicks(count: count, maximum: maximum)
                #expect(ticks.count <= maximum)
                #expect(Set(ticks).count == ticks.count)
                #expect(ticks.first == 0 && ticks.last == Double(count - 1))
            }
        }
        #expect(UsagePresentation.chartTicks(count: 0).isEmpty)
        #expect(UsagePresentation.chartTicks(count: 1) == [0])
        #expect(UsagePresentation.chartCeiling([0, 0.0000001]) == 0.003)
        #expect(UsagePresentation.chartCeiling([0.487, .nan]) >= 0.487)
    }
}

@MainActor private final class UsageRequests {
    var pending: [CheckedContinuation<UsageReport, any Error>] = []
    func load(_ query: UsageQuery) async throws -> UsageReport {
        try await withCheckedThrowingContinuation { pending.append($0) }
    }
}

@MainActor struct UsageStoreTests {
    let credentials = Credentials(serverURL: URL(string: "https://example.test")!, apiKey: "fake-key")
    private func waitFor(_ condition: () -> Bool) async {
        for _ in 0..<1000 { if condition() { return }; await Task.yield() }
        #expect(condition())
    }

    @Test func cambioAccountIgnoraRispostaTardivaEDatiSessionePrecedente() async {
        let store = UsageStore(), requests = UsageRequests(), query = UsageFixtures.query
        let previous = Task { await store.load(query, credentials: credentials, using: requests.load) }
        await waitFor { requests.pending.count == 1 }
        var nextQuery = query
        nextQuery.scope = .account(id: UsageFixtures.accountID, name: "Anna")
        await store.load(nextQuery, credentials: credentials) { _ in UsageFixtures.report(scope: "account", amount: 2) }
        requests.pending[0].resume(returning: UsageFixtures.report(amount: 99))
        await previous.value
        #expect(store.report?.totals.amountUsd == 2)
        #expect(store.report(for: credentials, query: query) == nil)
        let other = Credentials(serverURL: credentials.serverURL, apiKey: "another-account")
        #expect(store.report(for: other, query: nextQuery) == nil)
        #expect(store.report(for: nil, query: nextQuery) == nil)
    }

    @Test func logoutAnnullaRichiestaENonRipristinaImporti() async {
        let store = UsageStore(), requests = UsageRequests()
        let task = Task { await store.load(UsageFixtures.query, credentials: credentials, using: requests.load) }
        await waitFor { requests.pending.count == 1 }
        store.clear()
        requests.pending[0].resume(returning: UsageFixtures.report())
        await task.value
        #expect(store.report == nil)
        #expect(store.error == nil)
        #expect(!store.loading)
    }

    @Test func nuovaQueryAnnullaTrasportoE403PulisceValori() async {
        let store = UsageStore()
        var started = false, cancelled = false
        let old = Task {
            await store.load(UsageFixtures.query, credentials: credentials) { _ in
                started = true
                do { try await Task.sleep(for: .seconds(60)) }
                catch { cancelled = Task.isCancelled; throw error }
                return UsageFixtures.report()
            }
        }
        await waitFor { started }
        await store.load(UsageFixtures.query.shifted(-1), credentials: credentials) { _ in UsageFixtures.report() }
        await old.value
        #expect(cancelled)
        #expect(store.report != nil)
        await store.load(UsageFixtures.query, credentials: credentials) { _ in throw ApiError(status: 403, code: "forbidden", message: "") }
        #expect(store.report == nil)
        #expect(store.accessDenied)
        #expect(store.error != nil)
    }

    @Test func vuotoErroreERiprovaSonoStatiDistinti() async {
        let store = UsageStore()
        await store.load(UsageFixtures.query, credentials: credentials) { _ in throw URLError(.notConnectedToInternet) }
        #expect(store.report == nil && store.error != nil && !store.accessDenied)
        var empty = UsageFixtures.report(amount: 0)
        empty.totals.calls = 0; empty.series = []
        let result = empty
        await store.load(UsageFixtures.query, credentials: credentials) { _ in result }
        #expect(store.report?.totals.calls == 0)
        #expect(store.error == nil && !store.loading)
    }
}

@MainActor struct UsageRenderTests {
    @Test func graficiTuttiIPeriodiChiaroScuroE320Punti() async throws {
        for period in UsagePeriod.allCases {
            var query = UsageFixtures.query
            query.period = period
            let start = try #require(query.interval?.start)
            let count = period == .day ? 24 : period == .week ? 7 : period == .month ? 31 : 12
            let component: Calendar.Component = period == .day ? .hour : period == .year ? .month : .day
            var report = UsageFixtures.report()
            report.series = (0..<count).map { i in
                let date = query.calendar.date(byAdding: component, value: i, to: start)!
                return .init(date: ISO8601DateFormatter().string(from: date),
                             amountUsd: i == count - 4 ? 0.487 : i > count - 4 ? 0.167 : 0,
                             calls: i >= count - 4 ? 5 : 0)
            }
            for (name, width, scheme, size) in [("light", CGFloat(390), ColorScheme.light, DynamicTypeSize.large), ("dark", CGFloat(390), .dark, .large), ("compact", CGFloat(320), .dark, .xxxLarge)] {
                let view = UsageChart(report: report, period: period).padding(16).frame(width: width)
                    .background(Theme.ground).foregroundStyle(Theme.ink)
                    .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                    .environment(\.locale, Locale(identifier: "it_IT"))
                let renderer = ImageRenderer(content: view); renderer.scale = 2
                let image = try #require(renderer.uiImage)
                #expect(image.size.width == width)
                let png = try #require(image.pngData())
                try png.write(to: URL(fileURLWithPath: "/tmp/ernie-usage-chart-\(period.rawValue)-\(name).png"))
            }
        }
    }
    @Test func anteprimePersonaliAdminCompatteETestoGrande() async throws {
        for admin in [false, true] {
            for (name, width, scheme, size) in [("light", CGFloat(390), ColorScheme.light, DynamicTypeSize.large), ("dark", CGFloat(390), .dark, .large), ("compact", CGFloat(320), .light, .xxxLarge)] {
                var query = UsageFixtures.query
                if admin { query.scope = .all }
                let report = UsageFixtures.report(scope: admin ? "all" : "personal")
                let view = VStack(alignment: .leading, spacing: 20) {
                    Text(query.scope.title).font(.title2.bold())
                    UsagePeriodControls(query: .constant(query))
                    UsageReportContent(report: report, query: query)
                }.padding(16).frame(width: width).background(Theme.ground).foregroundStyle(Theme.ink)
                    .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
                    .environment(\.locale, Locale(identifier: "it_IT"))
                // Picker e DatePicker contengono UIKit: ImageRenderer li sostituisce con segnaposto.
                let viewport = ScrollView { view }.frame(width: width, height: 844).background(Theme.ground)
                    .environment(\.colorScheme, scheme)
                let controller = UIHostingController(rootView: viewport)
                controller.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
                let viewportSize = CGSize(width: width, height: 844)
                let window = UIWindow(frame: CGRect(origin: .zero, size: viewportSize))
                window.rootViewController = controller; window.isHidden = false
                controller.view.frame = window.bounds
                controller.view.setNeedsLayout(); controller.view.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(150))
                let format = UIGraphicsImageRendererFormat(); format.scale = 2
                let rendered = UIGraphicsImageRenderer(size: viewportSize, format: format).image { _ in
                    #expect(controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true))
                }
                window.isHidden = true
                let png = try #require(rendered.pngData())
                let url = URL(fileURLWithPath: "/tmp/ernie-usage-ios-\(admin ? "admin" : "personal")-\(name).png")
                try png.write(to: url)
                print("USAGE_SNAPSHOT: \(url.path)")
            }
        }
    }
}
