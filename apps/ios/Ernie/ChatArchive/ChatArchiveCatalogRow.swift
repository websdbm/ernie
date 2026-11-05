import SwiftUI

struct ChatArchiveCatalogRow: View {
    let archive: ChatArchive
    @Environment(\.chatPalette) private var palette
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(archive.name, systemImage: archive.kind == "group" ? "person.3" : "bubble.left")
                .font(.headline).foregroundStyle(palette.ink).fixedSize(horizontal: false, vertical: true)
            if let summary = archive.summary, !summary.isEmpty {
                Text(summary).font(.subheadline).foregroundStyle(palette.ink).lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
            Text("\(archive.kind == "group" ? "Gruppo" : "Privata") · \(archive.messageCount) messaggi · \(archive.participantCount) mittenti")
                .font(.caption).foregroundStyle(palette.inkSecondary)
            VStack(alignment: .leading, spacing: 3) {
                Text("Ultimo import: \(ChatArchivePresentation.date(archive.lastImportedAt))")
                Text("Ultimo messaggio: \(ChatArchivePresentation.date(archive.latestMessageAt))")
            }.font(.caption).foregroundStyle(palette.inkSecondary).fixedSize(horizontal: false, vertical: true)
            if let category = archive.category { Text(category).font(.caption.weight(.medium)).foregroundStyle(palette.accentText) }
            if !archive.tags.isEmpty { Text(archive.tags.map { "#" + $0 }.joined(separator: " ")).font(.caption).foregroundStyle(palette.inkSecondary) }
            if !archive.indexReady { Label("Indice in aggiornamento", systemImage: "clock").font(.caption).foregroundStyle(.orange) }
        }.padding(.vertical, 6).accessibilityElement(children: .combine)
    }
}
