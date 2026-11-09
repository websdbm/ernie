import Foundation
import SwiftUI

struct TaskIntentRequest: Encodable, Sendable {
    struct Candidate: Codable, Sendable, Equatable {
        let id: String
        let title: String
    }
    let text: String
    let tasks: [Candidate]
}

struct TaskIntentDecision: Decodable, Sendable {
    let kind: String
    let targetId: String?
    let confidence: Double
    let sharedResources: Bool

    func destination(in candidates: [TaskIntentRequest.Candidate]) -> String? {
        guard confidence >= 0.92, !sharedResources, kind == "steer",
              let targetId, candidates.contains(where: { $0.id == targetId }) else { return nil }
        return targetId
    }
    var isIndependent: Bool { kind == "new" && targetId == nil && confidence >= 0.92 && !sharedResources }
}

extension ApiClient {
    func resolveTask(_ input: TaskIntentRequest) async throws -> TaskIntentDecision {
        try await request("POST", "/v1/tasks/resolve", body: input)
    }
}

/// Each lane has its own transcript, transport, model thread and audio controller.
@MainActor
struct ConcurrentTask: @MainActor Identifiable {
    var id: String { conversation.sessionId }
    let conversation: ConversationStore
    let speaker: Speaker
    let voice: VoiceController
    var title: String { String(conversation.activeTaskTitle.prefix(80)) }
    var isRunning: Bool { conversation.activeCorrelationId != nil }
    var status: String {
        if conversation.items.contains(where: { item in
            if case .confirmation(let c) = item { return c.decision == nil && c.correlationId == conversation.activeCorrelationId }; return false
        }) { return "Serve conferma" }
        if isRunning { return "In corso" }
        if conversation.canRecoverRequest { return "Da riprendere" }
        return "Risposta pronta"
    }
}

struct PendingTaskInput: Identifiable, Codable, Sendable {
    var id = UUID()
    let sourceId: String
    let text: String
    let inputMode: String
    let attachments: [DocumentRef]

    private struct File: Codable { let owner: String; let inputs: [PendingTaskInput] }
    private static var url: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appending(path: "Ernie/task-inputs.json")
    }
    static func save(_ inputs: [PendingTaskInput], owner: String) {
        if inputs.isEmpty { clearSaved(); return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(File(owner: owner, inputs: inputs)) {
            try? data.write(to: url, options: [.atomic, .completeFileProtection])
        }
    }
    static func load(owner: String) -> [PendingTaskInput] {
        guard let data = try? Data(contentsOf: url), let file = try? JSONDecoder().decode(File.self, from: data),
              file.owner == owner else { return [] }
        return file.inputs
    }
    static func clearSaved() { try? FileManager.default.removeItem(at: url) }
}

struct ConcurrentTasksBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.chatPalette) private var palette
    var body: some View {
        if model.concurrentTasks.count > 1 {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(model.concurrentTasks) { task in
                        Button { model.selectTask(task.id) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Label(task.status, systemImage: task.isRunning ? "circle.dotted" : "checkmark.circle")
                                    .font(.caption.weight(.semibold))
                                Text(task.title).font(.subheadline).lineLimit(2)
                            }.frame(width: 175, alignment: .leading)
                        }
                        .buttonStyle(ErnieButtonStyle(emphasis: model.conversation?.sessionId == task.id ? .primary : .secondary))
                        .accessibilityLabel("\(task.title). \(task.status)")
                        .accessibilityAddTraits(model.conversation?.sessionId == task.id ? .isSelected : [])
                    }
                }.padding(.horizontal, 16).padding(.vertical, 6)
            }.scrollIndicators(.hidden)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct TaskInputChoiceView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.chatPalette) private var palette
    let input: PendingTaskInput
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(model.resolvingTask ? "Collego la richiesta…" : "A quale compito si riferisce?")
                        .font(.headline)
                    Spacer()
                    if model.resolvingTask { ProgressView().controlSize(.small) }
                }
                Text(input.text).font(.subheadline).foregroundStyle(palette.inkSecondary).lineLimit(3)
                ForEach(model.concurrentTasks.filter { $0.isRunning || $0.id == input.sourceId }) { task in
                    Button {
                        model.resolvePendingTask(targetId: task.id)
                    } label: { Label("Aggiungi a: \(task.title)", systemImage: "text.badge.plus") }
                        .buttonStyle(ErnieButtonStyle(fillsWidth: true))
                        .disabled(!input.attachments.isEmpty && task.isRunning)
                }
                if model.canStartParallelTask {
                    Button { model.resolvePendingTaskAsNew() } label: {
                        Label("Avvia un altro compito", systemImage: "square.stack.3d.up")
                    }.buttonStyle(ErnieButtonStyle(emphasis: .primary, fillsWidth: true))
                }
                Button { model.queuePendingTask() } label: {
                    Label("Fallo dopo il compito attuale", systemImage: "clock")
                }.buttonStyle(ErnieButtonStyle(fillsWidth: true))
                if input.attachments.isEmpty {
                    Button("Modifica il messaggio") { model.editPendingTask() }
                        .buttonStyle(ErnieButtonStyle(fillsWidth: true))
                }
            }.padding(16)
        }
        .frame(maxHeight: 300)
        .fontDesign(palette.terminal ? .monospaced : .default)
        .foregroundStyle(palette.ink)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 20))
        .padding(.horizontal, 12)
        .accessibilityElement(children: .contain)
    }
}
