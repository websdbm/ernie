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
        case .unknown:
            EmptyView()
        }
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
        case .mindmap: "Mappa"
        case .flow: "Flusso"
        case .timeline: "Linea del tempo"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("\(kindLabel) · \(block.title)", systemImage: "square.3.layers.3d").font(.subheadline.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 0)
            }
            switch block.diagram {
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
