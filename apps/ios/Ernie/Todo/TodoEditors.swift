import SwiftUI

enum TodoEditing {
    static func replacing(_ edited: TodoItem, in list: TodoList) -> TodoList {
        var result = list
        var ordered = list.orderedItems.filter { $0.id != edited.id }
        ordered.insert(edited, at: min(max(0, edited.position), ordered.count))
        result.items = ordered.enumerated().map { index, value in
            var item = value; item.position = index; return item
        }
        return result
    }
    static func canParent(_ candidate: TodoItem, item: TodoItem, list: TodoList) -> Bool {
        guard candidate.kind == .group else { return false }
        var id: String? = candidate.id
        var seen = Set<String>()
        while let current = id {
            if current == item.id || !seen.insert(current).inserted { return false }
            id = list.items.first(where: { $0.id == current })?.parentId
        }
        return true
    }
}

struct TodoItemEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let list: TodoList
    let save: (TodoItem) async -> Bool
    @State private var draft: TodoItem
    @State private var estimated: String
    @State private var minimum: String
    @State private var saving = false
    init(list: TodoList, item: TodoItem, save: @escaping (TodoItem) async -> Bool) {
        self.list = list; self.save = save
        _draft = State(initialValue: item)
        _estimated = State(initialValue: item.estimatedMinutes.map(String.init) ?? "")
        _minimum = State(initialValue: item.minimumMinutes.map(String.init) ?? "")
    }
    private var valid: Bool {
        !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.title.count <= 160
        && draft.notes.count <= 2000 && validMinutes(estimated) && validMinutes(minimum)
        && draft.slots.allSatisfy { slot in
            guard let start = slot.start, let end = slot.end else { return false }
            return end > start && (slot.reminderMinutes.map { (0...1440).contains($0) } ?? true)
        }
    }
    private func validMinutes(_ text: String) -> Bool { text.isEmpty || Int(text).map { (1...1440).contains($0) } == true }
    var body: some View {
        NavigationStack {
            Form {
                if let error = model.todoStore.lastError { Section { TodoErrorBanner(message: error) } }
                Section(draft.kind == .group ? "Gruppo" : "Attività") {
                    TextField("Titolo", text: $draft.title, axis: .vertical)
                    TextField("Note", text: $draft.notes, axis: .vertical)
                    Picker("Gruppo", selection: $draft.parentId) {
                        Text("Nessuno").tag(nil as String?)
                        ForEach(list.orderedItems.filter { TodoEditing.canParent($0, item: draft, list: list) }) { group in
                            Text(group.title).tag(Optional(group.id))
                        }
                    }
                    Stepper("Posizione: \(draft.position + 1)", value: $draft.position, in: 0...max(0, list.items.count))
                }
                if draft.kind == .task {
                    Section("Stato e durata") {
                        Picker("Stato", selection: $draft.status) {
                            Text("Da fare").tag(TodoItem.Status.pending)
                            Text("Completata").tag(TodoItem.Status.done)
                            Text("Annullata").tag(TodoItem.Status.cancelled)
                        }
                        TextField("Durata stimata (minuti)", text: $estimated).keyboardType(.numberPad)
                        TextField("Durata minima (minuti)", text: $minimum).keyboardType(.numberPad)
                        Toggle("Divisibile in più sessioni", isOn: $draft.splittable)
                        Text("Il passaggio del tempo non completa l’attività.").font(.footnote).foregroundStyle(Theme.inkSecondary)
                    }
                    if !draft.dependsOn.isEmpty {
                        Section {
                            ForEach(draft.dependsOn.indices, id: \.self) { index in
                                Text(list.items.first { $0.id == draft.dependsOn[index].taskId }?.title ?? "Attività collegata")
                                Stepper("Attesa minima: \(draft.dependsOn[index].lagMinutes) min", value: $draft.dependsOn[index].lagMinutes, in: 0...10080, step: 15)
                            }
                        } header: { Text("Prima di questa attività") } footer: { Text("Il tempo di attesa non occupa la tua giornata. Ernie verifica che gli orari rispettino questi collegamenti.") }
                    }
                    if list.mode == .scheduled {
                        ForEach($draft.slots) { $slot in
                            Section("Fascia oraria") {
                                TodoSlotEditor(slot: $slot)
                                Button("Rimuovi questa fascia e il suo avviso", role: .destructive) {
                                    draft.slots.removeAll { $0.id == slot.id }
                                }
                            }
                        }
                        Section {
                            Button("Aggiungi fascia oraria", systemImage: "plus") { addSlot() }
                                .disabled(draft.slots.count >= 20)
                            if draft.slots.isEmpty { Text("Senza fasce, l’attività compare in Da collocare.").font(.footnote) }
                        } footer: { Text("Gli orari sono nel fuso \(list.timezone). Ogni fascia mantiene il proprio promemoria.") }
                    }
                }
                if !valid { Section { Text("Controlla titolo, durata (1–1440 minuti) e che ogni fascia termini dopo l’inizio.").foregroundStyle(.red) } }
            }
            .environment(\.timeZone, TimeZone(identifier: list.timezone) ?? .current)
            .navigationTitle(draft.kind == .group ? "Modifica gruppo" : "Modifica attività")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Salvo…" : "Salva") {
                        draft.title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
                        draft.estimatedMinutes = Int(estimated); draft.minimumMinutes = Int(minimum)
                        saving = true
                        Task { if await save(draft) { dismiss() }; saving = false }
                    }.disabled(!valid || saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }
    private func addSlot() {
        let start: Date
        if let lastEnd = draft.slots.last?.end { start = lastEnd }
        else if let day = TodoTime.dayStart(list) {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: list.timezone) ?? .current
            start = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: day) ?? day
        } else { start = Date() }
        draft.slots.append(TodoSlot(startAt: TodoTime.iso(start), endAt: TodoTime.iso(start.addingTimeInterval(Double(Int(estimated) ?? 30) * 60))))
    }
}

struct TodoSlotEditor: View {
    @Binding var slot: TodoSlot
    var body: some View {
        DatePicker("Inizio", selection: Binding(get: { slot.start ?? .now }, set: { slot.startAt = TodoTime.iso($0) }), displayedComponents: [.date, .hourAndMinute])
        DatePicker("Fine", selection: Binding(get: { slot.end ?? .now }, set: { slot.endAt = TodoTime.iso($0) }), displayedComponents: [.date, .hourAndMinute])
        if let start = slot.start, let end = slot.end {
            Text("Durata: \(Int(end.timeIntervalSince(start) / 60)) minuti").font(.caption).foregroundStyle(Theme.inkSecondary)
        }
        Toggle("Orario fisso", isOn: $slot.fixed)
        Toggle("Promemoria", isOn: Binding(get: { slot.reminderMinutes != nil }, set: { slot.reminderMinutes = $0 ? 30 : nil }))
        if slot.reminderMinutes != nil {
            Stepper("Avviso \(slot.reminderMinutes ?? 30) min prima", value: Binding(get: { slot.reminderMinutes ?? 30 }, set: { slot.reminderMinutes = $0 }), in: 0...1440, step: 5)
        }
    }
}

struct TodoListCreator: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let save: (TodoList) async -> Void
    @State private var name = ""
    @State private var scheduled = false
    @State private var day = Date()
    @State private var listId = UUID().uuidString.lowercased()
    @State private var saving = false
    var body: some View {
        NavigationStack {
            Form {
                if let error = model.todoStore.lastError { TodoErrorBanner(message: error) }
                TextField("Nome della lista", text: $name)
                Toggle("Giornata con orari", isOn: $scheduled)
                if scheduled { DatePicker("Giornata", selection: $day, displayedComponents: .date) }
                Text("Puoi inserire attività e gruppi anche dalla chat.").font(.footnote).foregroundStyle(Theme.inkSecondary)
            }.navigationTitle("Nuova lista")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() }.disabled(saving) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Creo…" : "Crea") {
                            var list = TodoList(id: listId, name: name.trimmingCharacters(in: .whitespacesAndNewlines))
                            list.mode = scheduled ? .scheduled : .simple
                            list.day = scheduled ? TodoTime.day(day, timezone: list.timezone) : nil
                            saving = true
                            Task { await save(list); saving = false }
                        }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.count > 100 || saving)
                    }
                }
        }.interactiveDismissDisabled(saving)
    }
}

struct TodoConflictReview: View {
    @Environment(\.dismiss) private var dismiss
    let draft: TodoList
    let current: TodoList
    let save: (TodoList) async -> Bool
    @State private var saving = false
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("La bozza non è stata applicata. La lista sul server può contenere nuove attività: confronta le due versioni prima di tornare all’editor o ripianificare in chat.")
                }
                Section("Versione aggiornata · revisione \(current.revision)") { summary(current) }
                Section("Le tue modifiche non salvate · revisione \(draft.revision)") { summary(draft) }
                Section {
                    Button("Applica le mie attività mantenendo le aggiunte remote") {
                        var merged = current
                        // Explicit user-reviewed reconciliation; never remove tasks created elsewhere.
                        for item in draft.items {
                            if let index = merged.items.firstIndex(where: { $0.id == item.id }) { merged.items[index] = item }
                            else { merged.items.append(item) }
                        }
                        saving = true
                        Task { if await save(merged) { dismiss() }; saving = false }
                    }.disabled(saving)
                } footer: { Text("Le attività con lo stesso ID riprendono i valori della tua bozza. Le attività aggiunte sul server restano nella lista.") }
            }.navigationTitle("Confronta modifiche")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { dismiss() } } }
        }
    }
    private func summary(_ list: TodoList) -> some View {
        ForEach(list.orderedItems) { item in
            VStack(alignment: .leading, spacing: 4) {
                Text([list.groupPath(for: item), item.title].compactMap { $0 }.joined(separator: " · "))
                Text(item.status == .done ? "Completata" : item.status == .cancelled ? "Annullata" : "Da fare").font(.caption)
                ForEach(item.slots) { slot in
                    Text("\(slot.startAt) → \(slot.endAt) · avviso \(slot.reminderMinutes.map { "\($0) min" } ?? "disattivato")")
                        .font(.caption).foregroundStyle(Theme.inkSecondary)
                }
            }
        }
    }
}
