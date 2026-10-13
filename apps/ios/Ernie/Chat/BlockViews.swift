import Charts
import SwiftUI

/// Schede native per i blocchi strutturati del protocollo (v1.2).
struct BlockView: View {
    let block: ContentBlock
    var conversation: ConversationStore?

    var body: some View {
        switch block {
        case .webResults(let query, let results):
            WebResultsCard(query: query, results: results)
        case .list(let title, let items):
            ListCard(title: title, items: items)
        case .recipes(let recipes):
            RecipesCard(recipes: recipes, conversation: conversation)
        case .document(let block):
            DocumentCard(block: block, conversation: conversation)
        case .schema(let block):
            SchemaCard(block: block, conversation: conversation)
        case .shoppingList(let block):
            ShoppingListCard(block: block, conversation: conversation)
        case .shoppingLists(let block):
            ShoppingListsCard(block: block, conversation: conversation)
        case .documents(let block):
            DocumentsCard(block: block, conversation: conversation)
        case .reminders(let block):
            RemindersCard(block: block)
        case .citations(let block):
            CitationsCard(block: block)
        case .health(let block):
            HealthCard(block: block)
        case .unknown:
            EmptyView()
        }
    }
}

/// Promemoria: prossimi scatti con orario parlante; dalla scheda si annulla o si modifica al volo (testo, giorno e ora),
/// senza passare dalla chat. Lo stato arriva dallo store (server + notifiche locali + widget).
struct RemindersCard: View {
    let block: RemindersBlock
    @Environment(AppModel.self) private var model
    @State private var editing: String?

    /// Righe aggiornate: un promemoria modificato ha un id nuovo, la scheda lo segue.
    private var rows: [ReminderItem] {
        block.reminders.map { r in
            if let live = model.reminders.item(r.id) { return live }
            var x = r
            if r.status == "scheduled" { x.status = isPast(r) ? "done" : "cancelled" }
            return x
        }
    }

    private func isPast(_ r: ReminderItem) -> Bool {
        guard let at = ReminderStore.date(r.at) else { return false }
        return at <= .now
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(block.title, systemImage: "bell.fill").font(.subheadline.weight(.semibold))
            ForEach(rows) { r in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: r.status == "scheduled" ? "alarm" : r.status == "done" ? "checkmark.circle" : "xmark.circle")
                            .foregroundStyle(r.status == "scheduled" ? Color.accentColor : Color.secondary)
                        // Titolo a tutta larghezza; ora e comandi sulla riga sotto (prima il titolo restava schiacciato).
                        VStack(alignment: .leading, spacing: 4) {
                            Text(r.text)
                                .font(.callout)
                                .strikethrough(r.status == "cancelled", color: .secondary)
                                .foregroundStyle(r.status == "scheduled" ? .primary : .secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            HStack(spacing: 10) {
                                Text(Self.when(r) + Self.who(r)).font(.caption).foregroundStyle(.secondary)
                                Spacer(minLength: 0)
                                if r.status == "scheduled" {
                                    Button {
                                        editing = editing == r.id ? nil : r.id
                                    } label: {
                                        Image(systemName: editing == r.id ? "pencil.circle.fill" : "pencil.circle").foregroundStyle(Color.accentColor)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Modifica")
                                    Button("Annulla") { Task { await model.reminders.cancel(r) } }
                                        .font(.caption).buttonStyle(.bordered).controlSize(.mini)
                                }
                            }
                            if r.status == "scheduled" {
                                if let rep = r.repeatInfo {
                                    Label(rep.label, systemImage: "repeat").font(.caption).foregroundStyle(.secondary)
                                }
                                ReminderChannelChips(item: r)
                            }
                        }
                    }
                    if editing == r.id {
                        ReminderEditForm(item: r) { editing = nil }
                            .padding(10)
                            .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            if let err = model.reminders.lastError {
                Text(err).font(.caption2).foregroundStyle(.red)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .animation(.easeInOut(duration: 0.15), value: editing)
        .task { await model.reminders.refresh() }
    }

    /// Famiglia: «· per Giorgio» (messo da me a lui) o «· da papà» (messo a me).
    static func who(_ r: ReminderItem) -> String {
        if let f = r.forLabel { return " · per \(f)" }
        if let f = r.fromLabel { return " · da \(f)" }
        return ""
    }

    static func when(_ r: ReminderItem) -> String {
        guard let at = ReminderStore.date(r.at) else { return r.at }
        let cal = Calendar.current
        let time = at.formatted(date: .omitted, time: .shortened)
        if r.status == "cancelled" { return "annullato" }
        if cal.isDateInToday(at) { return (at <= .now ? "oggi alle " : "oggi alle ") + time + (at <= .now ? " · scattato" : "") }
        if cal.isDateInTomorrow(at) { return "domani alle \(time)" }
        return at.formatted(.dateTime.weekday(.wide).day().month(.wide).hour().minute())
    }
}

/// Modifica di un promemoria (testo, giorno e ora): usata dalla scheda in chat e dalla schermata Promemoria.
struct ReminderEditForm: View {
    let item: ReminderItem
    var onDone: () -> Void
    @Environment(AppModel.self) private var model
    @State private var draftText: String
    @State private var draftDate: Date
    @State private var saving = false

    init(item: ReminderItem, onDone: @escaping () -> Void) {
        self.item = item
        self.onDone = onDone
        _draftText = State(initialValue: item.text)
        _draftDate = State(initialValue: ReminderStore.date(item.at) ?? .now.addingTimeInterval(3600))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Cosa ti ricordo", text: $draftText)
                .textFieldStyle(.roundedBorder)
            DatePicker("Quando", selection: $draftDate, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.compact)
                .environment(\.locale, Locale(identifier: "it_IT"))
            HStack {
                Button("Salva") { Task { await save() } }
                    .buttonStyle(.borderedProminent).controlSize(.small)
                    .disabled(saving || draftText.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Lascia così") { onDone() }.controlSize(.small)
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let text = draftText.trimmingCharacters(in: .whitespaces)
        let changedText = text != item.text ? text : nil
        let changedDate = abs((ReminderStore.date(item.at) ?? .distantPast).timeIntervalSince(draftDate)) > 30 ? draftDate : nil
        if changedText == nil && changedDate == nil { onDone(); return }
        if await model.reminders.update(item, text: changedText, at: changedDate) { onDone() }
    }
}

/// Interruttori «Sveglia» ed «Email» di un promemoria in programma (valori dallo store, invio solo del campo cambiato).
struct ReminderChannelChips: View {
    let item: ReminderItem
    @Environment(AppModel.self) private var model
    /// Indirizzo digitato nell'invito «Qual è la tua email?».
    @State private var emailDraft = ""

    /// Predefinito: l'impostazione generale della sveglia.
    private var alarmOn: Bool { item.channels?.alarm ?? ReminderAlarms.enabled }
    private var emailOn: Bool { item.channels?.email ?? false }

    /// Invito a dare l'indirizzo: compare quando lo store segnala «needsEmail» per questo promemoria.
    private var askingEmail: Binding<Bool> {
        Binding(
            get: { model.reminders.needsEmailFor == model.reminders.resolve(item.id) },
            set: { if !$0 { model.reminders.dismissEmailPrompt() } }
        )
    }

    private var draftLooksLikeEmail: Bool { emailDraft.contains("@") && emailDraft.contains(".") }

    var body: some View {
        HStack(spacing: 6) {
            // Ai promemoria messi a un familiare la sveglia non serve: suona sul suo telefono.
            if item.forLabel == nil {
                ReminderChannelChip(title: "Sveglia", symbol: "alarm.fill", on: alarmOn) {
                    Task { _ = await model.reminders.setChannels(item, email: nil, alarm: !alarmOn) }
                }
            }
            ReminderChannelChip(title: "Email", symbol: "envelope.fill", on: emailOn) {
                Task { _ = await model.reminders.setChannels(item, email: !emailOn, alarm: nil) }
            }
        }
        .alert("Qual è la tua email?", isPresented: askingEmail) {
            TextField("nome@esempio.it", text: $emailDraft)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Salva") {
                let address = emailDraft
                Task {
                    // Salvata nelle impostazioni (e quindi nella scheda): ricarica il profilo locale.
                    if await model.reminders.saveEmail(address) { await model.refreshProfile() }
                }
            }
            .disabled(!draftLooksLikeEmail)
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("La salvo nella tua scheda e la uso per le email dei promemoria.")
        }
    }
}

private struct ReminderChannelChip: View {
    let title: String
    let symbol: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.caption)
                .padding(.horizontal, 9)
                .padding(.vertical, 4)
                .background(on ? Color.accentColor.opacity(0.18) : Color(.tertiarySystemFill), in: Capsule())
                .foregroundStyle(on ? Color.accentColor : Color.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityValue(on ? "attiva" : "spenta")
    }
}

/// Scelta tra i documenti letti: tocca per riaprirne riassunto e schema (dai prodotti salvati, senza costo).
/// Fonti: «p. N · capitolo» per ogni pagina citata; un tocco apre il passo originale.
struct CitationsCard: View {
    let block: CitationsBlock
    @State private var open: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(block.title, systemImage: "quote.opening").font(.subheadline.weight(.semibold))
            ForEach(block.items) { item in
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if open.contains(item.id) { open.remove(item.id) } else { open.insert(item.id) }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("p. \(item.page)")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.accentColor.opacity(0.15), in: Capsule())
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.heading ?? item.title).font(.callout.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                                if item.heading != nil {
                                    Text(item.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                            Image(systemName: open.contains(item.id) ? "chevron.up" : "chevron.down")
                                .font(.caption).foregroundStyle(.tertiary)
                        }
                        if open.contains(item.id) {
                            Text("«\(item.excerpt)»")
                                .font(.footnote).italic().foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.leading, 4)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: - Salute (v1.12)

/// La «tabellina» della salute: storico di un parametro (una riga per analisi) o valori di un referto con il
/// confronto con l'analisi precedente. Fuori intervallo in evidenza; valori e flag li calcola il server.
struct HealthCard: View {
    let block: HealthBlock
    @State private var showAll = false

    private static let collapsedCount = 12

    private var isParameter: Bool { block.mode == "parameter" }

    private var shownRows: [HealthBlock.Row] {
        showAll || block.rows.count <= Self.collapsedCount ? block.rows : Array(block.rows.prefix(Self.collapsedCount))
    }

    /// Punti del grafico (solo storico): date con valore, dalla più vecchia alla più recente.
    private var trendPoints: [HealthTrendPoint] {
        guard isParameter else { return [] }
        let points: [HealthTrendPoint] = block.rows.compactMap { row in
            guard let value = row.value, let date = HealthFormat.day(row.date) else { return nil }
            return HealthTrendPoint(date: date, value: value, low: row.refLow, high: row.refHigh, outside: row.isOut)
        }
        return points.sorted { $0.date < $1.date }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "heart.text.square.fill")
                    .font(.title3)
                    .foregroundStyle(.pink)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(block.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                    if let subtitle = block.subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if trendPoints.count >= 2 {
                HealthTrendChart(points: trendPoints, title: block.title)
            }
            if isParameter { parameterTable } else { reportTable }
            if block.rows.count > Self.collapsedCount {
                Button(showAll ? "Mostra meno" : "Mostra tutti (\(block.rows.count))") {
                    withAnimation(.easeInOut(duration: 0.2)) { showAll.toggle() }
                }
                .font(.caption)
            }
            if let summary = block.summary, !summary.isEmpty {
                Text(summary).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text("Valori letti dal referto. Ernie non è un medico: per dubbi parlane con il tuo medico.")
                .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: tabelle

    /// Storico: Data | Valore | Rif.
    private var parameterTable: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                cell(header("Data"))
                cell(header("Valore"))
                cell(header("Rif."))
            }
            ForEach(Array(shownRows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    cell(Text(HealthFormat.shortDay(row.date ?? row.label)).font(.callout).monospacedDigit(),
                         highlight: row.isOut ? row.tint.opacity(0.10) : nil,
                         speak: spoken(row))
                    cell(valueView(row), highlight: row.isOut ? row.tint.opacity(0.10) : nil)
                    cell(referenceText(row), highlight: row.isOut ? row.tint.opacity(0.10) : nil)
                }
            }
        }
    }

    /// Referto: Parametro | Valore | Prima | Rif.
    private var reportTable: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                cell(header("Parametro"))
                cell(header("Valore"))
                cell(header("Prima"))
                cell(header("Rif."))
            }
            ForEach(Array(shownRows.enumerated()), id: \.offset) { _, row in
                GridRow {
                    cell(Text(row.label).font(.callout).lineLimit(1).minimumScaleFactor(0.7),
                         highlight: row.isOut ? row.tint.opacity(0.10) : nil,
                         speak: spoken(row))
                    cell(valueView(row), highlight: row.isOut ? row.tint.opacity(0.10) : nil)
                    cell(previousView(row), highlight: row.isOut ? row.tint.opacity(0.10) : nil)
                    cell(referenceText(row), highlight: row.isOut ? row.tint.opacity(0.10) : nil)
                }
            }
        }
    }

    /// Cella di tabella. La prima colonna di ogni riga porta l'etichetta VoiceOver dell'intera riga;
    /// le altre sono nascoste allo screen reader per non ripetere la stessa riga.
    @ViewBuilder
    private func cell<V: View>(_ content: V, highlight: Color? = nil, speak: String? = nil) -> some View {
        let padded = content
            .padding(.horizontal, 5)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(highlight ?? Color.clear)
        if let speak {
            padded.accessibilityLabel(speak)
        } else {
            padded.accessibilityHidden(true)
        }
    }

    private func header(_ title: String) -> some View {
        Text(title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
    }

    private func valueView(_ row: HealthBlock.Row) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(HealthFormat.display(row))
                .font(.callout.weight(row.isOut ? .bold : .regular))
                .foregroundStyle(row.isOut ? row.tint : Color.primary)
                .monospacedDigit()
            if let unit = row.unit, !unit.isEmpty {
                Text(unit).font(.caption2).foregroundStyle(.secondary)
            }
            if row.isOut {
                Image(systemName: row.flag == "alto" ? "arrow.up" : "arrow.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(row.tint)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }

    /// Analisi precedente: valore con la freccia del trend e, sotto, la sua data.
    @ViewBuilder
    private func previousView(_ row: HealthBlock.Row) -> some View {
        if let previous = row.previous {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 3) {
                    Text(HealthFormat.number(previous.value)).font(.callout).monospacedDigit()
                    if let symbol = Self.trendSymbol(row.trend) {
                        Image(systemName: symbol).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                Text(HealthFormat.shortDay(previous.date))
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        } else {
            Text("—").font(.callout).foregroundStyle(.secondary)
        }
    }

    private func referenceText(_ row: HealthBlock.Row) -> some View {
        Text(HealthFormat.reference(row))
            .font(.caption).foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }

    private static func trendSymbol(_ trend: String?) -> String? {
        switch trend ?? "" {
        case "su": return "arrow.up.right"
        case "giu": return "arrow.down.right"
        case "stabile": return "arrow.right"
        default: return nil
        }
    }

    /// Etichetta VoiceOver: «Glicemia 118 milligrammi per decilitro, alto, prima 98» (storico: «10 ott 2026, 118 …»).
    private func spoken(_ row: HealthBlock.Row) -> String {
        let value = row.value.map { HealthFormat.number($0) } ?? row.valueText ?? "non disponibile"
        let unit = row.unit.flatMap { $0.isEmpty ? nil : HealthFormat.unitWords($0) }
        let amount = unit.map { "\(value) \($0)" } ?? value
        var parts = [isParameter ? "\(HealthFormat.shortDay(row.date ?? row.label)), \(amount)" : "\(row.label) \(amount)"]
        if let flag = HealthFormat.flagWord(row.flag) { parts.append(flag) }
        if !isParameter, let previous = row.previous { parts.append("prima \(HealthFormat.number(previous.value))") }
        return parts.joined(separator: ", ")
    }
}

/// Punto del grafico: data, valore e fascia di riferimento della sua analisi.
struct HealthTrendPoint: Identifiable {
    let date: Date
    let value: Double
    let low: Double?
    let high: Double?
    let outside: Bool

    var id: Date { date }
}

/// Andamento nel tempo (120 pt): linea con i punti; la fascia verde è il riferimento dell'analisi più recente.
struct HealthTrendChart: View {
    let points: [HealthTrendPoint]
    let title: String

    private var band: (low: Double, high: Double)? {
        guard let last = points.last, let low = last.low, let high = last.high, low < high else { return nil }
        return (low, high)
    }

    var body: some View {
        Chart {
            if let band, let first = points.first, let last = points.last {
                RectangleMark(
                    xStart: .value("Dal", first.date),
                    xEnd: .value("Al", last.date),
                    yStart: .value("Minimo di riferimento", band.low),
                    yEnd: .value("Massimo di riferimento", band.high)
                )
                .foregroundStyle(Color.green.opacity(0.15))
            }
            ForEach(points) { point in
                LineMark(x: .value("Data", point.date), y: .value("Valore", point.value))
                    .foregroundStyle(Color.pink)
                PointMark(x: .value("Data", point.date), y: .value("Valore", point.value))
                    .foregroundStyle(point.outside ? Color.red : Color.pink)
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                AxisGridLine()
                AxisValueLabel(format: .dateTime.day().month(.abbreviated).locale(HealthFormat.italian))
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading)
        }
        .frame(height: 120)
        .accessibilityLabel("Grafico di \(title), \(points.count) misure")
    }
}

/// Formati della tabellina: date in italiano, numeri con la virgola e al massimo due decimali, unità a parole.
enum HealthFormat {
    static let italian = Locale(identifier: "it_IT")

    static func day(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: String(iso.prefix(10)))
    }

    /// «10 ott 2026»; se la data non si legge, la stringa com'è.
    static func shortDay(_ iso: String?) -> String {
        guard let iso else { return "" }
        guard let date = day(iso) else { return iso }
        return date.formatted(.dateTime.day().month(.abbreviated).year().locale(italian))
    }

    static func number(_ value: Double) -> String {
        value.formatted(.number.precision(.fractionLength(0...2)).locale(italian))
    }

    /// Valore a schermo: il numero, oppure il risultato testuale («negativo»), oppure un trattino.
    static func display(_ row: HealthBlock.Row) -> String {
        if let value = row.value { return number(value) }
        return row.valueText ?? "—"
    }

    /// Riferimento: il testo del laboratorio, altrimenti «min–max», «≥ min» o «≤ max».
    static func reference(_ row: HealthBlock.Row) -> String {
        if let text = row.refText, !text.isEmpty { return text }
        if let low = row.refLow, let high = row.refHigh { return "\(number(low))–\(number(high))" }
        if let low = row.refLow { return "≥ \(number(low))" }
        if let high = row.refHigh { return "≤ \(number(high))" }
        return "—"
    }

    static func flagWord(_ flag: String) -> String? {
        switch flag {
        case "alto": return "alto"
        case "basso": return "basso"
        case "normale": return "nella norma"
        default: return nil
        }
    }

    /// Unità abbreviate → parole per VoiceOver; le altre restano come sono.
    static func unitWords(_ unit: String) -> String {
        switch unit.lowercased() {
        case "mg/dl": return "milligrammi per decilitro"
        case "g/dl": return "grammi per decilitro"
        case "mg/l": return "milligrammi per litro"
        case "mmol/l": return "millimoli per litro"
        case "ng/ml": return "nanogrammi per millilitro"
        case "pg/ml": return "picogrammi per millilitro"
        case "u/l": return "unità per litro"
        case "%": return "per cento"
        default: return unit
        }
    }
}

private extension HealthBlock.Row {
    var isOut: Bool { flag == "alto" || flag == "basso" }

    /// Colore del fuori intervallo: rosso per l'alto, arancio per il basso.
    var tint: Color {
        switch flag {
        case "alto": return Color.red
        case "basso": return Color.orange
        default: return Color.primary
        }
    }
}

struct DocumentsCard: View {
    let block: DocumentsBlock
    var conversation: ConversationStore?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(block.title, systemImage: "doc.text.magnifyingglass").font(.subheadline.weight(.semibold))
            ForEach(block.documents) { doc in
                Button {
                    let template = block.pendingText ?? "riapri il documento «{documento}»"
                    conversation?.send(template.replacingOccurrences(of: "{documento}", with: doc.title), inputMode: "text")
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: doc.source == "pdf" ? "doc.richtext" : "doc.viewfinder")
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(doc.title).font(.callout.weight(.medium)).foregroundStyle(.primary).lineLimit(2)
                            Text("\(doc.pages) \(doc.pages == 1 ? "pagina" : "pagine") · \(doc.summarized ? "riassunto pronto" : "da riassumere") · \(Self.day(doc.createdAt))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    static func day(_ iso: String) -> String {
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: iso) ?? plain.date(from: iso) else { return "" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

/// Versioni stampabili delle schede (per PDF e immagine): stesso contenuto, sfondo bianco, senza pulsanti.
struct DocumentPrintView: View {
    let block: DocumentBlock
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(block.title).font(.title2.weight(.bold))
            Text("\(block.pages) \(block.pages == 1 ? "pagina" : "pagine") · riassunto da studio di Ernie").font(.footnote).foregroundStyle(.secondary)
            Text(block.abstract).font(.body)
            if !block.keyPoints.isEmpty {
                Text("Punti chiave").font(.headline)
                ForEach(Array(block.keyPoints.enumerated()), id: \.offset) { _, p in
                    HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•"); Text(p) }.font(.body)
                }
            }
            if let glossary = block.glossary, !glossary.isEmpty {
                Text("Glossario").font(.headline)
                ForEach(glossary) { g in (Text(g.term).bold() + Text(": \(g.definition)")).font(.callout) }
            }
            if let questions = block.questions, !questions.isEmpty {
                Text("Domande di verifica").font(.headline)
                ForEach(Array(questions.enumerated()), id: \.offset) { i, q in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(i + 1). \(q.question)").font(.callout.weight(.medium))
                        Text(q.answer).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .foregroundStyle(.black)
    }
}

struct SchemaPrintView: View {
    let block: SchemaBlock
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(block.title).font(.title2.weight(.bold))
            switch block.diagram {
            case .outline(let sections): OutlineCanvas(layout: OutlineLayout(sections: sections))
            case .mindmap(let root): MindMapView(root: root)
            case .flow(let steps, let links): FlowView(steps: steps, links: links)
            case .timeline(let events): TimelineSchemaView(events: events)
            }
        }
        .foregroundStyle(.black)
    }

    /// Larghezza della resa: lo schema a frecce è disegnato intero, anche se più largo della pagina standard.
    static func exportWidth(_ block: SchemaBlock) -> CGFloat {
        if case .outline(let sections) = block.diagram { return max(560, OutlineLayout(sections: sections).size.width + 16) }
        return 560
    }
}

// MARK: - Liste della spesa (v1.4)

/// Scheda interattiva: tocca una voce per spuntarla (barrata, in fondo), aggiungi dal campo, togli dal menu a tenuta.
struct ShoppingListCard: View {
    let block: ShoppingListBlock
    var conversation: ConversationStore?
    @Environment(AppModel.self) private var model
    @State private var newItem = ""
    @State private var confirmDelete = false
    @FocusState private var adding: Bool

    private var list: ShoppingListBlock { model.shopping.current(block) }
    private var open: [ShoppingListItem] { list.items.filter { !$0.checked } }
    private var bought: [ShoppingListItem] { list.items.filter(\.checked) }
    private var isBusy: Bool { model.shopping.busy.contains(list.listId) }

    var body: some View {
        if model.shopping.isDeleted(block.listId) {
            // Eliminata: la scheda resta in chat come traccia, ma non è più una lista viva.
            HStack(spacing: 8) {
                Image(systemName: "trash").foregroundStyle(.secondary)
                Text("Lista «\(block.name)» eliminata").font(.footnote).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.thinMaterial.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
        } else {
            liveCard
        }
    }

    private var liveCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(list.name, systemImage: "cart.fill").font(.subheadline.weight(.semibold)).lineLimit(1)
                if list.status == "archived" {
                    Text("archiviata").font(.caption2).padding(.horizontal, 6).padding(.vertical, 2).background(Color.secondary.opacity(0.15), in: Capsule())
                }
                Spacer(minLength: 4)
                Text(counter).font(.caption).foregroundStyle(.secondary)
                Menu {
                    if !bought.isEmpty {
                        Button("Togli le voci prese", systemImage: "checkmark.circle") { Task { await model.shopping.clearBought(listId: list.listId) } }
                    }
                    if list.status == "archived" {
                        Button("Ripristina", systemImage: "tray.and.arrow.up") { Task { await model.shopping.setArchived(listId: list.listId, false) } }
                    } else {
                        Button("Archivia", systemImage: "archivebox") { Task { await model.shopping.setArchived(listId: list.listId, true) } }
                    }
                    Button("Elimina la lista", systemImage: "trash", role: .destructive) { confirmDelete = true }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(.secondary)
                }
                .accessibilityLabel("Azioni sulla lista")
            }
            if list.items.isEmpty {
                Text("Lista vuota: aggiungi qualcosa qui sotto.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(open + bought) { item in
                row(item)
            }
            HStack(spacing: 8) {
                Image(systemName: "plus.circle").foregroundStyle(Color.accentColor)
                TextField("Aggiungi una voce", text: $newItem)
                    .focused($adding)
                    .textInputAutocapitalization(.sentences)
                    .onSubmit(submit)
                if !newItem.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Aggiungi", action: submit).font(.caption.weight(.semibold))
                }
            }
            .font(.callout)
            .padding(.top, 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .animation(.easeInOut(duration: 0.2), value: list)
        .opacity(isBusy ? 0.85 : 1)
        .task(id: block.listId) { await model.shopping.refresh(block.listId) }
        .confirmationDialog("Eliminare la lista «\(list.name)» con tutte le voci?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Elimina", role: .destructive) { Task { await model.shopping.delete(listId: list.listId) } }
            Button("Annulla", role: .cancel) {}
        }
    }

    private var counter: String {
        let n = open.count
        if list.items.isEmpty { return "" }
        if n == 0 { return "tutto preso" }
        return "\(n) da prendere" + (bought.isEmpty ? "" : " · \(bought.count) \(bought.count == 1 ? "presa" : "prese")")
    }

    private func row(_ item: ShoppingListItem) -> some View {
        Button {
            Task { await model.shopping.toggle(listId: list.listId, item: item) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(item.checked ? Color.green : Color.secondary)
                Text(item.name)
                    .strikethrough(item.checked, color: .secondary)
                    .foregroundStyle(item.checked ? .secondary : .primary)
                if let q = item.quantity, !q.isEmpty {
                    Text(q).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .font(.callout)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(item.checked ? "Rimetti da prendere" : "Segna come presa", systemImage: item.checked ? "arrow.uturn.backward" : "checkmark") {
                Task { await model.shopping.toggle(listId: list.listId, item: item) }
            }
            Button("Togli dalla lista", systemImage: "minus.circle", role: .destructive) {
                Task { await model.shopping.remove(listId: list.listId, item: item) }
            }
        }
        .accessibilityLabel("\(item.name)\(item.quantity.map { ", \($0)" } ?? ""), \(item.checked ? "presa" : "da prendere")")
        .accessibilityHint("Tocca per \(item.checked ? "rimettere da prendere" : "segnare come presa")")
    }

    private func submit() {
        let text = newItem
        newItem = ""
        adding = false
        Task { await model.shopping.add(listId: list.listId, name: text) }
    }
}

/// Scelta tra più liste: tocca una lista per rimandare la richiesta con quel nome (o aprirla).
struct ShoppingListsCard: View {
    let block: ShoppingListsBlock
    var conversation: ConversationStore?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(block.title, systemImage: "list.bullet.rectangle").font(.subheadline.weight(.semibold))
            ForEach(block.lists) { list in
                Button {
                    let template = block.pendingText ?? "mostrami la lista {lista}"
                    conversation?.send(template.replacingOccurrences(of: "{lista}", with: list.name), inputMode: "text")
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: list.archived ? "archivebox" : "cart")
                            .foregroundStyle(list.archived ? Color.secondary : Color.accentColor)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(list.name).font(.callout.weight(.medium)).foregroundStyle(.primary)
                            Text(subtitle(list)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private func subtitle(_ l: ShoppingListSummary) -> String {
        var parts: [String] = []
        parts.append(l.open == 0 ? "niente da prendere" : "\(l.open) da prendere")
        if l.bought > 0 { parts.append("\(l.bought) \(l.bought == 1 ? "presa" : "prese")") }
        if l.archived { parts.append("archiviata") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Documenti (v1.3)

/// Scheda del documento letto: riassunto da studio, punti chiave, glossario e domande di verifica (risposte a tocco).
struct DocumentCard: View {
    let block: DocumentBlock
    var conversation: ConversationStore?
    @State private var showGlossary = false
    @State private var revealed: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(block.title, systemImage: "doc.text.viewfinder").font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(block.pages) \(block.pages == 1 ? "pagina" : "pagine")").font(.caption).foregroundStyle(.secondary)
            }
            Text(block.abstract).font(.callout)
            if !block.keyPoints.isEmpty {
                Text("Punti chiave").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(Array(block.keyPoints.enumerated()), id: \.offset) { _, point in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•")
                        Text(point)
                    }
                    .font(.callout)
                }
            }
            if let glossary = block.glossary, !glossary.isEmpty {
                Button(showGlossary ? "Nascondi il glossario" : "Glossario (\(glossary.count))") { showGlossary.toggle() }.font(.caption)
                if showGlossary {
                    ForEach(glossary) { entry in
                        (Text(entry.term).bold() + Text(": \(entry.definition)")).font(.footnote)
                    }
                }
            }
            if let questions = block.questions, !questions.isEmpty {
                Text("Domande di verifica (tocca per la risposta)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(Array(questions.enumerated()), id: \.offset) { index, q in
                    Button {
                        if revealed.contains(q.id) { revealed.remove(q.id) } else { revealed.insert(q.id) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(index + 1). \(q.question)").font(.footnote).foregroundStyle(.primary)
                            if revealed.contains(q.id) {
                                Text(q.answer).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actions }
                VStack(alignment: .leading, spacing: 6) { actions }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder
    private var actions: some View {
        Button("Mappa", systemImage: "point.3.connected.trianglepath.dotted") { ask("mindmap") }
        Button("Flusso", systemImage: "arrow.down.right.and.arrow.up.left") { ask("flow") }
        Button("Linea del tempo", systemImage: "calendar.day.timeline.left") { ask("timeline") }
        ExportMenu(name: "Riassunto \(block.title)") { DocumentPrintView(block: block) }
    }

    private func ask(_ type: String) {
        let name = type == "mindmap" ? "a mappa" : type == "flow" ? "a flusso" : "a linea del tempo"
        conversation?.send("Fammi lo schema \(name) del documento «\(block.title)».", inputMode: "text")
    }
}

/// Scheda dello schema: disegno nativo di mappa, flusso o linea del tempo.
struct SchemaCard: View {
    let block: SchemaBlock
    var conversation: ConversationStore?

    private var kindLabel: String {
        switch block.diagram {
        case .outline: "Schema a frecce"
        case .mindmap: "Mappa"
        case .flow: "Flusso"
        case .timeline: "Linea del tempo"
        }
    }

    /// Gli altri tipi (frase per il server, etichetta, simbolo).
    private var otherKinds: [(String, String, String)] {
        let all: [(String, String, String, Bool)] = [
            ("schema a frecce", "Come schema a frecce", "list.bullet.indent", { if case .outline = block.diagram { return true } else { return false } }()),
            ("mappa mentale", "Come mappa mentale", "point.3.connected.trianglepath.dotted", { if case .mindmap = block.diagram { return true } else { return false } }()),
            ("flusso", "Come flusso", "arrow.triangle.branch", { if case .flow = block.diagram { return true } else { return false } }()),
            ("linea del tempo", "Come linea del tempo", "calendar.day.timeline.left", { if case .timeline = block.diagram { return true } else { return false } }()),
        ]
        return all.filter { !$0.3 }.map { ($0.0, $0.1, $0.2) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                // Tipo in evidenza e titolo del documento intero (niente puntini): le azioni stanno a destra.
                VStack(alignment: .leading, spacing: 2) {
                    Label(kindLabel, systemImage: "square.3.layers.3d").font(.subheadline.weight(.semibold))
                    Text(block.title).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                // Altro tipo di schema dello stesso documento: comando deterministico, nessun modello coinvolto.
                if let conversation {
                    Menu {
                        ForEach(otherKinds, id: \.0) { phrase, label, symbol in
                            Button {
                                conversation.send("schema «\(block.title)» come \(phrase)", inputMode: "text")
                            } label: { Label(label, systemImage: symbol) }
                        }
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Color.accentColor)
                    }
                    .accessibilityLabel("Altro tipo di schema")
                }
                ExportMenu(name: "\(kindLabel) \(block.title)", width: SchemaPrintView.exportWidth(block)) { SchemaPrintView(block: block) }
            }
            switch block.diagram {
            case .outline(let sections): OutlineDiagramView(sections: sections)
            case .mindmap(let root): MindMapView(root: root)
            case .flow(let steps, let links): FlowView(steps: steps, links: links)
            case .timeline(let events): TimelineSchemaView(events: events)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

/// Mappa come albero verticale: radice in evidenza, rami con linee di raccordo (leggibile su schermo stretto).
struct MindMapView: View {
    let root: MindNode
    private static let palette: [Color] = [.blue, .orange, .green, .purple, .pink, .teal, .indigo, .red]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(root.label)
                .font(.callout.weight(.bold))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(Color.accentColor.opacity(0.18), in: Capsule())
            ForEach(Array((root.children ?? []).enumerated()), id: \.offset) { index, branch in
                MindBranchView(node: branch, color: Self.palette[index % Self.palette.count], depth: 1)
            }
        }
    }
}

struct MindBranchView: View {
    let node: MindNode
    let color: Color
    let depth: Int

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5).fill(color.opacity(depth == 1 ? 0.9 : 0.5)).frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
                Text(node.label).font(depth == 1 ? .callout.weight(.semibold) : .footnote)
                if let note = node.note, !note.isEmpty {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
                ForEach(Array((node.children ?? []).enumerated()), id: \.offset) { _, child in
                    MindBranchView(node: child, color: color, depth: depth + 1)
                }
            }
        }
        .padding(.leading, depth == 1 ? 8 : 0)
    }
}

/// Flusso verticale: passi in sequenza con frecce; i collegamenti non sequenziali compaiono come rimandi etichettati.
struct FlowView: View {
    let steps: [FlowStep]
    let links: [FlowLink]

    private func outgoing(_ step: FlowStep, next: FlowStep?) -> [FlowLink] {
        links.filter { $0.from == step.id && $0.to != next?.id }
    }

    private func label(for id: String) -> String {
        steps.first { $0.id == id }?.label ?? id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                let next = index + 1 < steps.count ? steps[index + 1] : nil
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(index + 1)")
                            .font(.caption.weight(.bold)).monospacedDigit()
                            .frame(width: 22, height: 22)
                            .background(Color.accentColor.opacity(0.18), in: Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.label).font(.callout)
                            if let note = step.note, !note.isEmpty { Text(note).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    ForEach(Array(outgoing(step, next: next).enumerated()), id: \.offset) { _, link in
                        Text("↳ \(link.label.map { "\($0): " } ?? "")\(label(for: link.to))")
                            .font(.caption).foregroundStyle(.secondary).padding(.leading, 30)
                    }
                    if next != nil {
                        let direct = links.isEmpty || links.contains { $0.from == step.id && $0.to == next?.id }
                        if direct {
                            Image(systemName: "arrow.down").font(.caption).foregroundStyle(.secondary).padding(.leading, 6)
                        }
                    }
                }
            }
        }
    }
}

/// Linea del tempo verticale: punti su una linea, data in evidenza, evento e nota.
struct TimelineSchemaView: View {
    let events: [TimelineEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(events.enumerated()), id: \.offset) { index, event in
                HStack(alignment: .top, spacing: 10) {
                    VStack(spacing: 0) {
                        Circle().fill(Color.accentColor).frame(width: 10, height: 10).padding(.top, 5)
                        if index + 1 < events.count {
                            Rectangle().fill(Color.accentColor.opacity(0.35)).frame(width: 2).frame(maxHeight: .infinity)
                        }
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.when).font(.caption.weight(.bold)).foregroundStyle(Color.accentColor)
                        Text(event.label).font(.callout)
                        if let note = event.note, !note.isEmpty { Text(note).font(.caption).foregroundStyle(.secondary) }
                    }
                    .padding(.bottom, index + 1 < events.count ? 12 : 0)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct WebResultsCard: View {
    let query: String
    let results: [WebResultItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Dal web: \(query)", systemImage: "globe")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(results) { r in
                        if let url = URL(string: r.url) {
                            Link(destination: url) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(r.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                                    if let snippet = r.snippet, !snippet.isEmpty {
                                        Text(snippet).font(.caption).foregroundStyle(.secondary).lineLimit(4)
                                    }
                                    Text(r.site ?? url.host() ?? "").font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                                }
                                .frame(width: 220, alignment: .leading)
                                .padding(12)
                                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.primary)
                        }
                    }
                }
            }
        }
        .padding(.top, 4)
    }
}

struct ListCard: View {
    let title: String
    let items: [ListBlockItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: "cart").font(.subheadline.weight(.semibold))
            ForEach(items) { item in
                HStack(spacing: 8) {
                    Image(systemName: item.checked == true ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(item.checked == true ? .green : .secondary)
                    Text(item.name)
                    if let q = item.quantity, !q.isEmpty {
                        Text(q).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .font(.callout)
            }
            Text("\(items.count) \(items.count == 1 ? "voce" : "voci")").font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct RecipesCard: View {
    let recipes: [RecipeItem]
    var conversation: ConversationStore?
    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(recipes) { recipe in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("🍽️ \(recipe.title)").font(.subheadline.weight(.semibold))
                        Spacer()
                        if let time = recipe.time {
                            Label(time, systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let servings = recipe.servings {
                        Text(servings).font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(Array(recipe.ingredients.enumerated()), id: \.offset) { _, ing in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("•")
                            Text(ing)
                        }
                        .font(.callout)
                    }
                    if let steps = recipe.steps, !steps.isEmpty {
                        if expanded.contains(recipe.id) {
                            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text("\(index + 1).").monospacedDigit()
                                    Text(step)
                                }
                                .font(.callout)
                            }
                        }
                        Button(expanded.contains(recipe.id) ? "Nascondi i passaggi" : "Mostra i passaggi") {
                            if expanded.contains(recipe.id) { expanded.remove(recipe.id) } else { expanded.insert(recipe.id) }
                        }
                        .font(.caption)
                    }
                    ViewThatFits(in: .horizontal) {
                        actions(for: recipe)
                        VStack(alignment: .leading, spacing: 6) { actions(for: recipe) }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding(.top, 4)
    }

    @ViewBuilder
    private func actions(for recipe: RecipeItem) -> some View {
        HStack(spacing: 8) {
            if let conversation {
                Button {
                    conversation.send("Salva la ricetta «\(recipe.title)» tra le mie ricette, con gli ingredienti e i passaggi mostrati.", inputMode: "text")
                } label: { Label("Salva", systemImage: "bookmark") }
                Button {
                    conversation.composerSuggestion = "Affina la ricetta «\(recipe.title)»: "
                } label: { Label("Affina", systemImage: "slider.horizontal.3") }
                Button {
                    conversation.send("aggiungi alla lista \(recipe.ingredients.joined(separator: ", "))", inputMode: "text")
                } label: { Label("Ingredienti", systemImage: "cart.badge.plus") }
            }
            if let raw = recipe.url, let url = URL(string: raw) {
                Link(destination: url) { Label(recipe.source ?? "Fonte", systemImage: "safari") }
            }
        }
        .buttonStyle(.bordered)
        .font(.caption)
    }
}
