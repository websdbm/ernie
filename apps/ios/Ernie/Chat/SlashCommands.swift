import Foundation
import SwiftUI

/// Scorciatoie locali: nessuna esecuzione di tool o richiesta al modello.
enum SlashCommand: String, CaseIterable, Identifiable, Sendable {
    case message = "messaggio", family = "famiglia", todo = "todo", recipes = "ricette"
    case brain = "brain", media = "media", reminders = "promemoria", automations = "automazioni"
    case ssh = "ssh", settings = "impostazioni", usage = "consumi", help = "aiuto"
    var id: String { rawValue }
    var aliases: [String] {
        switch self {
        case .message: ["msg"]
        case .todo: ["attivita"]
        case .brain: ["memoria", "secondbrain"]
        case .reminders: ["impegni", "reminder"]
        case .help: ["help", "comandi"]
        default: []
        }
    }
    var detail: String {
        switch self {
        case .message: "Prepara un messaggio a un familiare"
        case .family: "Apri Famiglia"
        case .todo: "Apri le liste di attività"
        case .recipes: "Apri la raccolta ricette"
        case .brain: "Apri il Second Brain"
        case .media: "Apri immagini e foto"
        case .reminders: "Apri i tuoi impegni"
        case .automations: "Apri le automazioni"
        case .ssh: "Apri server e siti"
        case .settings: "Apri le impostazioni"
        case .usage: "Apri i tuoi consumi"
        case .help: "Vedi tutti i comandi disponibili"
        }
    }
    var symbol: String {
        switch self {
        case .message: "square.and.pencil"
        case .family: "person.2"
        case .todo: "checklist"
        case .recipes: "books.vertical"
        case .brain: "brain.head.profile"
        case .media: "photo.on.rectangle"
        case .reminders: "bell"
        case .automations: "gearshape.2"
        case .ssh: "server.rack"
        case .settings: "gearshape"
        case .usage: "chart.bar"
        case .help: "questionmark.circle"
        }
    }
    var skill: String? {
        switch self {
        case .todo: "todo"
        case .recipes: "ricette"
        case .brain: "second_brain"
        case .ssh: "ssh"
        default: nil
        }
    }
    var destination: PanelDestination? {
        switch self {
        case .family: .family
        case .todo: .todo
        case .recipes: .recipes
        case .brain: .brain
        case .media: .media
        case .reminders: .reminders
        case .automations: .automations
        case .ssh: .ssh
        case .settings: .settings
        case .usage: .usage
        case .help, .message: nil
        }
    }
    static func find(_ name: String) -> Self? {
        let key = name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "it_IT"))
        return allCases.first { $0.rawValue == key || $0.aliases.contains(key) }
    }
}

struct SlashInput: Equatable {
    let name: String
    let arguments: String
    var command: SlashCommand? { SlashCommand.find(name) }
    init?(_ draft: String) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix("/") else { return nil }
        let rest = text.dropFirst()
        let end = rest.firstIndex(where: \.isWhitespace) ?? rest.endIndex
        name = String(rest[..<end])
        arguments = String(rest[end...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    func suggestions(skills: [SkillInfo]?) -> [SlashCommand] {
        let query = name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "it_IT"))
        return SlashCommand.allCases.filter { command in
            let matches = query.isEmpty || ([command.rawValue] + command.aliases).contains { $0.hasPrefix(query) }
            return matches && (command.skill == nil || skills?.contains { $0.id == command.skill && $0.active } == true)
        }
    }
    func validationError(skills: [SkillInfo]?, hasAttachment: Bool) -> String? {
        if hasAttachment { return "Conserva o togli l’allegato prima di usare un comando." }
        guard let command else { return name.isEmpty && arguments.isEmpty ? nil : "Comando non riconosciuto. Scrivi /aiuto per vedere quelli disponibili." }
        if let skill = command.skill, skills?.contains(where: { $0.id == skill && $0.active }) != true {
            return skills == nil ? "Non riesco ancora a verificare le skill. Riprova tra poco." : "Questa skill è spenta o non disponibile. Controlla Impostazioni → Skill."
        }
        if command != .message && !arguments.isEmpty { return "Questo comando apre una sezione: usalo senza testo aggiuntivo." }
        if command == .message && arguments.count > 2000 { return "Il messaggio può contenere al massimo 2.000 caratteri. Accorcialo prima di continuare." }
        return nil
    }
}

struct SlashCommandLoadKey: Equatable {
    var credentials: Credentials?
    var browsing: Bool
}

struct SlashCommandMenu: View {
    var commands: [SlashCommand]
    var loading = false
    var expanded = false
    var onSelect: (SlashCommand) -> Void
    var onClose: (() -> Void)?
    @Environment(\.chatPalette) private var palette
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 76

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("Comandi").font(.caption.weight(.semibold)).foregroundStyle(palette.inkSecondary)
                Spacer()
                if loading { ProgressView().controlSize(.small).accessibilityLabel("Verifica delle skill") }
                if let onClose {
                    Button(action: onClose) { Image(systemName: "xmark").frame(width: 44, height: 36) }
                        .buttonStyle(.plain).accessibilityLabel("Nascondi i comandi")
                }
            }.padding(.horizontal, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if commands.isEmpty {
                        Text("Nessun comando corrispondente. Prova /aiuto.")
                            .font(.footnote).foregroundStyle(palette.inkSecondary).padding(12)
                    }
                    ForEach(commands) { command in
                        Button { onSelect(command) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: command.symbol).frame(width: 24).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("/" + command.rawValue).font(.system(.subheadline, design: .monospaced).weight(.semibold))
                                    Text(command.detail).font(.caption).foregroundStyle(palette.inkSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 0)
                            }
                            .foregroundStyle(palette.ink)
                            .padding(.horizontal, 12).padding(.vertical, 10)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityElement(children: .combine)
                    }
                }
            }
            .frame(height: expanded ? nil : min(188, CGFloat(max(1, commands.count)) * rowHeight))
            .frame(maxHeight: expanded ? .infinity : nil)
        }
        .padding(.vertical, 6)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(palette.hairline, lineWidth: 1) }
    }
}
