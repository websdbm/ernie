import SwiftUI

/// Unica uscita esplicita dall'archivio alla memoria ordinaria: anteprima modificabile e conferma manuale.
struct ChatArchiveBrainExportView: View {
    let archive: ChatArchive
    let answer: ChatArchiveAnswer
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatPalette) private var palette
    @State private var title = ""
    @State private var text = ""
    @State private var includeSources = false
    @State private var busy = false
    @State private var saved = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                if saved { Label("Nota salvata nel Second Brain", systemImage: "checkmark.circle.fill").foregroundStyle(palette.positive) }
                else {
                    Section("Anteprima della nota") {
                        TextField("Titolo", text: $title)
                        TextEditor(text: $text).frame(minHeight: 180)
                        Text("Puoi conservare solo la parte che vuoi trasferire nella memoria generale.").font(.caption).foregroundStyle(.secondary)
                    }
                    Section("Provenienza") {
                        Text("Chat: \(archive.name)")
                        Text("Archivio aggiornato al \(ChatArchivePresentation.date(answer.coverage.latestMessageAt))").font(.caption)
                        Toggle("Includi anche i messaggi citati", isOn: $includeSources)
                        if includeSources { ForEach(answer.sources) { source in ChatArchiveMessageRow(message: source) } }
                    }
                    Section {
                        Text("Questa azione copia il testo mostrato nel Second Brain. Diventerà consultabile dalla memoria ordinaria di Ernie. Il resto dell’archivio rimane separato.")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("Conferma e salva nel Second Brain") { Task { await save() } }
                            .disabled(busy || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.count > 160 || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || bodyText.count > 20000)
                        if busy { ProgressView("Salvataggio…") }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Salva nel Second Brain").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(saved ? "Fine" : "Annulla") { dismiss() }.disabled(busy) } }
            .onAppear { title = "Da \(archive.name)"; text = answer.answer }
            .onChange(of: model.credentials) { text = ""; dismiss() }
            .interactiveDismissDisabled(busy)
        }.tint(palette.accentText)
    }
    private var bodyText: String {
        var result = text + "\n\nProvenienza: archivio chat «\(archive.name)», revisione \(answer.coverage.revision). Ultimo messaggio disponibile: \(ChatArchivePresentation.date(answer.coverage.latestMessageAt))."
        if includeSources {
            result += "\n\nMessaggi citati:\n" + answer.sources.map { source in
                "- \(ChatArchivePresentation.date(source.at)) · \(source.sender ?? "Sistema") [\(source.id)]\n\(source.text)"
            }.joined(separator: "\n\n")
        }
        return result
    }
    private func save() async {
        guard let api = model.api else { return }
        busy = true; error = nil
        do {
            _ = try await api.brainCreateNote(title: title, body: bodyText, type: "note")
            guard model.credentials == api.credentials, !Task.isCancelled else { return }; saved = true
        } catch { if model.credentials == api.credentials { self.error = ChatArchivePresentation.error(error) } }
        busy = false
    }
}
