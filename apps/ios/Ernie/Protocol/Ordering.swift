import Foundation

/// Deduplica per `id` con capacità limitata (porting di `packages/protocol/ordering.ts`).
final class EventDeduper {
    private var seen = Set<String>()
    private var order: [String] = []
    private let capacity: Int

    init(capacity: Int = 2048) {
        precondition(capacity >= 1)
        self.capacity = capacity
    }

    /// `true` se l'id era già stato visto; altrimenti lo registra.
    func isDuplicate(_ id: String) -> Bool {
        if seen.contains(id) { return true }
        seen.insert(id)
        order.append(id)
        if order.count > capacity {
            let oldest = order.removeFirst()
            seen.remove(oldest)
        }
        return false
    }

    var count: Int { seen.count }
}

enum SequenceVerdict: Equatable, Sendable {
    case ok
    case duplicate(seq: Int)
    case gap(expected: Int, received: Int)
}

/// Controllo di sequenza: segnala duplicati e buchi; dopo un buco si riallinea.
struct SequenceTracker: Sendable {
    private(set) var expected: Int

    init(start: Int = 0) { expected = start }

    mutating func check(_ seq: Int) -> SequenceVerdict {
        if seq < expected { return .duplicate(seq: seq) }
        if seq > expected {
            let verdict = SequenceVerdict.gap(expected: expected, received: seq)
            expected = seq + 1
            return verdict
        }
        expected = seq + 1
        return .ok
    }
}

/// Generatore monotono dei `seq` in uscita.
struct SequenceSource: Sendable {
    private var current: Int

    init(start: Int = 0) { current = start }

    mutating func next() -> Int {
        defer { current += 1 }
        return current
    }

    var peek: Int { current }
}
