import SwiftUI

/// Latenza per stadio dei turni vocali (A.14), motore di trascrizione, spike S1 dei marker TTS.
struct DiagnosticsView: View {
    @Environment(AppModel.self) private var model
    @State private var availability = "…"
    @State private var probing = false
    @State private var reports: [TtsMarkerProbe.Report] = []

    var body: some View {
        List {
            Section("Latenza udibile (rilascio → prima parola)") {
                let values = (model.conversation?.latencyHistory ?? []).compactMap(\.audibleLatency)
                if values.isEmpty {
                    Text("Nessun turno vocale ancora").foregroundStyle(.secondary)
                } else {
                    LabeledContent("p50", value: fmt(LatencyTrace.percentile(values, 0.5)))
                    LabeledContent("p95", value: fmt(LatencyTrace.percentile(values, 0.95)))
                    LabeledContent("turni", value: "\(values.count)")
                }
                if let last = model.conversation?.latencyHistory.last {
                    LabeledContent("ultimo: STT finale", value: fmt(last.sttFinalization))
                    LabeledContent("ultimo: primo token", value: fmt(last.timeToFirstToken))
                    LabeledContent("ultimo: udibile", value: fmt(last.audibleLatency))
                }
            }
            Section("Trascrizione") {
                LabeledContent("Motore usato", value: model.voice?.engineName ?? "—")
                LabeledContent("Voice processing", value: (model.voice?.voiceProcessingActive ?? false) ? "attivo" : "non attivo")
                Text(availability).font(.footnote).foregroundStyle(.secondary)
            }
            Section("Spike S1: marker della sintesi vocale") {
                Button(probing ? "In corso…" : "Esegui con le voci italiane installate") {
                    Task {
                        probing = true
                        reports = await TtsMarkerProbe().run()
                        probing = false
                    }
                }
                .disabled(probing)
                ForEach(reports) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(r.voice) (\(r.quality))").font(.subheadline.weight(.semibold))
                        Text("write(): \(describe(r.writeMarkers)) · audio \(String(format: "%.1f", r.audioSeconds)) s")
                        Text("speak(): \(r.speakWordCallbacks) callback di parola, marker \(describe(r.speakMarkers)), primo a \(fmt(r.firstCallbackSeconds))")
                    }
                    .font(.footnote)
                }
            }
        }
        .navigationTitle("Diagnostica")
        .task { availability = await SpeechInputFactory.describeAvailability() }
    }

    private func fmt(_ v: Double?) -> String { v.map { String(format: "%.2f s", $0) } ?? "—" }

    private func describe(_ m: [String: Int]) -> String {
        m.isEmpty ? "nessuno" : m.keys.sorted().map { "\($0)=\(m[$0] ?? 0)" }.joined(separator: " ")
    }
}
