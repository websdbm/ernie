import Foundation

/// Rules only: no UI, clock, network or global random state. Coordinates grow downwards.
struct TRIXCell: Codable, Equatable, Hashable, Sendable {
    var x: Int
    var y: Int
}

enum TRIXKind: Int, Codable, CaseIterable, Sendable {
    case i = 1, o, t, s, z, j, l

    var cells: [TRIXCell] {
        let points: [(Int, Int)]
        switch self {
        case .i: points = [(0, 1), (1, 1), (2, 1), (3, 1)]
        case .o: points = [(1, 0), (2, 0), (1, 1), (2, 1)]
        case .t: points = [(1, 0), (0, 1), (1, 1), (2, 1)]
        case .s: points = [(1, 0), (2, 0), (0, 1), (1, 1)]
        case .z: points = [(0, 0), (1, 0), (1, 1), (2, 1)]
        case .j: points = [(0, 0), (0, 1), (1, 1), (2, 1)]
        case .l: points = [(2, 0), (0, 1), (1, 1), (2, 1)]
        }
        return points.map { TRIXCell(x: $0.0, y: $0.1) }
    }
}

struct TRIXPiece: Codable, Equatable, Sendable {
    var kind: TRIXKind
    var rotation = 0
    var x = 3
    var y = -1

    var cells: [TRIXCell] {
        var points = kind.cells
        if kind != .o {
            for _ in 0..<rotation {
                let side = kind == .i ? 3 : 2
                points = points.map { TRIXCell(x: side - $0.y, y: $0.x) }
            }
        }
        return points.map { TRIXCell(x: $0.x + x, y: $0.y + y) }
    }
}

struct ErnieTRIXEngine: Codable, Equatable, Sendable {
    static let width = 10
    static let height = 20
    enum Status: String, Codable, Sendable { case paused, playing, gameOver }
    enum Command: Sendable { case left, right, rotate, down, drop }

    var board = Array(repeating: 0, count: width * height)
    var active: TRIXPiece
    var next: TRIXKind
    var bag: [TRIXKind] = []
    var randomState: UInt64
    var status: Status = .paused
    var score = 0
    var lines = 0
    var piecesPlaced = 0
    var lastClearedRows: [Int] = []
    var gravityElapsed = 0.0
    var lockElapsed = 0.0
    var lockResets = 0

    var level: Int { lines / 10 + 1 }
    var gravityInterval: Double { max(0.06, 0.8 * pow(0.8, Double(level - 1))) }
    var grounded: Bool { !fits(shifted(active, dx: 0, dy: 1)) }
    var ghost: TRIXPiece {
        var result = active
        while fits(shifted(result, dx: 0, dy: 1)) { result.y += 1 }
        return result
    }

    init(seed: UInt64 = UInt64.random(in: 1...UInt64.max)) {
        randomState = max(1, seed)
        active = TRIXPiece(kind: .t)
        next = .i
        active = TRIXPiece(kind: draw())
        next = draw()
    }

    mutating func resume() { if status == .paused { status = .playing } }
    mutating func pause() { if status == .playing { status = .paused } }

    mutating func advance(_ seconds: Double) {
        guard status == .playing, seconds.isFinite, seconds > 0 else { return }
        // Resume never catches up time spent away; a delayed render can't skip a whole board.
        let dt = min(seconds, 0.1)
        gravityElapsed += dt
        if gravityElapsed >= gravityInterval {
            gravityElapsed.formTruncatingRemainder(dividingBy: gravityInterval)
            if fits(shifted(active, dx: 0, dy: 1)) { active.y += 1 }
        }
        if grounded {
            lockElapsed += dt
            if lockElapsed >= 0.5 { lockPiece() }
        } else {
            lockElapsed = 0
        }
    }

    mutating func perform(_ command: Command) {
        guard status == .playing else { return }
        switch command {
        case .left: move(dx: -1)
        case .right: move(dx: 1)
        case .rotate: rotate()
        case .down:
            if fits(shifted(active, dx: 0, dy: 1)) {
                active.y += 1
                score += 1
                gravityElapsed = 0
            }
        case .drop:
            let target = ghost
            score += max(0, target.y - active.y) * 2
            active = target
            lockPiece()
        }
    }

    func fits(_ piece: TRIXPiece) -> Bool {
        piece.cells.allSatisfy { cell in
            cell.x >= 0 && cell.x < Self.width && cell.y >= -2 && cell.y < Self.height
                && (cell.y < 0 || board[cell.y * Self.width + cell.x] == 0)
        }
    }

    private func shifted(_ piece: TRIXPiece, dx: Int, dy: Int) -> TRIXPiece {
        var copy = piece
        copy.x += dx; copy.y += dy
        return copy
    }

    private mutating func move(dx: Int) {
        let candidate = shifted(active, dx: dx, dy: 0)
        guard fits(candidate) else { return }
        resetLockIfAllowed()
        active = candidate
    }

    private mutating func resetLockIfAllowed() {
        if grounded, lockResets < 15 {
            lockElapsed = 0
            lockResets += 1
        }
    }

    private mutating func rotate() {
        guard active.kind != .o else { return }
        var candidate = active
        candidate.rotation = (active.rotation + 1) % 4
        // Clockwise wall/floor kicks, with positive y pointing down.
        let normal = [
            [(0,0),(-1,0),(-1,-1),(0,2),(-1,2)],
            [(0,0),(1,0),(1,1),(0,-2),(1,-2)],
            [(0,0),(1,0),(1,-1),(0,2),(1,2)],
            [(0,0),(-1,0),(-1,1),(0,-2),(-1,-2)]
        ]
        let straight = [
            [(0,0),(-2,0),(1,0),(-2,1),(1,-2)],
            [(0,0),(-1,0),(2,0),(-1,-2),(2,1)],
            [(0,0),(2,0),(-1,0),(2,-1),(-1,2)],
            [(0,0),(1,0),(-2,0),(1,2),(-2,-1)]
        ]
        for (dx, dy) in (active.kind == .i ? straight : normal)[active.rotation] {
            let kicked = shifted(candidate, dx: dx, dy: dy)
            if fits(kicked) {
                resetLockIfAllowed()
                active = kicked
                return
            }
        }
    }

    private mutating func lockPiece() {
        guard active.cells.allSatisfy({ $0.y >= 0 }) else {
            status = .gameOver
            return
        }
        for cell in active.cells { board[cell.y * Self.width + cell.x] = active.kind.rawValue }
        let rows = (0..<Self.height).filter { row in
            board[(row * Self.width)..<((row + 1) * Self.width)].allSatisfy { $0 != 0 }
        }
        lastClearedRows = rows
        if !rows.isEmpty {
            let levelBefore = level
            let remaining = (0..<Self.height).filter { !rows.contains($0) }.flatMap { row in
                Array(board[(row * Self.width)..<((row + 1) * Self.width)])
            }
            board = Array(repeating: 0, count: rows.count * Self.width) + remaining
            score += [0, 100, 300, 500, 800][rows.count] * levelBefore
            lines += rows.count
        }
        piecesPlaced += 1
        gravityElapsed = 0; lockElapsed = 0; lockResets = 0
        active = TRIXPiece(kind: next)
        next = draw()
        if !fits(active) { status = .gameOver }
    }

    private mutating func random() -> UInt64 {
        randomState ^= randomState << 13
        randomState ^= randomState >> 7
        randomState ^= randomState << 17
        return randomState
    }

    private mutating func draw() -> TRIXKind {
        if bag.isEmpty {
            bag = TRIXKind.allCases
            for index in stride(from: bag.count - 1, through: 1, by: -1) {
                bag.swapAt(index, Int(random() % UInt64(index + 1)))
            }
        }
        return bag.removeLast()
    }

    /// Reject damaged/obsolete saves before any indexed access or unbounded rotation loop.
    var isValidSave: Bool {
        guard board.count == Self.width * Self.height,
              board.allSatisfy({ (0...7).contains($0) }),
              (0...3).contains(active.rotation), (-4...10).contains(active.x), (-5...19).contains(active.y),
              (0...1_000_000_000).contains(score), (0...1_000_000).contains(lines),
              (0...10_000_000).contains(piecesPlaced), (0...15).contains(lockResets),
              gravityElapsed.isFinite, (0...1).contains(gravityElapsed),
              lockElapsed.isFinite, (0...1).contains(lockElapsed),
              randomState != 0, bag.count <= 7, Set(bag.map(\.rawValue)).count == bag.count,
              lastClearedRows.count <= 4, lastClearedRows.allSatisfy({ (0..<20).contains($0) }) else { return false }
        guard (0..<Self.height).allSatisfy({ row in
            board[(row * Self.width)..<((row + 1) * Self.width)].contains(0)
        }) else { return false }
        return status == .gameOver || fits(active)
    }
}

/// Deliberately anchored: questions about the game, negations and attached documents go to Ernie normally.
enum ErnieTRIXLaunch {
    static func matches(_ text: String, hasAttachments: Bool = false) -> Bool {
        guard !hasAttachments else { return false }
        let words = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "it_IT"))
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
        let name = "(?:ernietrix|ernie trix|erni trix)"
        let command = "(?:(?:voglio|vorrei|posso|mi va di) giocare(?: a| ad)?|giochiamo(?: a| ad)?|fammi giocare(?: a| ad)?|(?:apri|avvia|lancia)(?: il gioco)?)"
        let pattern = "^(?:\(name)|(?:ehi ernie |ernie )?\(command) \(name))(?: per favore)?$"
        return words.range(of: pattern, options: .regularExpression) != nil
    }
}
