import Foundation

/// Latenza di un turno vocale per stadio (A.14): dal rilascio del pulsante alla prima parola pronunciata.
struct LatencyTrace: Sendable, Equatable, Codable {
    enum Stage: String, CaseIterable, Sendable, Codable {
        case pttReleased, transcriptFinal, messageSent, firstToken, textCompleted, firstSpeech, speechEnded
    }

    private(set) var marks: [Stage: Date] = [:]
    let startedAt: Date

    init(startedAt: Date = .now) { self.startedAt = startedAt }

    mutating func mark(_ stage: Stage, at date: Date = .now) {
        if marks[stage] == nil { marks[stage] = date }
    }

    func seconds(from a: Stage, to b: Stage) -> Double? {
        guard let x = marks[a], let y = marks[b] else { return nil }
        return y.timeIntervalSince(x)
    }

    /// Latenza udibile: rilascio del pulsante → prima parola sintetizzata (obiettivo p50 < 1,5 s).
    var audibleLatency: Double? { seconds(from: .pttReleased, to: .firstSpeech) }
    var sttFinalization: Double? { seconds(from: .pttReleased, to: .transcriptFinal) }
    var timeToFirstToken: Double? { seconds(from: .messageSent, to: .firstToken) }

    static func percentile(_ values: [Double], _ p: Double) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let rank = Int((Double(sorted.count - 1) * p).rounded())
        return sorted[min(max(rank, 0), sorted.count - 1)]
    }
}
