import SwiftUI

/// Novità di ogni versione (richiesta dell'utente, 14 ott 2026): dopo un aggiornamento l'app mostra cosa è
/// cambiato e come provarlo, per aiutare i test. L'elenco sta in `Resources/Changelog.json`, lo stesso file da cui
/// `scripts/asc.mjs whats-new` scrive «Cosa testare» su TestFlight.
struct ChangelogEntry: Decodable, Identifiable, Sendable {
    struct Item: Decodable, Sendable, Hashable {
        let icon: String
        let title: String
        let detail: String
        let test: String?
    }

    let build: Int
    let date: String
    let title: String
    let items: [Item]

    var id: Int { build }
}

enum Changelog {
    /// Tutte le versioni dal file incluso nell'app, dalla più recente.
    static func load() -> [ChangelogEntry] {
        guard let url = Bundle.main.url(forResource: "Changelog", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([ChangelogEntry].self, from: data)
        else { return [] }
        return entries.sorted { $0.build > $1.build }
    }

    /// Numero di build installato (CFBundleVersion).
    static var currentBuild: Int {
        Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    }

    private static let seenKey = "ernie.changelog.lastSeenBuild"

    /// Versioni da mostrare all'avvio: quelle uscite dopo l'ultima vista. La prima volta che c'è questa funzione
    /// mostra la versione attuale e la precedente; dopo una nuova installazione non mostra niente.
    static func unseen(entries: [ChangelogEntry] = load(), current: Int = currentBuild, defaults: UserDefaults = .standard) -> [ChangelogEntry] {
        guard current > 0 else { return [] }
        let stored = defaults.object(forKey: seenKey) as? Int
        let freshInstall = TranscriptStore().list(limit: 1).isEmpty && defaults.object(forKey: "ernie.localSettings") == nil
        let lastSeen = stored ?? (freshInstall ? current : current - 2)
        return entries.filter { $0.build > lastSeen && $0.build <= current }
    }

    static func markSeen(current: Int = currentBuild, defaults: UserDefaults = .standard) {
        defaults.set(current, forKey: seenKey)
    }
}

/// Foglio «Novità»: una sezione per versione, con cosa è cambiato e, per ciascuna voce, come provarla.
struct WhatsNewView: View {
    let entries: [ChangelogEntry]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    if entries.isEmpty {
                        Text("Nessuna novità da mostrare.")
                            .foregroundStyle(Theme.inkSecondary)
                    }
                    ForEach(entries) { entry in
                        section(entry)
                    }
                }
                .padding(16)
            }
            .background(Theme.ground.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ho capito") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(Theme.accentText)
                .frame(width: 56, height: 56)
                .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .accessibilityHidden(true)
            Text("Novità")
                .font(Theme.title(30))
                .foregroundStyle(Theme.ink)
            Text("Cosa è cambiato e come provarlo.")
                .font(.subheadline)
                .foregroundStyle(Theme.inkSecondary)
        }
    }

    private func section(_ entry: ChangelogEntry) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(entry.title)
                    .font(Theme.title(19))
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text("Versione \(entry.build) · \(Self.day(entry.date))")
                    .font(.caption)
                    .foregroundStyle(Theme.inkSecondary)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(entry.items.enumerated()), id: \.offset) { index, item in
                    if index > 0 { Divider().overlay(Theme.hairline).padding(.leading, 56) }
                    row(item)
                }
            }
            .ernieSurface()
        }
    }

    private func row(_ item: ChangelogEntry.Item) -> some View {
        HStack(alignment: .top, spacing: 12) {
            SkillIcon(systemName: item.icon, tint: .brain, size: 36)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                Text(item.detail)
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let test = item.test, !test.isEmpty {
                    Label {
                        Text(test).fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "checkmark.circle")
                    }
                    .font(.footnote)
                    .foregroundStyle(Theme.accentText)
                    .padding(.top, 2)
                    .accessibilityLabel("Come provarla: \(test)")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
    }

    /// «2026-10-14» → «14 ott 2026».
    private static func day(_ iso: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: iso) else { return iso }
        return d.formatted(.dateTime.day().month(.abbreviated).year().locale(Locale(identifier: "it_IT")))
    }
}
