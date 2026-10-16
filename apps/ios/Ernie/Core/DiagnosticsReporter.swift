import Foundation
import MetricKit
import UIKit

/// Rapporti di iOS (MetricKit): blocchi dell'interfaccia, chiusure per errore, eccessi di CPU e di scrittura, con gli
/// stack. iOS li consegna al primo avvio dopo l'evento e conserva quelli passati: l'app li manda al server
/// (`POST /v1/diagnostics`), così si leggono anche quando il telefono non è collegato al Mac (16 ott 2026: due app
/// bloccate, telefoni fuori casa).
final class DiagnosticsReporter: NSObject, MXMetricManagerSubscriber, Sendable {
    static let shared = DiagnosticsReporter()

    private struct Entry: Sendable {
        let kind: String
        let start: Date
        let end: Date
        let json: Data
    }

    /// All'avvio: iscrizione per i prossimi rapporti e invio di quelli già conservati da iOS.
    @MainActor func start() {
        MXMetricManager.shared.add(self)
        let past = MXMetricManager.shared.pastDiagnosticPayloads.map(Self.entry)
        let os = "iOS \(UIDevice.current.systemVersion)"
        Task.detached(priority: .utility) { await Self.upload(past, os: os) }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let entries = payloads.map(Self.entry)
        let os = "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)"
        Task.detached(priority: .utility) { await Self.upload(entries, os: os) }
    }

    private static func entry(_ p: MXDiagnosticPayload) -> Entry {
        let kind =
            if !(p.crashDiagnostics ?? []).isEmpty { "crash" }
            else if !(p.hangDiagnostics ?? []).isEmpty { "hang" }
            else if !(p.cpuExceptionDiagnostics ?? []).isEmpty { "cpu" }
            else if !(p.diskWriteExceptionDiagnostics ?? []).isEmpty { "disk" }
            else if !(p.appLaunchDiagnostics ?? []).isEmpty { "launch" }
            else { "other" }
        return Entry(kind: kind, start: p.timeStampBegin, end: p.timeStampEnd, json: p.jsonRepresentation())
    }

    private static let sentKey = "diagnostics.sent"

    /// Ogni rapporto una volta sola (chiave: tipo, fine del periodo, dimensione); senza accesso si riprova al
    /// prossimo avvio, perché iOS li ripropone fra quelli passati.
    private static func upload(_ entries: [Entry], os: String) async {
        guard !entries.isEmpty, let credentials = Credentials.load(),
              let url = URL(string: "/v1/diagnostics", relativeTo: credentials.serverURL) else { return }
        var sent = UserDefaults.standard.stringArray(forKey: sentKey) ?? []
        let iso = ISO8601DateFormatter()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        for e in entries {
            let key = "\(e.kind)-\(iso.string(from: e.end))-\(e.json.count)"
            guard !sent.contains(key),
                  let payload = try? JSONSerialization.jsonObject(with: e.json) as? [String: Any] else { continue }
            let body: [String: Any] = [
                "kind": e.kind,
                "appVersion": version,
                "osVersion": os,
                "periodStart": iso.string(from: e.start),
                "periodEnd": iso.string(from: e.end),
                "payload": payload,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: body) else { continue }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = data
            guard let (_, response) = try? await URLSession.shared.data(for: req),
                  (response as? HTTPURLResponse)?.statusCode == 201 else { continue }
            sent.append(key)
            Log.net.info("rapporto di iOS inviato: \(e.kind, privacy: .public)")
        }
        UserDefaults.standard.set(Array(sent.suffix(100)), forKey: sentKey)
    }
}
