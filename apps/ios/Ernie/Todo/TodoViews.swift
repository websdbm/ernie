import SwiftUI

struct TodoLibraryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var path: [String]
    @State private var creating = false
    init(listId: String? = nil) { _path = State(initialValue: listId.map { [$0] } ?? []) }
    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let error = model.todoStore.lastError { TodoErrorBanner(message: error) }
                    if model.todoStore.loading { ProgressView("Carico Todo…") }
                    if model.todoStore.loaded && model.todoStore.lists.isEmpty {
                        ContentUnavailableView("Le tue liste", systemImage: "checklist", description: Text("Crea una lista oppure chiedi a Ernie di organizzare la giornata."))
                    }
                    ForEach(model.todoStore.orderedLists) { list in
                        Button { path.append(list.id) } label: { TodoLibraryRow(list: list) }
                            .buttonStyle(.plain)
                    }
                    Button("Nuova lista", systemImage: "plus") { creating = true }.buttonStyle(.borderedProminent)
                }
                .padding(16).frame(maxWidth: 700).frame(maxWidth: .infinity)
            }
            .background(Theme.ground)
            .navigationTitle("Todo")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            .navigationDestination(for: String.self) { id in
                TodoDetailView(listId: id, chatDraft: { text in
                    model.conversation?.composerSuggestion = text
                    dismiss()
                })
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fine") { dismiss() } } }
            }
            .sheet(isPresented: $creating) {
                TodoListCreator { list in
                    if await model.todoStore.save(list, create: true) { creating = false; path.append(list.id) }
                }.environment(model)
            }
            .task { await model.todoStore.load() }
            .refreshable { await model.todoStore.load() }
        }
    }
}

struct TodoLibraryRow: View {
    let list: TodoList
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: list.mode == .scheduled ? "calendar" : "checklist").foregroundStyle(Theme.accentText)
            VStack(alignment: .leading, spacing: 5) {
                Text(list.name).font(.headline).foregroundStyle(Theme.ink)
                Text("\(list.tasks.filter { $0.status == .done }.count) di \(list.tasks.filter { $0.status != .cancelled }.count) completate")
                    .font(.subheadline).foregroundStyle(Theme.inkSecondary)
                if let day = TodoTime.dayLabel(list) { Text(day).font(.caption).foregroundStyle(Theme.inkSecondary) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").foregroundStyle(Theme.inkSecondary).accessibilityHidden(true)
        }
        .padding(16).background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct TodoCard: View {
    @Environment(AppModel.self) private var model
    let list: TodoList
    @State private var opening = false
    var body: some View {
        let current = model.todoStore.current(list)
        TimelineView(.periodic(from: .now, by: 60)) { context in
            TodoCardContent(list: current, now: context.date, open: { opening = true })
        }
        .task { model.todoStore.apply(list); await model.todoStore.refresh(list.id) }
        .sheet(isPresented: $opening) { TodoLibraryView(listId: list.id).environment(model) }
    }
}

/// Shared by the live chat card and native rendering checks; no network or store side effects.
struct TodoCardContent: View {
    @Environment(\.chatPalette) private var palette
    let list: TodoList
    let now: Date
    var open: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(list.mode == .scheduled ? "LA TUA TIMELINE" : "TODO",
                  systemImage: list.mode == .scheduled ? "calendar" : "checklist")
                .font(.caption.weight(.semibold)).foregroundStyle(palette.accentText)
            Text(list.name).font(.headline)
            if let day = TodoTime.dayLabel(list) {
                Text(day).font(.caption).foregroundStyle(palette.inkSecondary)
            }
            Text("\(list.tasks.filter { $0.status == .done }.count) di \(list.tasks.filter { $0.status != .cancelled }.count) completate")
                .font(.subheadline).foregroundStyle(palette.inkSecondary)
            if list.mode == .scheduled {
                TodoTimeline(list: list, now: now, compact: true, toggle: { _ in open() }, edit: { _ in open() })
                let unscheduled = list.orderedItems.filter { $0.kind == .task && $0.status != .cancelled && $0.slots.isEmpty }
                if !unscheduled.isEmpty {
                    Divider().overlay(palette.hairline)
                    Text("Orario da definire").font(.caption.weight(.semibold)).foregroundStyle(palette.inkSecondary)
                    ForEach(unscheduled) { item in summaryRow(item) }
                }
            } else {
                ForEach(Array(list.orderedItems.filter { $0.kind == .task && $0.status != .cancelled }.prefix(4))) { item in
                    summaryRow(item)
                }
            }
            Button(list.mode == .scheduled ? "Apri timeline" : "Apri lista", systemImage: "arrow.up.right", action: open)
                .buttonStyle(.bordered)
        }.foregroundStyle(palette.ink)
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
    }
    private func summaryRow(_ item: TodoItem) -> some View {
        HStack(alignment: .top) {
            Image(systemName: item.status == .done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(item.status == .done ? palette.positive : palette.inkSecondary)
                .accessibilityLabel(item.status == .done ? "Completata" : "Da fare")
            Text([list.groupPath(for: item), item.title].compactMap { $0 }.joined(separator: " · "))
                .font(.subheadline).fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct TodoDetailView: View {
    @Environment(AppModel.self) private var model
    let listId: String
    var chatDraft: ((String) -> Void)? = nil
    @State private var timeline = true
    @State private var editing: TodoItem?
    @State private var converting = false
    @State private var reviewingDraft = false
    var body: some View {
        ScrollView {
            if let list = model.todoStore.lists[listId] {
                VStack(alignment: .leading, spacing: 18) {
                    if let error = model.todoStore.lastError { TodoErrorBanner(message: error) }
                    if model.todoStore.unsavedDrafts[listId] != nil {
                        Button("Rivedi modifiche non salvate", systemImage: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90") { reviewingDraft = true }
                            .buttonStyle(.bordered)
                    }
                    Text("\(list.tasks.filter { $0.status == .done }.count) di \(list.tasks.filter { $0.status != .cancelled }.count) completate")
                        .font(.subheadline).foregroundStyle(Theme.positive)
                    if let day = TodoTime.dayLabel(list) {
                        Text(day).font(.subheadline).foregroundStyle(Theme.inkSecondary)
                    }
                    if list.mode == .scheduled {
                        Picker("Vista", selection: $timeline) { Text("Orari").tag(true); Text("Lista").tag(false) }
                            .pickerStyle(.segmented)
                    }
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        if list.mode == .scheduled && timeline {
                            TodoTimeline(list: list, now: context.date, toggle: toggle, edit: { editing = $0 })
                            let unscheduled = list.orderedItems.filter { $0.kind == .task && $0.status != .cancelled && $0.slots.isEmpty }
                            if !unscheduled.isEmpty {
                                Text("Da collocare").font(.headline)
                                ForEach(unscheduled) { item in taskRow(item, list: list, now: context.date) }
                            }
                        } else {
                            TodoHierarchy(list: list, now: context.date, edit: { editing = $0 }, toggle: toggle)
                        }
                        let cancelled = list.orderedItems.filter { $0.status == .cancelled }
                        if !cancelled.isEmpty {
                            DisclosureGroup("Annullate (\(cancelled.count))") {
                                ForEach(cancelled) { item in taskRow(item, list: list, now: context.date).opacity(0.65) }
                            }.foregroundStyle(Theme.inkSecondary)
                        }
                    }
                    HStack {
                        Button("Attività", systemImage: "plus") { editing = TodoItem(title: "", position: list.items.count) }
                        Spacer()
                        Button("Gruppo", systemImage: "folder.badge.plus") { editing = TodoItem(title: "", kind: .group, position: list.items.count) }
                    }.buttonStyle(.bordered)
                    Button("Ripianifica in chat", systemImage: "bubble.left") {
                        let text = "Vorrei ripianificare la lista Todo «\(list.name)» (id: \(list.id)), conservando gli impegni fissi e tutte le attività. "
                        if let chatDraft { chatDraft(text) } else { model.conversation?.composerSuggestion = text }
                    }.buttonStyle(.bordered)
                    if list.mode == .scheduled {
                        Button("Converti in lista senza orari", role: .destructive) { converting = true }
                            .font(.footnote)
                    }
                }.padding(16).frame(maxWidth: 700).frame(maxWidth: .infinity)
                .sheet(item: $editing) { item in
                    TodoItemEditor(list: list, item: item) { edited in
                        await model.todoStore.save(TodoEditing.replacing(edited, in: list))
                    }.environment(model)
                }
                .sheet(isPresented: $reviewingDraft) {
                    if let draft = model.todoStore.unsavedDrafts[listId] {
                        TodoConflictReview(draft: draft, current: list) { merged in await model.todoStore.save(merged) }
                            .environment(model)
                    }
                }
                .confirmationDialog("Rimuovere orari e promemoria?", isPresented: $converting, titleVisibility: .visible) {
                    Button("Rimuovi orari e promemoria", role: .destructive) {
                        Task { await model.todoStore.mutate(listId) { $0 = $0.clearingSchedule() } }
                    }
                } message: { Text("Le attività restano nella lista. Verranno rimossi tutti gli orari e i promemoria collegati.") }
            } else if model.todoStore.loading { ProgressView("Carico la lista…").padding() }
            else {
                VStack {
                    if let error = model.todoStore.lastError { TodoErrorBanner(message: error) }
                    Button("Ricarica lista") { Task { await model.todoStore.refresh(listId) } }
                }.padding()
            }
        }
        .background(Theme.ground)
        .navigationTitle(model.todoStore.lists[listId]?.name ?? "Todo")
        .task(id: listId) { await model.todoStore.refresh(listId) }
        .refreshable { await model.todoStore.refresh(listId) }
    }
    private func toggle(_ item: TodoItem) {
        Task { await model.todoStore.mutate(listId) { list in
            if let index = list.items.firstIndex(where: { $0.id == item.id }) {
                list.items[index].status = list.items[index].status == .done ? .pending : .done
            }
        } }
    }
    private func taskRow(_ item: TodoItem, list: TodoList, now: Date) -> some View {
        TodoTaskRow(item: item, group: list.groupPath(for: item), slot: nil, timezone: list.timezone,
                    now: now, toggle: { toggle(item) }, edit: { editing = item })
    }
}

struct TodoHierarchy: View {
    let list: TodoList
    let now: Date
    var edit: (TodoItem) -> Void
    var toggle: (TodoItem) -> Void
    var body: some View { nodes(parent: nil, depth: 0) }
    private func nodes(parent: String?, depth: Int) -> AnyView {
        // A finite depth bound also protects rendering against malformed/cyclic remote data.
        AnyView(VStack(alignment: .leading, spacing: 12) {
            ForEach(list.orderedItems.filter { $0.parentId == parent && $0.status != .cancelled }) { item in
                if item.kind == .group {
                    VStack(alignment: .leading, spacing: 10) {
                        Button { edit(item) } label: { Label(item.title, systemImage: "folder").font(.headline) }
                            .foregroundStyle(Theme.ink)
                        if depth < 20 { nodes(parent: item.id, depth: depth + 1) }
                    }.padding(.leading, depth == 0 ? 0 : 12)
                } else {
                    TodoTaskRow(item: item, group: nil, slot: nil, timezone: list.timezone, now: now,
                                toggle: { toggle(item) }, edit: { edit(item) })
                }
            }
        })
    }
}

struct TodoTaskRow: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let item: TodoItem
    let group: String?
    let slot: TodoSlot?
    let timezone: String
    let now: Date
    var toggle: () -> Void
    var edit: () -> Void
    private var active: Bool { slot.map { TodoTime.phase($0, now: now) == .current } ?? false }
    var body: some View {
        let layout = textSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 6))
        layout {
            Button(action: edit) {
                VStack(alignment: .leading, spacing: 5) {
                    if let group { Text(group).font(.caption.weight(.semibold)).foregroundStyle(Theme.inkSecondary) }
                    Text(item.title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                    if let slot, let start = slot.start, let end = slot.end {
                        Text("\(TodoTime.clock(start, timezone: timezone))–\(TodoTime.clock(end, timezone: timezone))\(slot.fixed ? " · fisso" : "")")
                            .font(.caption).foregroundStyle(Theme.inkSecondary)
                        if let minutes = slot.reminderMinutes {
                            Text("Avviso \(minutes) min prima").font(.caption).foregroundStyle(Theme.inkSecondary)
                        }
                    } else if !item.slots.isEmpty {
                        Text(item.slots.count == 1 ? "1 fascia oraria" : "\(item.slots.count) fasce orarie").font(.caption).foregroundStyle(Theme.inkSecondary)
                    }
                    if let status = TodoTime.status(item, slot: slot, now: now) {
                        Text(status).font(.caption.weight(.medium))
                            .foregroundStyle(item.status == .done ? Theme.positive : active ? Theme.accentText : Theme.inkSecondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHint("Modifica attività e orari")
            if item.kind == .task && item.status != .cancelled {
                Button(action: toggle) {
                    Image(systemName: item.status == .done ? "checkmark.circle.fill" : "circle")
                        .font(.title3).foregroundStyle(item.status == .done ? Theme.positive : Theme.inkSecondary)
                        .frame(minWidth: 44, minHeight: 44)
                }.buttonStyle(.plain)
                    .accessibilityLabel("\(item.status == .done ? "Segna da fare" : "Completa"): \(item.title)")
                    .accessibilityValue(item.status == .done ? "Completata" : "Da fare")
            }
        }.padding(12)
            .background(active ? Theme.accentSoft : Theme.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(active ? Theme.accentText : .clear, lineWidth: 1))
    }
}

private struct TodoAnchorKey: PreferenceKey {
    static let defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

struct TodoTimeline: View {
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.chatPalette) private var palette
    let list: TodoList
    let now: Date
    var compact = false
    var toggle: (TodoItem) -> Void
    var edit: (TodoItem) -> Void
    var body: some View {
        let entries = TodoTimelineEntry.entries(list)
        VStack(alignment: .leading, spacing: compact ? 14 : 20) {
            if list.day == TodoTime.day(now, timezone: list.timezone) {
                Text("Adesso · \(TodoTime.clock(now, timezone: list.timezone))")
                    .font(.caption.weight(.semibold)).foregroundStyle(palette.accentText)
            }
            ForEach(entries) { entry in
                HStack(alignment: .top, spacing: 8) {
                    if !textSize.isAccessibilitySize {
                        Text(entry.slot.start.map { TodoTime.clock($0, timezone: list.timezone) } ?? "—")
                            .font(.caption.monospacedDigit()).foregroundStyle(palette.inkSecondary)
                            .frame(width: 43, alignment: .leading).padding(.top, 15)
                    }
                    Circle().fill(TodoTime.phase(entry.slot, now: now) == .future ? palette.hairline : palette.accentText)
                        .frame(width: 12, height: 12).padding(.top, 17)
                        .anchorPreference(key: TodoAnchorKey.self, value: .bounds) { [entry.id: $0] }
                        .accessibilityHidden(true)
                    if compact {
                        Button { edit(entry.item) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                if let group = list.groupPath(for: entry.item) {
                                    Text(group).font(.caption).foregroundStyle(palette.inkSecondary)
                                }
                                Text(entry.item.title).font(.subheadline.weight(.medium))
                                    .foregroundStyle(palette.ink)
                                if textSize.isAccessibilitySize, let start = entry.slot.start {
                                    Text(TodoTime.clock(start, timezone: list.timezone))
                                        .font(.caption.monospacedDigit()).foregroundStyle(palette.inkSecondary)
                                }
                                if let status = TodoTime.status(entry.item, slot: entry.slot, now: now) {
                                    Label(status, systemImage: entry.item.status == .done ? "checkmark.circle.fill" : "clock")
                                        .font(.caption2).foregroundStyle(entry.item.status == .done ? palette.positive : palette.inkSecondary)
                                }
                            }.fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain)
                            .accessibilityLabel("\(entry.slot.start.map { TodoTime.clock($0, timezone: list.timezone) } ?? "") · \(entry.item.title)")
                            .accessibilityHint("Apri la timeline per gestire questa attività")
                    } else {
                        TodoTaskRow(item: entry.item, group: list.groupPath(for: entry.item), slot: entry.slot,
                                    timezone: list.timezone, now: now, toggle: { toggle(entry.item) }, edit: { edit(entry.item) })
                    }
                }
            }
            if entries.isEmpty { Text("Nessun orario assegnato").foregroundStyle(palette.inkSecondary) }
            if !entries.isEmpty { Text("Intervalli compattati · linea colorata: tempo trascorso")
                .font(.caption2).foregroundStyle(palette.inkSecondary).fixedSize(horizontal: false, vertical: true) }
        }
        .backgroundPreferenceValue(TodoAnchorKey.self) { anchors in
            GeometryReader { proxy in
                let points: [(Date, CGPoint)] = entries.compactMap { entry in
                    guard let anchor = anchors[entry.id], let start = entry.slot.start else { return nil }
                    let frame = proxy[anchor]
                    return (start, CGPoint(x: frame.midX, y: frame.midY))
                }
                if let first = points.first, let last = points.last {
                    let end = entries.compactMap(\.slot.end).max() ?? last.0
                    let bottom = CGPoint(x: last.1.x, y: min(proxy.size.height - 25, last.1.y + (compact ? 32 : 80)))
                    let endPoints = points + [(max(end, last.0.addingTimeInterval(1)), bottom)]
                    let markerY = Self.markerY(now: now, points: endPoints)
                    Path { path in path.move(to: first.1); path.addLine(to: bottom) }.stroke(palette.hairline, lineWidth: 3)
                    Path { path in path.move(to: first.1); path.addLine(to: CGPoint(x: first.1.x, y: markerY)) }
                        .stroke(palette.accentText, lineWidth: 3)
                }
            }.accessibilityHidden(true)
        }
        .overlayPreferenceValue(TodoAnchorKey.self) { anchors in
            if list.day == TodoTime.day(now, timezone: list.timezone),
               let firstStart = entries.first?.slot.start,
               let lastEnd = entries.compactMap(\.slot.end).max(), now >= firstStart, now < lastEnd {
                GeometryReader { proxy in
                    let points: [(Date, CGPoint)] = entries.compactMap { entry in
                        guard let anchor = anchors[entry.id], let start = entry.slot.start else { return nil }
                        return (start, CGPoint(x: proxy[anchor].midX, y: proxy[anchor].midY))
                    }
                    if let last = points.last {
                        let end = max(entries.compactMap(\.slot.end).max() ?? last.0, last.0.addingTimeInterval(1))
                        let bottom = CGPoint(x: last.1.x, y: min(proxy.size.height - 25, last.1.y + (compact ? 32 : 80)))
                        let y = Self.markerY(now: now, points: points + [(end, bottom)])
                        if compact || textSize.isAccessibilitySize {
                            Circle().fill(palette.accent).frame(width: 16, height: 16)
                                .offset(x: last.1.x - 8, y: y - 8)
                        } else {
                            Text("Adesso")
                                .font(.caption2.weight(.semibold)).foregroundStyle(.white)
                                .padding(.horizontal, 5).padding(.vertical, 4)
                                .background(palette.accent, in: RoundedRectangle(cornerRadius: 6))
                                .offset(x: 0, y: max(0, y - 11))
                        }
                    }
                }.allowsHitTesting(false).accessibilityHidden(true)
            }
        }
    }
    static func markerY(now: Date, points: [(Date, CGPoint)]) -> CGFloat {
        guard let first = points.first, let last = points.last else { return 0 }
        if now <= first.0 { return first.1.y }
        if now >= last.0 { return last.1.y }
        for (left, right) in zip(points, points.dropFirst()) where now >= left.0 && now < right.0 {
            let interval = right.0.timeIntervalSince(left.0)
            guard interval > 0 else { continue }
            let fraction = now.timeIntervalSince(left.0) / interval
            return left.1.y + CGFloat(fraction) * (right.1.y - left.1.y)
        }
        return last.1.y
    }
}

struct TodoErrorBanner: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.callout).foregroundStyle(Theme.inkSecondary)
            .fixedSize(horizontal: false, vertical: true).padding(12)
            .frame(maxWidth: .infinity, alignment: .leading).background(Theme.surfaceMuted, in: RoundedRectangle(cornerRadius: 12))
    }
}
