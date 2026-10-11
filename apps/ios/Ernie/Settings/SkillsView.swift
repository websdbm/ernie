import SwiftUI

/// Due livelli (decisione dell'utente, 11 ott 2026):
/// - `.available` (Impostazioni → Skill): quali skill compaiono nel pannello ✦ della chat, man mano che il catalogo cresce;
/// - `.active` (pannello ✦ nella chat): tra quelle disponibili, quali sono accese in questo momento.
/// Una skill lavora solo se è disponibile e accesa. Le modifiche valgono dal messaggio successivo nella
/// conversazione in corso (il server ricostruisce l'agente della sessione, la memoria resta).
struct SkillsView: View {
    enum Mode { case available, active }

    let mode: Mode
    @Environment(AppModel.self) private var model
    @State private var skills: [SkillInfo] = []
    @State private var loaded = false
    @State private var busy: Set<String> = []
    @State private var error: String?

    private var shown: [SkillInfo] {
        mode == .available ? skills : skills.filter(\.available)
    }

    var body: some View {
        List {
            if !loaded, error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            Section {
                Text(mode == .available
                    ? "Scegli quali skill compaiono nel pannello ✦ della chat. Da lì le accendi e spegni quando servono."
                    : "Accendi le skill che ti servono adesso. Per decidere quali compaiono qui: Impostazioni → Skill.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if loaded, shown.isEmpty {
                Section {
                    Text(mode == .available ? "Nessuna skill nel catalogo." : "Nessuna skill disponibile: scegline qualcuna in Impostazioni → Skill.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(shown) { skill in
                Section {
                    Toggle(isOn: Binding(
                        get: { mode == .available ? skill.available : skill.enabled },
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
                        if mode == .available, skill.available {
                            Text(skill.enabled ? "Nel pannello ✦: accesa" : "Nel pannello ✦: spenta")
                        }
                    }
                }
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                Text("Le modifiche valgono dal prossimo messaggio, anche nella conversazione in corso.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(mode == .available ? "Skill disponibili" : "Skill")
        .task { await load() }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            skills = try await api.skills()
            loaded = true
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
            skills = mode == .available
                ? try await api.setSkill(id: skill.id, available: value)
                : try await api.setSkill(id: skill.id, enabled: value)
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

/// Il pannello a scomparsa della schermata principale: mezza altezza, trascinabile, chiusura con «Fine».
struct SkillsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SkillsView(mode: .active)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button("Fine") { dismiss() } }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
