import Foundation

struct HealthConsentState: Codable, Sendable, Equatable {
    var revision: Int
    var aiAllowed: Bool
    var policyVersion: Int
    var grantedAt: String?
    var revokedAt: String?
}
struct HealthCapabilities: Codable, Sendable, Equatable {
    struct Migration: Codable, Sendable, Equatable {
        enum State: String, Codable, Sendable { case pending, ready, blocked }
        var state: State
    }
    var available: Bool
    var skillEnabled: Bool
    var encryptionReady: Bool
    var policyVersion: Int
    var policyText: String
    var consent: HealthConsentState
    var migration: Migration
    var manualReady: Bool { encryptionReady && migration.state == .ready }
    var aiReady: Bool { manualReady && available && skillEnabled && consent.aiAllowed && consent.policyVersion == policyVersion && policyVersion == 1 }
}
enum HealthSourceKind: String, Codable, Sendable { case scan, photo, pdf, text }
struct HealthSourceSummary: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String
    var source: HealthSourceKind
    var pages: Int
    var createdAt: String
    var status: String
    var reportId: String?
}
struct HealthAttachmentInfo: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var mimeType: String
    var bytes: Int
}
struct HealthSourceDetail: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var title: String
    var source: HealthSourceKind
    var pages: [String]
    var createdAt: String
    var status: String
    var reportId: String?
    var attachments: [HealthAttachmentInfo]
}
struct HealthAttachment: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var mimeType: String
    var dataBase64: String
}
struct HealthReportSummary: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var takenOn: String?
    var lab: String?
    var kind: String
    var values: Int
    var outOfRange: Int
}
struct HealthReportDetail: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var takenOn: String?
    var lab: String?
    var kind: String
    var againstDate: String?
    var rows: [HealthBlock.Row]
    var block: HealthBlock {
        .init(mode: "report", title: lab?.isEmpty == false ? lab! : "Referto", subtitle: takenOn.map(HealthFormat.shortDay) ?? "Data non disponibile", rows: rows)
    }
}
struct HealthParameterDetail: Codable, Sendable, Equatable {
    var label: String
    var rows: [HealthBlock.Row]
    var trend: String?
    var block: HealthBlock { .init(mode: "parameter", title: label, rows: rows) }
}
struct HealthAnalysisResult: Codable, Sendable { var reportId: String; var values: Int; var outOfRange: Int }
struct HealthAnswer: Codable, Sendable, Equatable {
    struct Source: Codable, Sendable, Equatable, Identifiable { var id: String; var title: String }
    var answer: String
    var sources: [Source]
    var model: String
}
struct HealthExportPayload: Codable, Sendable { var filename: String; var mimeType: String; var dataBase64: String }
struct HealthVaultDraft: Codable, Sendable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var title: String
    var source: HealthSourceKind
    var pages: [String]
    var attachments: [HealthAttachment]
    static let maxCharacters = 400_000
    static let maxImageBytes = 3 * 1024 * 1024
    static let maxPDFBytes = 8 * 1024 * 1024
    static let maxRequestBytes = 32 * 1024 * 1024
    func validate() throws {
        guard UUID(uuidString: id) != nil, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              title.count <= 160, !pages.isEmpty, pages.count <= DocumentReader.maxPages,
              pages.reduce(0, { $0 + $1.utf16.count }) <= Self.maxCharacters,
              attachments.count <= 10 else { throw HealthVaultError.invalidImport }
        for attachment in attachments {
            guard UUID(uuidString: attachment.id) != nil,
                  ["application/pdf", "image/jpeg", "image/png"].contains(attachment.mimeType),
                  !attachment.name.isEmpty, attachment.name.count <= 240,
                  let data = Data(base64Encoded: attachment.dataBase64), !data.isEmpty,
                  data.count <= (attachment.mimeType == "application/pdf" ? Self.maxPDFBytes : Self.maxImageBytes)
            else { throw HealthVaultError.invalidImport }
        }
        guard try JSONEncoder().encode(self).count <= Self.maxRequestBytes else { throw HealthVaultError.invalidImport }
    }
}
enum HealthVaultError: Error, Equatable {
    case invalidImport, unavailable, invalidResponse, access, conflict, consent, oversized, network
    case noValues, analysisTooLarge, contextTooLarge, empty, busy, notFound
    var message: String {
        switch self {
        case .invalidImport: "Documento non valido o troppo grande. Massimo 10 allegati: immagini da 3 MB, PDF da 8 MB e 400.000 caratteri di testo."
        case .unavailable: "La sezione protetta non è ancora pronta. Aggiorna lo stato prima di proseguire."
        case .invalidResponse: "La risposta non è disponibile. Aggiorna la sezione e riprova."
        case .access: "Accesso non consentito. Controlla l’account e i permessi."
        case .conflict: "I dati o le autorizzazioni sono cambiati. Aggiorna prima di riprovare."
        case .consent: "Per usare l’AI attiva la skill Salute e autorizza l’analisi in questa sezione."
        case .oversized: "Il contenuto è troppo grande. Esporta o importa un elemento alla volta."
        case .noValues: "Non ho trovato valori di laboratorio da strutturare. Il documento resta consultabile: puoi fare una domanda sui suoi contenuti."
        case .analysisTooLarge: "Il documento è conservato per intero. Per estrarre i valori, importa una sezione di massimo 40.000 caratteri."
        case .contextTooLarge: "Hai selezionato troppi contenuti. Scegli meno referti o documenti e riprova."
        case .empty: "Importa un documento in Salute prima di fare una domanda."
        case .busy: "Un’analisi è già in corso. Attendi oppure revoca il consenso per interromperla."
        case .notFound: "Questo elemento non è più disponibile. Aggiorna l’archivio."
        case .network: "La richiesta non è stata completata. Verifica lo stato prima di riprovare."
        }
    }
}
