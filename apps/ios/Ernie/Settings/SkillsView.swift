import SwiftUI

/// Sezione Skill: ogni skill si accende e spegne per utente; i suoi tool seguono l'interruttore.
struct SkillsView: View {
    @Environment(AppModel.self) private var model
    @State private var skills: [SkillInfo] = []
    @State private var busy: Set<String> = []
    @State private var error: String?

    var body: some View {
        List {
            if skills.isEmpty, error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            ForEach(skills) { skill in
                Section {
                    Toggle(isOn: Binding(
                        get: { skill.enabled },
                        set: { value in Task { await toggle(skill, value) } }
                    )) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(skill.title).font(.body.weight(.semibold))
                            Text(skill.description).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .disabled(busy.contains(skill.id))
                } footer: {
                    VStack(alignment: .leading, spacing: 2) {
                        if !skill.examples.isEmpty {
                            Text("Prova: " + skill.examples.prefix(2).map { "«\($0)»" }.joined(separator: ", "))
                        }
                        Text((skill.kind == "deterministic" ? "Senza modello · " : "Con il modello · ") + "tool: " + skill.tools.joined(separator: ", "))
                    }
                }
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                Text("Spegnendo o accendendo una skill si apre una nuova conversazione con i tool aggiornati.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Skill")
        .task { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            skills = try await api.skills()
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    private func toggle(_ skill: SkillInfo, _ value: Bool) async {
        guard let api = model.api else { return }
        busy.insert(skill.id)
        defer { busy.remove(skill.id) }
        do {
            skills = try await api.setSkill(id: skill.id, enabled: value)
            model.newConversation()
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}
