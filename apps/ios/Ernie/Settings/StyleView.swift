import SwiftUI

/// Impostazioni → Come parla Ernie (16 ott 2026): lo stile (Neutro, Scherzoso, Essenziale, Antico), valido ovunque e
/// cambiabile anche a voce, e le parole che Ernie impara da chi scrive, che si vedono e si cancellano qui.
struct StyleView: View {
    @Environment(AppModel.self) private var model
    @State private var data: StyleSettings?
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        List {
            if let data {
                Section {
                    ForEach(data.styles) { option in
                        Button { Task { await choose(option.id) } } label: {
                            styleRow(option, selected: option.id == data.current)
                        }
                        .buttonStyle(.plain)
                        .disabled(saving)
                    }
                } header: {
                    Text("Stile")
                } footer: {
                    Text("Vale ovunque: chat, voce, notifiche, promemoria ed email. Puoi cambiarlo anche a voce: «parlami in modo antico», «rispondi corto», «torna normale».")
                }

                Section {
                    Toggle("Impara le mie parole", isOn: Binding(
                        get: { data.learnLexicon },
                        set: { value in Task { await setLearning(value) } }
                    ))
                    .disabled(saving || data.lexiconLockedByParent)
                    if data.lexiconLockedByParent {
                        Text("Spento da chi segue il tuo account.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Ernie annota le espressioni che usi spesso (dopo almeno tre volte, in due conversazioni diverse) e le riusa quando calzano. Parolacce mai.")
                }

                Section {
                    if active.isEmpty {
                        Text("Ancora nessuna: Ernie impara mentre parlate.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(active) { wordRow($0) }
                        .onDelete { offsets in Task { await remove(offsets.map { active[$0] }) } }
                } header: {
                    Text("Parole che Ernie ha imparato da te")
                } footer: {
                    Text("Scorri a sinistra per cancellarne una: Ernie non la userà più e non la imparerà di nuovo.")
                }

                if !learning.isEmpty {
                    Section {
                        ForEach(learning) { wordRow($0) }
                            .onDelete { offsets in Task { await remove(offsets.map { learning[$0] }) } }
                    } header: {
                        Text("Sta imparando")
                    } footer: {
                        Text("Sentite qualche volta: diventano tue se le usi ancora.")
                    }
                }
            } else if error == nil {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
            if let error {
                Section { Text(error).font(.footnote).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Come parla Ernie")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private var active: [LexiconWord] { data?.words.filter(\.active) ?? [] }
    private var learning: [LexiconWord] { data?.words.filter { !$0.active } ?? [] }

    private func styleRow(_ option: StyleSettings.Option, selected: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .font(.title3)
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(option.title).font(.body.weight(selected ? .semibold : .regular))
                Text(option.description).font(.caption).foregroundStyle(.secondary)
                Text("«\(option.example)»")
                    .font(.callout.italic())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func wordRow(_ w: LexiconWord) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(w.term).font(.body.weight(.medium))
            if !w.meaning.isEmpty {
                Text(w.meaning).font(.caption).foregroundStyle(.secondary)
            }
            if !w.example.isEmpty {
                Text("«\(w.example)»").font(.caption2.italic()).foregroundStyle(.tertiary)
            }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            data = try await api.styleSettings()
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    private func choose(_ id: String) async {
        guard let api = model.api, var current = data, current.current != id else { return }
        let previous = current.current
        current.current = id
        data = current
        saving = true
        defer { saving = false }
        do {
            model.applySettings(try await api.updateSettings(["conversationStyle": .string(id)]))
            error = nil
        } catch {
            data?.current = previous
            self.error = AppModel.describe(error)
        }
    }

    private func setLearning(_ on: Bool) async {
        guard let api = model.api, data != nil else { return }
        data?.learnLexicon = on
        saving = true
        defer { saving = false }
        do {
            model.applySettings(try await api.updateSettings(["learnLexicon": .bool(on)]))
            error = nil
        } catch {
            data?.learnLexicon = !on
            self.error = AppModel.describe(error)
        }
    }

    private func remove(_ words: [LexiconWord]) async {
        guard let api = model.api else { return }
        for w in words {
            do { try await api.deleteLexiconWord(id: w.id) } catch { self.error = AppModel.describe(error) }
        }
        await load()
    }
}
