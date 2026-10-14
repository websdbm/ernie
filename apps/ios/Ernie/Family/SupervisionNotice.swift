import SwiftUI

/// Controllo genitori, lato figlio: avviso fisso «account seguito» con l'ultima consultazione delle conversazioni.
///
/// Carica da solo `GET /v1/family/supervision` a ogni comparsa della vista. Se l'account non è seguito non occupa spazio;
/// lo stesso vale mentre carica. Se un aggiornamento fallisce, resta l'ultimo stato noto. L'avviso non limita nulla:
/// spiega al figlio chi lo segue e quando il genitore ha guardato le conversazioni.
struct SupervisionNotice: View {
    /// `true`: una riga sola, per gli spazi stretti; `false`: scheda completa.
    var compact: Bool = false

    @Environment(AppModel.self) private var model
    /// Ultimo stato noto dell'account (nil finché non arriva una risposta).
    @State private var supervision: Supervision?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let supervision, supervision.supervised {
                if compact {
                    compactLine(supervision)
                } else {
                    card(supervision)
                        // Il margine sta dentro l'avviso: se è vuoto non lascia spazi nel pannello.
                        .padding(.top, 16)
                }
            }
        }
        .task { await load() }
    }

    // MARK: - scheda e riga compatta

    /// Scheda completa: icona e titolo della supervisione, poi chi segue l'account e l'ultima consultazione.
    private func card(_ s: Supervision) -> some View {
        let title = "Account seguito da \(Self.joinedLabels(s))"
        let detail = Self.bodyText(s)
        let last = Self.lastLine(s)
        return ErnieCard(icon: "shield.lefthalf.filled", tint: .sentinels, eyebrow: "Controllo genitori", title: title) {
            VStack(alignment: .leading, spacing: 6) {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(last)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(detail) \(last)")
    }

    /// Una riga sola: «Seguito da papà · ultima consultazione oggi 15:30».
    private func compactLine(_ s: Supervision) -> some View {
        let line = Self.compactText(s)
        return HStack(spacing: 6) {
            Image(systemName: "shield.lefthalf.filled")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(SkillTint.sentinels.color)
                .accessibilityHidden(true)
            Text(line)
                .font(.footnote)
                .foregroundStyle(Theme.inkSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SkillTint.sentinels.soft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(line)
    }

    // MARK: - caricamento

    /// Chiede lo stato al server; in caso di errore tiene l'ultimo stato noto.
    private func load() async {
        guard let api = model.api else { return }
        do {
            supervision = try await api.supervision()
        } catch {
            // Errore di rete o del server: nessun cambiamento, l'avviso resta quello di prima.
        }
    }

    // MARK: - testi

    /// Etichette dei genitori in italiano: «mamma», «mamma e papà», «mamma, papà e zia».
    private static func joinedLabels(_ s: Supervision) -> String {
        let names = s.guardians.map(\.label).filter { !$0.isEmpty }
        guard let last = names.last else { return "un genitore" }
        if names.count == 1 { return last }
        return names.dropLast().joined(separator: ", ") + " e " + last
    }

    /// Corpo della scheda: al singolare o al plurale a seconda dei genitori.
    private static func bodyText(_ s: Supervision) -> String {
        let names = joinedLabels(s)
        if s.guardians.count > 1 {
            return "\(names) scelgono le skill che puoi usare e possono leggere le tue conversazioni con Ernie."
        }
        return "\(names) sceglie le skill che puoi usare e può leggere le tue conversazioni con Ernie."
    }

    /// Riga dell'ultima consultazione della scheda.
    private static func lastLine(_ s: Supervision) -> String {
        guard let date = lastReview(s) else {
            return s.guardians.count > 1
                ? "Nessuno dei genitori ha ancora guardato le conversazioni."
                : "Non ha ancora guardato le conversazioni."
        }
        return "Ultima consultazione: \(relativeMoment(date, compact: false))"
    }

    /// Testo della riga compatta.
    private static func compactText(_ s: Supervision) -> String {
        let head = "Seguito da \(joinedLabels(s)) · "
        guard let date = lastReview(s) else { return head + "nessuna consultazione ancora" }
        return head + "ultima consultazione \(relativeMoment(date, compact: true))"
    }

    /// La consultazione più recente tra quelle dei genitori (nil se nessuno ha ancora guardato).
    private static func lastReview(_ s: Supervision) -> Date? {
        s.guardians.compactMap { $0.lastReviewAt.flatMap(parse) }.max()
    }

    /// Momento in italiano: «oggi alle 15:30», «ieri alle 9:10», «12 ottobre» (con l'anno se diverso). Compatto: «oggi 15:30».
    private static func relativeMoment(_ date: Date, compact: Bool) -> String {
        let calendar = Calendar.current
        let hour = formatter("H:mm").string(from: date)
        if calendar.isDateInToday(date) {
            return compact ? "oggi \(hour)" : "oggi alle \(hour)"
        }
        if calendar.isDateInYesterday(date) {
            return compact ? "ieri \(hour)" : "ieri alle \(hour)"
        }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: .now)
        return formatter(sameYear ? "d MMMM" : "d MMMM yyyy").string(from: date)
    }

    /// Data ISO 8601 del server, con o senza millisecondi.
    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: iso) { return date }
        return ISO8601DateFormatter().date(from: iso)
    }

    /// Formattatore in italiano con il formato indicato.
    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "it_IT")
        f.dateFormat = format
        return f
    }
}
