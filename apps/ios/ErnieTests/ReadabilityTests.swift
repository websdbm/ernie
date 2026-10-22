import Testing
import Foundation
import SwiftUI
@testable import Ernie

struct MarkdownBreakTests {
    @Test func aCapoHtmlDiventanoRigheEParagrafi() {
        #expect(Markdown.blocks("Ho aggiunto **Stendere**.<br>Avviso alle 22:45.<br /><br/>Fatto.<BR>") == [
            .paragraph("Ho aggiunto **Stendere**.\nAvviso alle 22:45."), .paragraph("Fatto.")
        ])
        #expect(String(Markdown.render("Prima<BR />Dopo").characters) == "Prima\nDopo")
        #expect(Markdown.blocks("<br>\n<BR />").isEmpty)
    }
    @Test func aCapoMantengonoElenchiEGrassetto() {
        #expect(Markdown.blocks("Da fare:<br>- **Stendere**<br>- Leggere") == [.paragraph("Da fare:"), .bullets(["**Stendere**", "Leggere"])])
        #expect(String(Markdown.render("**Prima**<br>**Dopo**").characters) == "Prima\nDopo")
    }
    @Test func codiceEHtmlLetteraleRestanoIntatti() {
        #expect(Markdown.blocks("Usa `<br>` per andare a capo.\n\n```html\nPrima<br>Dopo\n```\n\nFine<br>Ora") == [
            .paragraph("Usa `<br>` per andare a capo."), .code("Prima<br>Dopo"), .paragraph("Fine\nOra")
        ])
        #expect(String(Markdown.render("Il tag `<br>` e il codice ``x`<br>y``.").characters) == "Il tag <br> e il codice x`<br>y.")
        #expect(Markdown.blocks("Un tag \\<br> e &lt;br&gt;.") == [.paragraph("Un tag \\<br> e &lt;br&gt;.")])
        #expect(Markdown.blocks("Una parola <bravo> resta.") == [.paragraph("Una parola <bravo> resta.")])
    }
    @Test func letturaVocaleNonPronunciaGliACapoHtml() {
        #expect(SentenceSplitter.plainForSpeech("Ho aggiunto **Stendere**.<br>Avviso alle 22:45.<br>") == "Ho aggiunto Stendere.\nAvviso alle 22:45.")
        #expect(SentenceSplitter.plainForSpeech("<br>").isEmpty)
    }
}

/// Capoversi leggibili: i paragrafi lunghi vengono spezzati in gruppi di due o tre frasi, senza rompere abbreviazioni e numeri.
struct ReadabilityTests {
    @Test func spezzaLeFrasiRispettandoAbbreviazioniENumeri() {
        let s = Markdown.split("Costa 3.5 euro, es. al mercato. Il dott. Rossi dice che va bene. Davvero! Sì.")
        #expect(s == ["Costa 3.5 euro, es. al mercato.", "Il dott. Rossi dice che va bene.", "Davvero!", "Sì."])
    }

    @Test func paragrafoBreveRestaIntero() {
        let p = "Prima frase. Seconda frase. Terza frase."
        #expect(Markdown.readable(p) == [p])
    }

    @Test func paragrafoLungoDiventaCapoversiDiDueOTreFrasi() {
        let frasi = (1...8).map { "Questa è la frase numero \($0) di un testo volutamente lungo per la prova." }
        let parti = Markdown.readable(frasi.joined(separator: " "))
        #expect(parti.count == 3)
        #expect(parti.map { Markdown.split($0).count } == [3, 3, 2])
        #expect(parti.joined(separator: " ") == frasi.joined(separator: " "))
    }

    @Test func quattroFrasiNonLascianoUnaFraseSola() {
        let frasi = (1...4).map { "Frase numero \($0), abbastanza lunga da superare la soglia dei duecentoventi caratteri complessivi." }
        let parti = Markdown.readable(frasi.joined(separator: " "))
        #expect(parti.map { Markdown.split($0).count } == [2, 2])
    }
}


struct BrainReadabilityTests {
    private let body = """
    # Anna Rossi

    <!-- ernie:family-profile abc123 -->
    Compagna (vedi [[Chi sono]]).

    Nascita: 1980-07-08.
    <!-- /ernie:family-profile -->

    <!-- ernie:consolidated def456 -->
    ## Informazioni collegate

    ### [[Luoghi/Casa Anna.md|Casa di Anna]] · 2026-10-16

    > Indirizzo: via dei Tigli 12, Padova.
    <!-- /ernie:consolidated -->
    """

    @Test func schedaSenzaMarcatoriOTitoloDuplicatoConLinkEDateLeggibili() {
        let visible = BrainFormat.displayBody(body, title: "Anna Rossi")
        #expect(!visible.contains("ernie:"))
        #expect(!visible.contains("abc123"))
        #expect(!visible.contains("# Anna Rossi"))
        #expect(visible.contains("Nascita: 8 luglio 1980."))
        #expect(visible.contains("16 ottobre 2026"))
        #expect(visible.contains("[[Luoghi/Casa Anna.md|Casa di Anna]]"))
        #expect(visible.contains("via dei Tigli 12"))
        #expect(BrainFormat.linkify(visible).contains("ernie-brain://note?title="))
        #expect(body.contains("<!-- ernie:family-profile")) // Il sorgente dell'editor non cambia.
    }

    @Test func anteprimaTroncataNonMostraHashENomiFile() {
        #expect(SecondBrainView.plain("Testo. <!-- ernie:family-profile abc123") == "Testo. ")
        #expect(SecondBrainView.plain("[[Luoghi/Casa Anna.md|Casa di Anna]]") == "Casa di Anna")
        #expect(BrainFormat.displayBody("# Altro titolo\n\nNota personale.", title: "Anna Rossi").contains("# Altro titolo"))
        #expect(BrainFormat.visibleText("Commento personale: ernie: è un prefisso.") == "Commento personale: ernie: è un prefisso.")
    }

    @Test func dateSeparateDalTitoloDellaFonte() {
        let sections = BrainPageLayout.sections(body, title: "Anna Rossi")
        let dated = sections.filter { $0.date != nil }
        #expect(dated.count == 1)
        #expect(dated[0].date == "16 ottobre 2026")
        #expect(dated[0].title == "[[Luoghi/Casa Anna.md|Casa di Anna]]")
        #expect(dated[0].body.contains("via dei Tigli 12"))
        #expect(sections[0].body.contains("Nascita: 8 luglio 1980."))
        #expect(!sections.map(\.body).joined().contains("ernie:"))
    }

    @Test func dateRipetuteESottosezioniRestanoInOrdine() {
        let sections = BrainPageLayout.sections("""
        # Diario
        Introduzione.
        ### 17 ottobre 2026
        Primo aggiornamento.
        #### Dettagli
        - Uno
        - Due
        ### 17 ottobre 2026
        Secondo aggiornamento.
        ## Conclusioni
        Fine.
        """, title: "Diario")
        #expect(sections.count == 4)
        #expect(sections[1].date == sections[2].date)
        #expect(sections[1].body == "Primo aggiornamento.\n#### Dettagli\n- Uno\n- Due")
        #expect(sections[2].body == "Secondo aggiornamento.")
        #expect(sections[3].title == "Conclusioni")
        #expect(sections[3].date == nil)
    }

    @Test func dateNelleFrasiECodiceNonDiventanoSezioni() {
        let text = "Appuntamento il 17 ottobre 2026.\n\n```text\n### 2026-10-17\n```\n\n## 31 febbraio 2026\nDa verificare."
        let sections = BrainPageLayout.sections(text, title: "Nota")
        #expect(sections.count == 2)
        #expect(sections.allSatisfy { $0.date == nil })
        #expect(sections[0].body.contains("### 2026-10-17"))
        #expect(sections[1].title == "31 febbraio 2026")
        #expect(BrainPageLayout.dateLabel("2026-02-31") == nil)
    }

    @Test func noteUniteConDataFraParentesiEIso() {
        let sections = BrainPageLayout.sections("## Visita (17 ottobre 2026)\nEsito.\n### 2026-10-18\nProssimo passo.", title: "Salute")
        #expect(sections.map(\.date) == ["17 ottobre 2026", "18 ottobre 2026"])
        #expect(sections[0].title == "Visita")
        #expect(sections[1].title == nil)
        #expect(BrainPageLayout.heading("Vedi [fonte](https://example.org)").date == nil)
    }

    @Test @MainActor func anteprimaVisivaScheda() throws {
        let note = BrainNoteDetail(path: "Persone/Anna Rossi.md", title: "Anna Rossi", type: "persona", created: "2026-10-13", links: [], private: false, source: "scheda", body: body)
        let variants: [(String, CGFloat, DynamicTypeSize, ColorScheme)] = [("standard", 390, .large, .light), ("large-text", 320, .xxxLarge, .light), ("dark", 390, .large, .dark)]
        for (name, width, size, scheme) in variants {
            let view = BrainNoteContent(note: note).padding(20).frame(width: width)
                .background(Theme.surface).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try #require(renderer.uiImage)
            let png = try #require(image.pngData())
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-brain-\(name).png")
            try png.write(to: url)
            print("BRAIN_SNAPSHOT: \(url.path)")
        }
    }
    @Test @MainActor func anteprimaVisivaCronologiaEdElenco() throws {
        let note = BrainNoteDetail(path: "Note/Viaggio.md", title: "Viaggio a Trieste", type: "nota", created: "2026-10-13", place: "Trieste", links: [], private: false, source: "conversazione", body: """
        # Viaggio a Trieste
        Appunti per organizzare il fine settimana, con le informazioni raccolte giorno per giorno.
        ## Da organizzare
        - Prenotare il treno.
        - Scegliere un posto per pranzo.
        ### 16 ottobre 2026
        Abbiamo scelto di partire la mattina e passeggiare sul lungomare.
        ### 17 ottobre 2026
        Il tavolo è confermato per le 13:00.

        **Da ricordare:** portare una giacca e i biglietti del treno.
        """)
        let summary = BrainNoteSummary(path: note.path, title: note.title, type: note.type, created: note.created, place: note.place, links: [], private: false, excerpt: "Appunti per il fine settimana: treno, passeggiata e pranzo.")
        for (name, width, size, scheme) in [("timeline", CGFloat(390), DynamicTypeSize.large, ColorScheme.light), ("timeline-small", CGFloat(320), .xxxLarge, .light), ("timeline-dark", CGFloat(390), .large, .dark)] {
            let view = VStack(alignment: .leading, spacing: 28) {
                BrainNoteRow(note: summary)
                Divider()
                BrainNoteContent(note: note)
            }.padding(20).frame(width: width).background(Theme.surface)
                .environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let png = try #require(renderer.uiImage?.pngData())
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-brain-\(name).png")
            try png.write(to: url)
            print("BRAIN_SNAPSHOT: \(url.path)")
        }
    }

}

struct ActivityReadabilityTests {
    @MainActor @Test func etichetteCompleteAncheConTestoGrande() throws {
        let view = VStack(alignment: .leading, spacing: 12) {
            ToolPill(name: ToolLabels.name("brain_merge"), ok: true)
            ToolPill(name: ToolLabels.name("present_choices"), ok: true)
            ToolPill(name: ToolLabels.name("place_set"), ok: nil)
            ToolPill(name: ToolLabels.name("shopping_list_add"), ok: true)
            Text("Recupero della risposta (2/3)…").font(.footnote)
            Button("Recupera risposta") {}.buttonStyle(.bordered)
        }.padding(20).frame(width: 320)
            .background(Color.white).environment(\.colorScheme, .light)
            .environment(\.dynamicTypeSize, .xxxLarge)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let png = try #require(renderer.uiImage?.pngData())
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-activities-readable.png")
        try png.write(to: url)
        print("ACTIVITY_SNAPSHOT: \(url.path)")
    }
}

struct BrainOverviewTests {
    @Test func decodificaRiepilogoCoordinateEFontiSenzaCambiareIlCorpo() throws {
        let json = #"{"note":{"path":"Persone/Anna Rossi.md","title":"Anna Rossi","type":"persona","created":"2026-10-13","place":"Padova","coords":[45.4,11.8],"links":[],"private":false,"body":"Testo originale, anche ripetuto.","overview":{"facts":[{"text":"Numero di scarpe: **41**.","sourcePath":"Note/Scarpe.md","sourceTitle":"Scarpe","date":"2026-10-17"}],"places":[{"path":"Luoghi/Casa genitori Anna.md","title":"Casa dei genitori di Anna","address":null,"coords":[45.42,11.87]}]}},"backlinks":[]}"#
        let response = try JSONDecoder().decode(BrainNoteResponse.self, from: Data(json.utf8))
        #expect(response.note.hasOverview)
        #expect(response.note.coords == [45.4, 11.8])
        #expect(response.note.overview?.facts.first?.sourceTitle == "Scarpe")
        #expect(response.note.overview?.facts.first?.date == "2026-10-17")
        #expect(response.note.overview?.places.first?.address == nil)
        #expect(response.note.visiblePlaces.count == 2)
        #expect(response.note.body == "Testo originale, anche ripetuto.")
    }

    @Test func serverPrecedenteMantieneCorpoEPosizione() throws {
        let json = #"{"note":{"path":"Luoghi/Parco.md","title":"Parco","type":"luogo","created":"2026-10-13","coords":[45.42,11.87],"links":[],"private":false,"body":"Appunto da conservare."},"backlinks":[]}"#
        let response = try JSONDecoder().decode(BrainNoteResponse.self, from: Data(json.utf8))
        #expect(!response.note.hasOverview)
        #expect(response.note.overview == nil)
        #expect(response.note.body == "Appunto da conservare.")
        #expect(response.note.visiblePlaces.count == 1)
        #expect(response.note.visiblePlaces.first?.mapsURL != nil)
        let nullOverview = json.replacingOccurrences(of: #""coords":[45.42,11.87],"#, with: #""overview":null,"#)
        let older = try JSONDecoder().decode(BrainNoteResponse.self, from: Data(nullOverview.utf8))
        #expect(older.note.coords == nil)
        #expect(!older.note.hasOverview)
        #expect(older.note.visiblePlaces.isEmpty)
    }

    @Test func mappeUsaSoloCoordinateValideEQueryCodificata() throws {
        let title = "Casa di Anna & famiglia #1"
        let url = try #require(BrainLocation.mapsURL(coords: [45.42, 11.87], title: title))
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(components.scheme == "https")
        #expect(components.host == "maps.apple.com")
        #expect(components.queryItems?.first(where: { $0.name == "q" })?.value == title)
        #expect(components.queryItems?.first(where: { $0.name == "ll" })?.value == "45.42,11.87")
        for invalid in [[], [45], [45, 12, 1], [91, 12], [45, -181], [Double.nan, 12], [45, Double.infinity]] {
            #expect(BrainLocation.mapsURL(coords: invalid, title: title) == nil)
        }
        #expect(BrainLocation.mapsURL(coords: nil, title: title) == nil)
        #expect(BrainLocation.mapsURL(coords: [0, 0], title: title) != nil)
    }

    @Test func coordinateProprieNonDuplicanoIlLuogoNelRiepilogo() {
        var note = BrainNoteDetail(path: "Luoghi/Casa.md", title: "Casa", type: "luogo", created: "2026-10-13", coords: [45, 12], links: [], private: false, body: "Originale.", overview: BrainOverview(facts: [], places: [.init(path: "Luoghi/Casa.md", title: "Casa", coords: nil)]))
        #expect(note.visiblePlaces.count == 1)
        #expect(note.visiblePlaces.first?.coords == [45, 12])
        note.overview = BrainOverview(facts: [], places: [])
        #expect(!note.hasOverview) // Un riepilogo vuoto non nasconde il corpo.
        #expect(note.visiblePlaces.count == 1)
    }

    @Test func luoghiOrdinatiPerUtilitaConOrdineStabileANettoDiParita() {
        let places: [BrainOverview.Place] = [
            .init(path: "centro", title: "Centro", address: nil, coords: nil),
            .init(path: "casa", title: "Casa", address: "Via dei Tigli 12", coords: nil),
            .init(path: "genitori", title: "Casa dei genitori", address: nil, coords: [45, 12]),
            .init(path: "attuale", title: "Scheda corrente", address: nil, coords: nil),
            .init(path: "parco", title: "Parco", address: nil, coords: [46, 11]),
            .init(path: "studio", title: "Studio", address: "Via del Sole 3", coords: [91, 12]),
            .init(path: "riferimento", title: "Riferimento", address: "  ", coords: nil)
        ]
        let note = BrainNoteDetail(path: "attuale", title: "Scheda corrente", type: "luogo", created: "2026-10-17", links: [], private: false, body: "", overview: BrainOverview(facts: [], places: places))
        #expect(note.visiblePlaces.map(\.path) == ["attuale", "genitori", "parco", "casa", "studio", "centro", "riferimento"])
        #expect(note.overview?.places.map(\.path) == places.map(\.path)) // L'ordinamento è solo di lettura.
    }

    @Test @MainActor func anteprimeRiepilogoCompattoEStoricoSeparato() throws {
        let person = "Persone/Anna Rossi.md"
        let parents = "Luoghi/Casa genitori Anna.md"
        let note = BrainNoteDetail(path: person, title: "Anna Rossi", type: "persona", created: "2026-10-13", place: "Padova", links: [], private: false, source: "scheda", body: """
        # Anna Rossi
        Compagna (vedi [[Chi sono]]).
        Nascita: 1980-07-08.
        ### 16 ottobre 2026
        Numero di scarpe: 41.
        ### 17 ottobre 2026
        Numero di scarpe: 41.
        I genitori vivono a Padova. Posizione confermata nella [[Luoghi/Casa genitori Anna.md|scheda della loro casa]].
        """, overview: BrainOverview(facts: [
            .init(text: "Compagna (vedi [[Chi sono]]).", sourcePath: person, sourceTitle: "Anna Rossi"),
            .init(text: "Nascita: 1980-07-08.", sourcePath: person, sourceTitle: "Anna Rossi"),
            .init(text: "Numero di scarpe: **41**.", sourcePath: person, sourceTitle: "Anna Rossi", date: "2026-10-17"),
            .init(text: "I genitori vivono a **Padova**.", sourcePath: parents, sourceTitle: "Casa dei genitori di Anna")
        ], places: [
            .init(path: parents, title: "Casa dei genitori di Anna", coords: [45.42, 11.87])
        ]))
        // La deduplicazione è compito del server: il client presenta i fatti e conserva lo storico originale.
        #expect(note.overview?.facts.filter { $0.text.contains("41") }.count == 1)
        #expect(note.body.components(separatedBy: "41").count == 3)
        let variants: [(String, CGFloat, DynamicTypeSize, ColorScheme, Bool)] = [
            ("overview", 390, .large, .light, false),
            ("overview-small", 320, .xxxLarge, .light, false),
            ("overview-dark", 390, .large, .dark, false),
            ("overview-history", 390, .large, .light, true)
        ]
        for (name, width, size, scheme, expanded) in variants {
            let view = BrainNoteContent(note: note, historyExpanded: expanded).padding(20).frame(width: width)
                .background(Theme.surface).environment(\.colorScheme, scheme).environment(\.dynamicTypeSize, size)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let png = try #require(renderer.uiImage?.pngData())
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-brain-\(name).png")
            try png.write(to: url)
            print("BRAIN_OVERVIEW_SNAPSHOT: \(url.path)")
        }
        let placeNote = BrainNoteDetail(path: parents, title: "Casa dei genitori di Anna", type: "luogo", created: "2026-10-17", coords: [45.42, 11.87], links: [], private: false, body: "Posizione confermata durante una visita.")
        let legacy = BrainNoteContent(note: placeNote).padding(20).frame(width: 320).background(Theme.surface)
        let renderer = ImageRenderer(content: legacy)
        renderer.scale = 2
        let png = try #require(renderer.uiImage?.pngData())
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ernie-brain-overview-legacy-gps.png")
        try png.write(to: url)
        print("BRAIN_OVERVIEW_SNAPSHOT: \(url.path)")
    }
}
