import Testing
@testable import Ernie

struct OrderingTests {
    @Test func dedupeRicordaGliIdFinoAllaCapacita() {
        let d = EventDeduper(capacity: 3)
        #expect(!d.isDuplicate("a"))
        #expect(d.isDuplicate("a"))
        #expect(!d.isDuplicate("b"))
        #expect(!d.isDuplicate("c"))
        #expect(!d.isDuplicate("d"))   // espelle "a"
        #expect(!d.isDuplicate("a"))
        #expect(d.count == 3)
    }

    @Test func trackerSegnalaDuplicatiEBuchi() {
        var t = SequenceTracker()
        #expect(t.check(0) == .ok)
        #expect(t.check(1) == .ok)
        #expect(t.check(1) == .duplicate(seq: 1))
        #expect(t.check(4) == .gap(expected: 2, received: 4))
        #expect(t.check(5) == .ok)
    }

    @Test func sorgenteMonotona() {
        var s = SequenceSource()
        #expect(s.next() == 0)
        #expect(s.next() == 1)
        #expect(s.peek == 2)
    }
}
