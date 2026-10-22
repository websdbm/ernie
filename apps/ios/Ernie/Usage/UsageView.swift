import SwiftUI
import Charts

struct UsageView: View {
    let scope: UsageScope
    @Environment(\.dismiss) private var dismiss
    @State private var path: [UsageQuery] = []

    var body: some View {
        NavigationStack(path: $path) {
            UsagePage(initialQuery: UsageQuery(scope: scope), selectAccount: { path.append($0) })
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } }
                }
                .navigationDestination(for: UsageQuery.self) { query in
                    UsagePage(initialQuery: query, selectAccount: { path.append($0) })
                }
        }
        .tint(Theme.accentText)
    }
}

private struct UsageRequestIdentity: Equatable {
    var query: UsageQuery
    var credentials: Credentials?
    var admin: Bool
}

private struct UsagePage: View {
    @Environment(AppModel.self) private var model
    @State private var store = UsageStore()
    @State private var query: UsageQuery
    var selectAccount: (UsageQuery) -> Void

    init(initialQuery: UsageQuery, selectAccount: @escaping (UsageQuery) -> Void) {
        _query = State(initialValue: initialQuery); self.selectAccount = selectAccount
    }
    private var admin: Bool { model.profile?.capabilities?.usageAdmin == true }
    private var allowed: Bool { !query.scope.requiresAdmin || admin }
    private var identity: UsageRequestIdentity { .init(query: query, credentials: model.credentials, admin: admin) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if model.credentials == nil {
                    ContentUnavailableView("Accedi per vedere i consumi", systemImage: "person.crop.circle.badge.exclamationmark")
                } else if !allowed {
                    ContentUnavailableView("Accesso non disponibile", systemImage: "lock", description: Text("Il riepilogo di tutte le installazioni richiede l’abilitazione amministratore."))
                } else {
                    UsagePeriodControls(query: $query)
                    if store.loading {
                        ProgressView("Caricamento dei consumi…").frame(maxWidth: .infinity, minHeight: 160)
                    } else if let error = store.error {
                        VStack(spacing: 14) {
                            ContentUnavailableView("Consumi non disponibili", systemImage: store.accessDenied ? "lock" : "wifi.exclamationmark", description: Text(error))
                            if !store.accessDenied { Button("Riprova") { Task { await load() } }.buttonStyle(.borderedProminent) }
                        }
                    } else if let report = store.report(for: model.credentials, query: query) {
                        UsageReportContent(report: report, query: query) { account in
                            var accountQuery = query
                            accountQuery.scope = .account(id: account.id, name: account.displayName)
                            selectAccount(accountQuery)
                        }
                    } else {
                        ProgressView("Caricamento dei consumi…").frame(maxWidth: .infinity, minHeight: 160)
                    }
                }
            }
            .padding(16).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }
        .background(Theme.ground).foregroundStyle(Theme.ink)
        .navigationTitle(UsagePresentation.navigationTitle(scope: query.scope,
            report: store.report(for: model.credentials, query: query),
            authorized: model.credentials != nil && allowed && !store.accessDenied))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: identity) { await load() }
        .refreshable { await load() }
        .onDisappear { store.clear() }
    }
    private func load() async {
        guard allowed, let api = model.api else { store.clear(); return }
        await store.load(query, credentials: api.credentials, using: api.usage)
    }
}

struct UsagePeriodControls: View {
    @Binding var query: UsageQuery
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(spacing: 12) {
            if dynamicTypeSize >= .xxxLarge {
                periodPicker.pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                periodPicker.pickerStyle(.segmented)
            }
            HStack(spacing: 8) {
                Button { query = query.shifted(-1) } label: {
                    Image(systemName: "chevron.left").frame(width: 44, height: 44)
                }.accessibilityLabel("Periodo precedente")
                Text(UsagePresentation.periodTitle(query)).font(.headline)
                    .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                    .accessibilityAddTraits(.isHeader)
                Button { query = query.shifted(1) } label: {
                    Image(systemName: "chevron.right").frame(width: 44, height: 44)
                }.disabled(!query.canAdvance()).accessibilityLabel("Periodo successivo")
            }
            DatePicker("Scegli data", selection: Binding(get: { query.anchor ?? .now }, set: {
                query.date = UsageQuery.dateString($0, timezone: query.calendar.timeZone)
            }), in: ...Date.now, displayedComponents: .date)
                .datePickerStyle(.compact).environment(\.timeZone, query.calendar.timeZone)
                .environment(\.locale, Locale(identifier: "it_IT"))
            Text("Fuso orario: \(query.timezone)").font(.caption).foregroundStyle(Theme.inkSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .tint(Theme.accentText)
    }
    private var periodPicker: some View {
        Picker("Periodo", selection: $query.period) {
            ForEach(UsagePeriod.allCases) { Text($0.label).tag($0) }
        }
    }
}

/// Contenuto puro, riutilizzato dai render deterministici senza account o rete.
struct UsageReportContent: View {
    let report: UsageReport
    let query: UsageQuery
    var selectAccount: (UsageReport.Account) -> Void = { _ in }
    @State private var showCalculation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let account = report.account {
                VStack(alignment: .leading, spacing: 4) {
                    Text(account.displayName).font(.title2.bold())
                    Text("Assistente: \(account.companionName)").foregroundStyle(Theme.inkSecondary)
                    if account.deleted { Text("Account eliminato · storico conservato").font(.caption).foregroundStyle(Theme.inkSecondary) }
                }
            }
            totalCard
            if report.totals.calls == 0 {
                Label("Nessuna chiamata registrata nel periodo", systemImage: "tray")
                    .font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16).ernieSurface()
            }
            if !report.series.isEmpty { UsageChart(report: report, period: query.period) }
            if query.scope == .all, let accounts = report.accounts {
                accountList(accounts)
            }
            if query.scope == .all, let provider = report.providerAccount { providerCard(provider) }
            breakdown("Per attività", rows: report.byActivity)
            breakdown("Per modello", rows: report.byModel)
            breakdown("Per fornitore", rows: report.byProvider)
            coverage
            if let generated = UsagePresentation.date(report.generatedAt) {
                Text("Aggiornato il \(UsagePresentation.formatted(generated, format: "d MMM yyyy, HH:mm", timezone: report.timezone))")
                    .font(.caption).foregroundStyle(Theme.inkSecondary)
            }
        }
        .foregroundStyle(Theme.ink)
    }

    private var totalCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Spesa del periodo").font(.headline)
            Text(UsagePresentation.amount(report.totals.amountUsd))
                .font(.system(.largeTitle, design: .rounded, weight: .bold)).foregroundStyle(Theme.accentText)
                .minimumScaleFactor(0.7).lineLimit(2)
            Text(report.totals.estimatedUsd > 0
                 ? "Include \(UsagePresentation.amount(report.totals.estimatedUsd)) stimati."
                 : "Costi comunicati dai servizi AI.")
                .font(.subheadline).foregroundStyle(Theme.inkSecondary)
            metric("Chiamate AI", value: report.totals.calls.formatted(.number.locale(Locale(identifier: "it_IT"))))
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).ernieSurface()
    }
    private var coverage: some View {
        DisclosureGroup("Come sono calcolati i consumi", isExpanded: $showCalculation) {
            VStack(alignment: .leading, spacing: 12) {
                metric("Comunicati dai servizi", value: UsagePresentation.amount(report.totals.reportedUsd))
                metric("Stimati", value: UsagePresentation.amount(report.totals.estimatedUsd))
                metric("Token in ingresso", value: report.totals.inputTokens.formatted(.number.locale(Locale(identifier: "it_IT"))))
                metric("Token in uscita", value: report.totals.outputTokens.formatted(.number.locale(Locale(identifier: "it_IT"))))
                if let raw = report.coverage.since, let date = UsagePresentation.date(raw) {
                    Text("Registrazioni dal \(UsagePresentation.formatted(date, format: "d MMMM yyyy", timezone: report.timezone)).")
                }
                if report.coverage.historicalMayBeIncomplete { Text("Lo storico iniziale potrebbe essere incompleto.") }
                if !report.coverage.note.isEmpty { Text(report.coverage.note) }
            }
            .font(.footnote).foregroundStyle(Theme.inkSecondary).padding(.top, 12)
        }.font(.subheadline).padding(18).ernieSurface()
    }
    private func metric(_ label: String, value: String) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).foregroundStyle(Theme.inkSecondary).fixedSize()
                Spacer(minLength: 12)
                Text(value).fontWeight(.semibold).fixedSize()
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(label).foregroundStyle(Theme.inkSecondary)
                Text(value).fontWeight(.semibold)
            }
        }.font(.subheadline).accessibilityElement(children: .combine)
    }
    @ViewBuilder private func breakdown(_ title: String, rows: [UsageReport.Breakdown]) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.label).font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
                        Text(UsagePresentation.amount(row.amountUsd)).font(.subheadline.bold()).foregroundStyle(Theme.accentText)
                        Text("\(row.calls) chiamate registrate").font(.caption).foregroundStyle(Theme.inkSecondary)
                    }.accessibilityElement(children: .combine)
                    if row.id != rows.last?.id { Divider() }
                }
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading).ernieSurface()
        }
    }
    private func accountList(_ accounts: [UsageReport.Account]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Utenti Ernie").font(.headline).accessibilityAddTraits(.isHeader)
            Text("Account con l’app installata. Più dispositivi della stessa persona sono riuniti qui.").font(.footnote).foregroundStyle(Theme.inkSecondary)
            if accounts.isEmpty { Text("Nessun account nel riepilogo.").foregroundStyle(Theme.inkSecondary) }
            ForEach(accounts) { account in
                Button { selectAccount(account) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(account.displayName).font(.headline)
                            Text(account.companionName).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                            Text(UsagePresentation.amount(account.amountUsd ?? 0)).font(.subheadline.bold())
                            Text("\(account.calls ?? 0) chiamate registrate\(account.deleted ? " · Account eliminato" : "")")
                                .font(.caption).foregroundStyle(Theme.inkSecondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right").accessibilityHidden(true)
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHint("Mostra i consumi di questo account nel periodo selezionato")
                if account.id != accounts.last?.id { Divider() }
            }
        }.padding(18).ernieSurface()
    }
    private func providerCard(_ provider: UsageReport.ProviderAccount) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Saldo OpenRouter").font(.headline)
            if provider.status == "available", let balance = provider.balanceUsd {
                Text(UsagePresentation.amount(balance)).font(.title2.bold()).foregroundStyle(Theme.accentText)
            } else {
                Text(provider.status == "not_configured" ? "Consultazione del saldo non configurata." : "Saldo momentaneamente non disponibile.")
                    .foregroundStyle(Theme.inkSecondary)
            }
            Text("Saldo condiviso del servizio, distinto dai consumi registrati da Ernie.").font(.footnote).foregroundStyle(Theme.inkSecondary)
            if let date = UsagePresentation.date(provider.checkedAt) {
                Text("Verificato il \(UsagePresentation.formatted(date, format: "d MMM, HH:mm", timezone: report.timezone))").font(.caption).foregroundStyle(Theme.inkSecondary)
            }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).ernieSurface()
    }
}

struct UsageChart: View {
    let report: UsageReport
    let period: UsagePeriod
    @State private var showValues = false
    @State private var selectedPosition: Double?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var ceiling: Double { UsagePresentation.chartCeiling(report.series.map(\.amountUsd)) }
    private var selectedBucket: UsageReport.Bucket? {
        guard let position = selectedPosition, position.isFinite else { return nil }
        let index = Int(position.rounded())
        return report.series.indices.contains(index) ? report.series[index] : nil
    }
    private func label(_ bucket: UsageReport.Bucket, detailed: Bool = false) -> String {
        UsagePresentation.bucketLabel(bucket.date, period: period, timezone: report.timezone, detailed: detailed)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Andamento della spesa").font(.headline).accessibilityAddTraits(.isHeader)
            Text(period == .day ? "Spesa per ora · USD" : period == .year ? "Spesa per mese · USD" : "Spesa per giorno · USD")
                .font(.caption).foregroundStyle(Theme.inkSecondary)
            Chart(Array(report.series.enumerated()), id: \.element.id) { index, bucket in
                RectangleMark(xStart: .value("Inizio", Double(index) - 0.34),
                              xEnd: .value("Fine", Double(index) + 0.34),
                              yStart: .value("Base", 0),
                              yEnd: .value("USD", bucket.amountUsd))
                    .foregroundStyle(Theme.accent)
                    .cornerRadius(3)
                    .opacity(selectedBucket == nil || selectedBucket?.id == bucket.id ? 1 : 0.35)
                    .accessibilityLabel(label(bucket, detailed: true))
                    .accessibilityValue("\(UsagePresentation.amount(bucket.amountUsd)), \(bucket.calls) chiamate registrate")
            }
            .chartXScale(domain: -0.5...max(0.5, Double(report.series.count) - 0.5))
            .chartYScale(domain: 0...ceiling)
            .chartXSelection(value: $selectedPosition)
            .chartGesture { proxy in
                SpatialTapGesture().onEnded { value in
                    proxy.selectXValue(at: value.location.x)
                }
            }
            .chartXAxis {
                AxisMarks(values: UsagePresentation.chartTicks(count: report.series.count, maximum: dynamicTypeSize >= .xxxLarge ? 3 : 4)) { value in
                    AxisTick()
                    AxisValueLabel(anchor: value.as(Double.self) == 0 ? .topLeading : value.as(Double.self) == Double(report.series.count - 1) ? .topTrailing : .top, collisionResolution: .greedy) {
                        if let position = value.as(Double.self), report.series.indices.contains(Int(position)) {
                            Text(label(report.series[Int(position)])).font(.caption2)
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: [0, ceiling / 3, ceiling * 2 / 3, ceiling]) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let amount = value.as(Double.self) {
                            Text(amount.formatted(.number.precision(.fractionLength(3)).locale(Locale(identifier: "it_IT"))))
                                .font(.caption2).monospacedDigit()
                        }
                    }
                }
            }
            .frame(height: dynamicTypeSize >= .xxxLarge ? 220 : 180)
            .accessibilityLabel("Spesa nel periodo selezionato, in dollari statunitensi")
            .accessibilityIdentifier("usage.chart")
            if let bucket = selectedBucket {
                VStack(alignment: .leading, spacing: 3) {
                    Text(label(bucket, detailed: true)).font(.subheadline.weight(.medium))
                    Text("\(UsagePresentation.amount(bucket.amountUsd)) · \(bucket.calls) chiamate AI")
                        .font(.subheadline).foregroundStyle(Theme.accentText)
                }.accessibilityElement(children: .combine).accessibilityIdentifier("usage.chart.selection")
            } else {
                Text("Tocca il grafico per leggere un importo.").font(.caption).foregroundStyle(Theme.inkSecondary)
            }
            DisclosureGroup("Valori del grafico", isExpanded: $showValues) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(report.series) { bucket in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(label(bucket, detailed: true)).fontWeight(.medium)
                            Text("\(UsagePresentation.amount(bucket.amountUsd)) · \(bucket.calls) chiamate registrate")
                                .foregroundStyle(Theme.inkSecondary)
                        }.font(.footnote).accessibilityElement(children: .combine)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
            }.font(.subheadline).tint(Theme.accentText)
        }.padding(18).ernieSurface()
            .onChange(of: report.series) { selectedPosition = nil }
    }
}
