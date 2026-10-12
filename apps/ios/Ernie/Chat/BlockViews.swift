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
    @State private var draftText = ""
    @State private var draftDate = Date.now
    @State private var saving = false

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
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.text)
                                .font(.callout)
                                .strikethrough(r.status == "cancelled", color: .secondary)
                                .foregroundStyle(r.status == "scheduled" ? .primary : .secondary)
                            Text(Self.when(r) + Self.who(r)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        if r.status == "scheduled" {
                            Button {
                                if editing == r.id { editing = nil } else { startEditing(r) }
                            } label: {
                                Image(systemName: editing == r.id ? "pencil.circle.fill" : "pencil.circle").foregroundStyle(Color.accentColor)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Modifica")
                            Button("Annulla") { Task { await model.reminders.cancel(r) } }
                                .font(.caption).buttonStyle(.bordered).controlSize(.mini)
                        }
                    }
                    if editing == r.id {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Cosa ti ricordo", text: $draftText)
                                .textFieldStyle(.roundedBorder)
                            DatePicker("Quando", selection: $draftDate, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                                .datePickerStyle(.compact)
                                .environment(\.locale, Locale(identifier: "it_IT"))
                            HStack {
                                Button("Salva") { Task { await save(r) } }
                                    .buttonStyle(.borderedProminent).controlSize(.small)
                                    .disabled(saving || draftText.trimmingCharacters(in: .whitespaces).isEmpty)
                                Button("Lascia così") { editing = nil }.controlSize(.small)
                            }
                        }
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

    private func startEditing(_ r: ReminderItem) {
        draftText = r.text
        draftDate = ReminderStore.date(r.at) ?? .now.addingTimeInterval(3600)
        editing = r.id
    }

    private func save(_ r: ReminderItem) async {
        saving = true
        defer { saving = false }
        let text = draftText.trimmingCharacters(in: .whitespaces)
        let changedText = text != r.text ? text : nil
        let changedDate = abs((ReminderStore.date(r.at) ?? .distantPast).timeIntervalSince(draftDate)) > 30 ? draftDate : nil
        if changedText == nil && changedDate == nil { editing = nil; return }
        if await model.reminders.update(r, text: changedText, at: changedDate) { editing = nil }
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

/// Scelta tra i documenti letti: tocca per riaprirne riassunto e schema (dai prodotti salvati, senza costo).
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
            case .outline(let sections): OutlineDiagramView(sections: sections)
            case .mindmap(let root): MindMapView(root: root)
            case .flow(let steps, let links): FlowView(steps: steps, links: links)
            case .timeline(let events): TimelineSchemaView(events: events)
            }
        }
        .foregroundStyle(.black)
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
            HStack(alignment: .firstTextBaseline) {
                Label("\(kindLabel) · \(block.title)", systemImage: "square.3.layers.3d").font(.subheadline.weight(.semibold)).lineLimit(2)
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
                ExportMenu(name: "\(kindLabel) \(block.title)") { SchemaPrintView(block: block) }
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
