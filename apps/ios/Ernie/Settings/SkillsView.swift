import SwiftUI

/// Due livelli (decisione dell'utente, 11 ott 2026):
/// - `.available` (Impostazioni → Skill): quali skill compaiono nel pannello ✦ della chat, con il riferimento tecnico (tool);
/// - `.active` (pannello ✦ accanto al microfono): tra quelle disponibili, quali sono accese adesso. Compatto: titolo,
///   micro-descrizione, interruttore; ⓘ apre la descrizione estesa; il cerca trova anche le skill non ancora disponibili
///   e le attiva in un colpo.
/// Una skill lavora solo se è disponibile e accesa. Le modifiche valgono dal messaggio successivo nella conversazione in corso.
struct SkillsView: View {
    enum Mode { case available, active }

    let mode: Mode
    @Environment(AppModel.self) private var model
    @State private var skills: [SkillInfo] = []
    @State private var loaded = false
    @State private var busy: Set<String> = []
    @State private var expanded: Set<String> = []
    @State private var query = ""
    @State private var error: String?

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    private func matches(_ s: SkillInfo) -> Bool {
        guard searching else { return true }
        let q = query.trimmingCharacters(in: .whitespaces)
        return s.title.localizedStandardContains(q)
            || (s.summary ?? "").localizedStandardContains(q)
            || s.description.localizedStandardContains(q)
            || s.examples.contains { $0.localizedStandardContains(q) }
    }

    /// Righe principali: tutte (configurazione) oppure solo le disponibili (pannello ✦).
    private var shown: [SkillInfo] {
        skills.filter { (mode == .available || $0.available) && matches($0) }
    }

    /// Nel pannello ✦, cercando, anche le skill non ancora disponibili: si attivano in un colpo.
    private var fromConfiguration: [SkillInfo] {
        guard mode == .active, searching else { return [] }
        return skills.filter { !$0.available && matches($0) }
    }

    var body: some View {
        List {
            // Se il genitore ha concesso o negato qualche skill, il figlio vede subito chi lo segue.
            if skills.contains(where: { $0.locked == true }) {
                Section {
                    SupervisionNotice(compact: true)
                        .listRowBackground(Color.clear)
                }
            }
            if let error {
                Section { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            Section {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Cerca una skill", text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if searching {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Svuota la ricerca")
                    }
                }
            }
            if !loaded, error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            if loaded, shown.isEmpty, fromConfiguration.isEmpty {
                Section {
                    Text(searching ? "Nessuna skill corrisponde a «\(query)»."
                        : mode == .available ? "Nessuna skill nel catalogo."
                        : "Nessuna skill disponibile: scegline qualcuna in Impostazioni → Skill.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                ForEach(shown) { skill in row(skill) }
            } header: {
                if mode == .available { Text("Compaiono nel pannello ✦") }
            } footer: {
                if mode == .available, loaded {
                    Text("Le skill disponibili compaiono nel pannello ✦ accanto al microfono; da lì le accendi e spegni quando servono. Le modifiche valgono dal prossimo messaggio, anche nella conversazione in corso.")
                }
            }
            if !fromConfiguration.isEmpty {
                Section("Disponibili in configurazione") {
                    ForEach(fromConfiguration) { skill in
                        HStack(alignment: .center, spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(skill.title).font(.body.weight(.semibold))
                                Text(skill.summary ?? skill.description).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                                lockCaption(skill)
                            }
                            Spacer(minLength: 4)
                            Button("Attiva") { Task { await activate(skill) } }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.small)
                                .disabled(busy.contains(skill.id) || skill.locked == true)
                        }
                    }
                }
            }
        }
        .listSectionSpacing(.compact)
        .navigationTitle(mode == .available ? "Skill disponibili" : "Skill")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    /// Didascalia delle skill che il genitore ha concesso o negato: il figlio non può cambiarle.
    @ViewBuilder
    private func lockCaption(_ skill: SkillInfo) -> some View {
        if skill.locked == true {
            Label("La sceglie il genitore", systemImage: "lock.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func row(_ skill: SkillInfo) -> some View {
        let isOn = mode == .available ? skill.available : skill.enabled
        let locked = skill.locked == true
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(skill.title).font(.body.weight(.semibold))
                    Text(skill.summary ?? skill.description)
                        .font(.footnote).foregroundStyle(.secondary)
                        .lineLimit(expanded.contains(skill.id) ? nil : 1)
                    lockCaption(skill)
                }
                Spacer(minLength: 4)
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        if expanded.contains(skill.id) { expanded.remove(skill.id) } else { expanded.insert(skill.id) }
                    }
                } label: {
                    Image(systemName: expanded.contains(skill.id) ? "info.circle.fill" : "info.circle")
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Descrizione di \(skill.title)")
                Toggle("", isOn: Binding(
                    get: { isOn },
                    set: { value in Task { await toggle(skill, value) } }
                ))
                .labelsHidden()
                .disabled(locked || busy.contains(skill.id))
                .accessibilityHint(locked ? "La sceglie il genitore" : "")
            }
            if expanded.contains(skill.id) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(skill.description).font(.footnote)
                    if !skill.examples.isEmpty {
                        Text("Prova: " + skill.examples.prefix(2).map { "«\($0)»" }.joined(separator: ", "))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if mode == .available {
                        // Riferimento tecnico: solo nella pagina di configurazione.
                        Text((skill.kind == "deterministic" ? "Senza modello · " : "Con il modello · ") + "tool: " + skill.tools.joined(separator: ", "))
                            .font(.caption2).foregroundStyle(.tertiary)
                        Text(skill.enabled ? "Nel pannello ✦: accesa" : "Nel pannello ✦: spenta")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                .transition(.opacity)
            }
        }
        .padding(.vertical, 2)
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
        // Skill scelta dal genitore: il server la rifiuterebbe (403), qui non si chiama nemmeno.
        guard skill.locked != true, let api = model.api else { return }
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

    /// Dal cerca del pannello ✦: rende la skill disponibile e la accende in un colpo.
    private func activate(_ skill: SkillInfo) async {
        guard skill.locked != true, let api = model.api else { return }
        busy.insert(skill.id)
        defer { busy.remove(skill.id) }
        do {
            skills = try await api.setSkill(id: skill.id, enabled: true, available: true)
            query = ""
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

/// Il pannello a scomparsa accanto al microfono: mezza altezza, trascinabile, chiusura con «Fine».
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
