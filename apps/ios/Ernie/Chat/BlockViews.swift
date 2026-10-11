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
        case .unknown:
            EmptyView()
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
                    HStack {
                        if let conversation {
                            Button {
                                conversation.send("aggiungi alla lista \(recipe.ingredients.joined(separator: ", "))", inputMode: "text")
                            } label: {
                                Label("Aggiungi gli ingredienti", systemImage: "cart.badge.plus")
                            }
                            .buttonStyle(.bordered)
                            .font(.caption)
                        }
                        if let raw = recipe.url, let url = URL(string: raw) {
                            Link(destination: url) { Label(recipe.source ?? "Fonte", systemImage: "safari") }
                                .font(.caption)
                        }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding(.top, 4)
    }
}
