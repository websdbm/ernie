import SwiftUI

/// Foglio «Ernie» nel menu di condivisione: mostra cosa si sta condividendo, una nota facoltativa e il pulsante di salvataggio.
struct ShareView: View {
    @Bindable var model: ShareModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if model.needsSignIn {
                statusLine("Apri Ernie e accedi prima di condividere.", symbol: "person.crop.circle.badge.exclamationmark", tint: Theme.inkSecondary)
            } else {
                if let content = model.content {
                    preview(for: content)
                    noteField
                }
                phaseStatus
            }
            buttons
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.ground)
        .animation(.easeInOut(duration: 0.2), value: model.phase)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "brain.head.profile")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Theme.accentText)
                .frame(width: 44, height: 44)
                .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Ernie")
                    .font(Theme.title(20))
                    .foregroundStyle(Theme.ink)
                Text("Salva nel second brain")
                    .font(.subheadline)
                    .foregroundStyle(Theme.inkSecondary)
            }
            Spacer(minLength: 0)
        }
    }

    /// Anteprima del contenuto: icona, etichetta, titolo e dettaglio (URL, inizio del testo).
    private func preview(for content: ShareContent) -> some View {
        let summary = content.summary
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: summary.symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.accentText)
                .frame(width: 40, height: 40)
                .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.eyebrow.uppercased())
                    .font(Theme.eyebrow)
                    .kerning(0.4)
                    .foregroundStyle(Theme.accentText)
                Text(summary.title)
                    .font(Theme.title(16))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(3)
                if let detail = summary.detail {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(Theme.inkSecondary)
                        .lineLimit(4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .ernieSurface()
        .accessibilityElement(children: .combine)
    }

    private var noteField: some View {
        TextField("Aggiungi una nota (facoltativo)", text: $model.note, axis: .vertical)
            .lineLimit(1...3)
            .font(.body)
            .padding(12)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.hairline))
            .disabled(model.isFinishing)
            .accessibilityLabel("Nota per il second brain, facoltativa")
    }

    /// Stato del salvataggio: caricamento, esito o messaggio di coda.
    @ViewBuilder
    private var phaseStatus: some View {
        switch model.phase {
        case .loading:
            busyLine("Leggo ciò che hai condiviso…")
        case .ready:
            EmptyView()
        case .sending:
            busyLine("Salvo nel second brain…")
        case .saved(let title):
            statusLine("Salvato in «\(title)»", symbol: "checkmark.circle.fill", tint: Theme.positive)
        case .info(let message):
            statusLine(message, symbol: "tray.and.arrow.down.fill", tint: Theme.accentText)
        case .error(let message):
            statusLine(message, symbol: "exclamationmark.triangle.fill", tint: Color.red)
        }
    }

    private var buttons: some View {
        VStack(spacing: 10) {
            if model.canSave {
                Button(action: model.save) {
                    Text("Salva nel second brain")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .controlSize(.large)
                .accessibilityHint("Salva ciò che hai condiviso nel tuo second brain di Ernie")
            }
            if !model.isFinishing {
                Button("Annulla", role: .cancel, action: model.cancel)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    private func busyLine(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView()
            Text(text)
        }
        .font(.subheadline)
        .foregroundStyle(Theme.inkSecondary)
    }

    private func statusLine(_ text: String, symbol: String, tint: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private extension ShareContent {
    /// Come si presenta il contenuto nel foglio: icona, etichetta, titolo e dettaglio facoltativo.
    struct Summary {
        let symbol: String
        let eyebrow: String
        let title: String
        let detail: String?
    }

    var summary: Summary {
        switch self {
        case .link(let url, let title):
            Summary(symbol: "link", eyebrow: "Link", title: title ?? url.host() ?? url.absoluteString, detail: url.absoluteString)
        case .text(let text):
            Summary(symbol: "text.alignleft", eyebrow: "Testo", title: String(text.prefix(160)), detail: nil)
        case .images(_, let names):
            Summary(symbol: "photo.on.rectangle.angled", eyebrow: "Immagini",
                    title: names.count == 1 ? "1 immagine" : "\(names.count) immagini", detail: nil)
        case .pdf(_, let name):
            Summary(symbol: "doc.richtext", eyebrow: "PDF", title: name, detail: nil)
        case .unsupported, .unreadable:
            Summary(symbol: "questionmark.square.dashed", eyebrow: "", title: "", detail: nil)
        }
    }
}
