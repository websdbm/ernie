import Foundation
import Testing
import SwiftUI
import SpriteKit
@testable import Ernie

struct ErnieTRIXRulesTests {
    @Test func everyShapeHasFourDistinctCellsAndFourRotationsClose() {
        for kind in TRIXKind.allCases {
            var game = ErnieTRIXEngine(seed: 7)
            game.active = TRIXPiece(kind: kind, x: 3, y: 5)
            game.resume()
            let initial = Set(game.active.cells)
            #expect(initial.count == 4)
            for _ in 0..<4 { game.perform(.rotate); #expect(Set(game.active.cells).count == 4) }
            #expect(Set(game.active.cells) == initial)
        }
    }
    @Test func sevenBagHasNoMissingPiecesAndIsReproducible() {
        var game = ErnieTRIXEngine(seed: 42)
        var same = ErnieTRIXEngine(seed: 42)
        var pieces: [TRIXKind] = []
        for _ in 0..<28 {
            pieces.append(game.active.kind)
            game.resume(); same.resume()
            game.perform(.drop); same.perform(.drop)
            #expect(game == same)
            game.board = Array(repeating: 0, count: 200)
            same.board = game.board
        }
        for start in stride(from: 0, to: 28, by: 7) {
            #expect(Set(pieces[start..<start + 7].map(\.rawValue)).count == 7)
        }
    }
    @Test func wallsFloorAndOccupiedCellsCannotBeCrossed() {
        var game = ErnieTRIXEngine(seed: 1)
        game.active = TRIXPiece(kind: .o, x: -1, y: 17)
        game.resume()
        game.perform(.left)
        #expect(game.active.x == -1)
        game.board[18 * 10 + 2] = 3
        game.perform(.right)
        #expect(game.active.x == -1)
        game.perform(.down); game.perform(.down)
        #expect(game.active.y == 18)
        #expect(game.grounded)
    }
    @Test func straightPieceKicksAwayFromWallAndFloor() {
        var game = ErnieTRIXEngine(seed: 1)
        game.active = TRIXPiece(kind: .i, rotation: 1, x: -2, y: 4)
        game.resume(); game.perform(.rotate)
        #expect(game.active.rotation == 2)
        #expect(game.active.cells.allSatisfy { $0.x >= 0 })
        game.active = TRIXPiece(kind: .i, x: 3, y: 18)
        game.perform(.rotate)
        #expect(game.active.rotation == 1)
        #expect(game.active.cells.allSatisfy { $0.y < 20 })
    }
    @Test(arguments: [1, 2, 3, 4]) func clearsRowsAndCompactsWithoutLosingOtherCells(count: Int) {
        var game = ErnieTRIXEngine(seed: 1)
        for row in (20 - count)..<20 {
            for col in 0..<10 where col != 4 { game.board[row * 10 + col] = 2 }
        }
        game.board[10 * 10] = 7
        game.active = TRIXPiece(kind: .i, rotation: 1, x: 2, y: 16)
        game.resume(); game.perform(.drop)
        #expect(game.lines == count)
        #expect(game.score == [0, 100, 300, 500, 800][count])
        #expect(game.board[(10 + count) * 10] == 7)
        #expect(game.board.prefix(count * 10).allSatisfy { $0 == 0 })
        #expect(game.board.count == 200)
    }
    @Test func hardDropLandsOnGhostAndLocksOnce() {
        var game = ErnieTRIXEngine(seed: 10)
        game.active = TRIXPiece(kind: .t, x: 3, y: 2)
        game.resume()
        let ghost = game.ghost
        let expected = ghost.cells
        let distance = ghost.y - game.active.y
        game.perform(.drop)
        #expect(game.piecesPlaced == 1)
        #expect(game.score == distance * 2)
        #expect(expected.allSatisfy { game.board[$0.y * 10 + $0.x] == TRIXKind.t.rawValue })
    }
    @Test func groundedLockHasDelayAndPauseFreezesEverything() {
        var game = ErnieTRIXEngine(seed: 1)
        game.active = TRIXPiece(kind: .o, x: 3, y: 18)
        game.resume()
        for _ in 0..<4 { game.advance(0.1) }
        #expect(game.piecesPlaced == 0)
        game.pause()
        let paused = game
        game.advance(1000); game.perform(.drop); game.perform(.rotate)
        #expect(game == paused)
        game.resume(); game.advance(0.1)
        #expect(game.piecesPlaced == 1)
    }
    @Test func groundedMovementCannotResetLockForever() {
        var game = ErnieTRIXEngine(seed: 2)
        game.active = TRIXPiece(kind: .o, x: 3, y: 18)
        game.resume()
        for i in 0..<15 { game.advance(0.05); game.perform(i.isMultiple(of: 2) ? .left : .right) }
        #expect(game.lockResets == 15)
        for i in 0..<12 { game.advance(0.05); game.perform(i.isMultiple(of: 2) ? .right : .left) }
        #expect(game.piecesPlaced == 1)
    }
    @Test func blockedSpawnAndLockAboveTopEndGameWithoutOverwritingBoard() {
        var game = ErnieTRIXEngine(seed: 1)
        game.next = .o
        game.board[1] = 5
        game.board[4] = 6
        game.active = TRIXPiece(kind: .o, x: 6, y: 18)
        game.resume(); game.perform(.drop)
        #expect(game.status == .gameOver)
        #expect(game.board[4] == 6)
        var top = ErnieTRIXEngine(seed: 1)
        top.active = TRIXPiece(kind: .o, x: 3, y: -1)
        top.board[14] = 1
        top.resume(); let before = top.board
        top.perform(.drop)
        #expect(top.status == .gameOver)
        #expect(top.board == before)
    }
    @Test func speedIncreasesAndElapsedTimeIsBounded() {
        var game = ErnieTRIXEngine(seed: 1)
        let slow = game.gravityInterval
        game.lines = 10
        #expect(game.level == 2)
        #expect(game.gravityInterval < slow)
        game.resume(); let y = game.active.y
        game.advance(300)
        #expect(game.active.y <= y + 1)
        game.advance(.nan); game.advance(.infinity)
        #expect(game.gravityElapsed.isFinite)
    }
    @Test func damagedAndUnknownSavesAreRejected() throws {
        var game = ErnieTRIXEngine(seed: 3)
        #expect(game.isValidSave)
        game.active.rotation = Int.max
        #expect(!game.isValidSave)
        #expect(TRIXSave.decode(try JSONEncoder().encode(TRIXSave(game: game, record: 0))) == nil)
        game = ErnieTRIXEngine(seed: 3); game.board.removeLast()
        #expect(!game.isValidSave)
        game = ErnieTRIXEngine(seed: 3); game.board[0] = 99
        #expect(!game.isValidSave)
        game = ErnieTRIXEngine(seed: 3)
        #expect(TRIXSave.decode(try JSONEncoder().encode(TRIXSave(version: 99, game: game, record: 0))) == nil)
        #expect(TRIXSave.decode(Data("invalid".utf8)) == nil)
    }
    @Test(arguments: ["Voglio giocare a ErnieTRIX", "Ernie, apri ErnieTRIX!", "Avvia il gioco ErnieTRIX", "Vorrei giocare a Ernie trix.", "Giochiamo a erni trix", "ErnieTRIX", "Fammi giocare a ErnieTRIX per favore"])
    func explicitLaunchesAreRecognized(text: String) { #expect(ErnieTRIXLaunch.matches(text)) }
    @Test(arguments: ["Non voglio giocare a ErnieTRIX", "Come funziona ErnieTRIX?", "Ricordami di giocare a ErnieTRIX", "Apri ErnieTRIX e cancella la lista", "Mi piace ErnieTRIX", ""])
    func mentionsAndOtherRequestsAreNotIntercepted(text: String) { #expect(!ErnieTRIXLaunch.matches(text)) }
    @Test func longSequencesKeepTheBoardAndSaveValid() {
        let commands: [ErnieTRIXEngine.Command] = [.left, .right, .rotate, .down, .drop]
        for seed in 1...16 {
            var game = ErnieTRIXEngine(seed: UInt64(seed))
            game.resume()
            for index in 0..<500 {
                game.perform(commands[(index * 7 + seed) % commands.count])
                game.advance(0.1)
                #expect(game.isValidSave)
                if game.status == .gameOver { break }
            }
        }
    }
    @Test func attachmentsAreNeverSwallowed() { #expect(!ErnieTRIXLaunch.matches("Apri ErnieTRIX", hasAttachments: true)) }
}

@MainActor struct ErnieTRIXIntegrationTests {
    @Test func saveRestoresPausedExactBoardQueueAndPersonalRecord() throws {
        let name = "trix-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let first = ErnieTRIXSession(storageID: "alice", defaults: defaults, seed: 123)
        first.resume(); first.perform(.left); first.perform(.drop); first.perform(.rotate); first.pause()
        let restored = ErnieTRIXSession(storageID: "alice", defaults: defaults)
        #expect(restored.game == first.game)
        #expect(restored.game.status == .paused)
        #expect(restored.record == first.record)
        let other = ErnieTRIXSession(storageID: "bob", defaults: defaults)
        #expect(other.game.score == 0 && other.record == 0)
        let record = restored.record
        restored.restart(); restored.pause()
        #expect(restored.record == record)
        #expect(restored.game.piecesPlaced == 0)
    }
    @Test func textAndVoiceLaunchOfflineWithoutAnOutgoingTurn() throws {
        let name = "trix-chat-test-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: name))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: directory) }
        let credentials = Credentials(serverURL: URL(string: "https://example.invalid")!, apiKey: "test-only")
        let store = ConversationStore(credentials: credentials, speaker: Speaker(), inbox: InboxStore(), settings: LocalSettings(),
                                      transcript: TranscriptStore(directory: directory, defaults: defaults), deviceContext: { nil })
        store.send("Voglio giocare a ErnieTRIX", inputMode: "text")
        let first = try #require(store.gameLaunchID)
        #expect(store.activeCorrelationId == nil)
        #expect(store.items.isEmpty)
        store.send("Giochiamo a ernie trix", inputMode: "voice")
        #expect(store.gameLaunchID != first)
        #expect(store.activeCorrelationId == nil)
        #expect(store.items.isEmpty)
        store.send("Come funziona ErnieTRIX?", inputMode: "text")
        let running = try #require(store.activeCorrelationId)
        let count = store.items.count
        store.send("Apri ErnieTRIX", inputMode: "text")
        #expect(store.activeCorrelationId == running)
        #expect(store.items.count == count)
        store.disconnect()
    }
}

@Suite(.serialized) @MainActor struct ErnieTRIXViewTests {
    @Test func furKeepsColorShadingAndTransparentCorners() throws {
        func pixels(_ image: UIImage) throws -> [UInt8] {
            var bytes = [UInt8](repeating: 0, count: 64 * 64 * 4)
            let cg = try #require(image.cgImage)
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(data: buffer.baseAddress, width: 64, height: 64, bitsPerComponent: 8,
                                        bytesPerRow: 64 * 4, space: CGColorSpaceCreateDeviceRGB(),
                                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.draw(cg, in: CGRect(x: 0, y: 0, width: 64, height: 64))
            }
            return bytes
        }
        let purple = try pixels(TRIXFur.images[TRIXKind.t.rawValue - 1])
        let gold = try pixels(TRIXFur.images[TRIXKind.o.rawValue - 1])
        let center = (32 * 64 + 32) * 4
        #expect(Int(purple[center]) > Int(purple[center + 1]) * 3 / 2)
        #expect(Int(gold[center]) > Int(gold[center + 2]) * 2)
        #expect(purple[center + 3] > 200)
        #expect(purple[3] == 0 && gold[3] == 0)
    }
    @Test func nativeLayoutControlsAndBackgroundPause() async throws {
        #expect(UIImage(named: "ErnieTRIXFur") != nil)
        let name = "trix-ui-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let windowScene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = windowScene.windows.first(where: \.isKeyWindow)
        for (width, height, costume) in [(390.0, 844.0, BearCostume.base), (320.0, 568.0, .borg)] {
            var engine = ErnieTRIXEngine(seed: 99)
            // Synthetic partial stack, deliberately no complete rows or user information.
            for row in 16..<20 {
                for col in 0..<10 where col < row - 14 || col >= 8 {
                    engine.board[row * 10 + col] = (row + col) % 7 + 1
                }
            }
            engine.active = TRIXPiece(kind: .t, x: 3, y: 5)
            defaults.set(try JSONEncoder().encode(TRIXSave(game: engine, record: 1200)), forKey: "ernie.ernietrix.v1.ui")
            let session = ErnieTRIXSession(storageID: "ui", defaults: defaults)
            session.resume()
            let host = UIHostingController(rootView: ErnieTRIXView(session: session, costume: costume))
            let window = UIWindow(windowScene: windowScene)
            window.frame = CGRect(x: 0, y: 0, width: width, height: height)
            window.rootViewController = host
            window.makeKeyAndVisible()
            defer { window.isHidden = true; previous?.makeKeyAndVisible() }
            try await Task.sleep(for: .milliseconds(200))
            host.view.layoutIfNeeded()
            let buttons = findPadButtons(host.view)
            #expect(buttons.count == 4)
            for button in buttons {
                let rect = button.convert(button.bounds, to: host.view)
                #expect(rect.width >= 44 && rect.height >= 44)
                #expect(rect.minX >= 0 && rect.maxX <= host.view.bounds.width + 1)
                #expect(rect.minY >= 0 && rect.maxY <= host.view.bounds.height + 1)
            }
            let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("ernietrix-\(Int(width))-\(costume.rawValue).png")
            try #require(image.pngData()).write(to: path)
            print("ERNIETRIX_PREVIEW \(path.path)")
            let left = try #require(buttons.first { $0.accessibilityLabel == "Sinistra" })
            let before = session.game.active.x
            left.sendActions(for: .touchDown)
            left.sendActions(for: .touchUpInside)
            #expect(session.game.active.x == before - 1)
            let down = try #require(buttons.first { $0.accessibilityLabel == "Scendi" })
            let score = session.game.score
            down.sendActions(for: .touchDown)
            for _ in 0..<30 {
                if session.game.score >= score + 3 { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            down.sendActions(for: .touchCancel)
            #expect(session.game.score >= score + 3)
            let rotation = session.game.active.rotation
            let rotate = try #require(buttons.first { $0.accessibilityLabel == "Ruota" })
            #expect(rotate.accessibilityActivate())
            #expect(session.game.active.rotation == (rotation + 1) % 4)
            down.sendActions(for: .touchDown)
            NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
            try await Task.sleep(for: .milliseconds(100))
            #expect(session.game.status == .paused)
            let paused = session.game
            try await Task.sleep(for: .milliseconds(400))
            #expect(session.game == paused)
            session.resume()
            let afterResume = session.game.score
            try await Task.sleep(for: .milliseconds(250))
            #expect(session.game.score == afterResume) // A previously held arrow must not restart.
            window.isHidden = true
        }
    }
    private func findPadButtons(_ view: UIView) -> [UIButton] {
        let own = (view as? UIButton).map { ["Sinistra", "Scendi", "Destra", "Ruota"].contains($0.accessibilityLabel ?? "") ? [$0] : [] } ?? []
        return own + view.subviews.flatMap(findPadButtons)
    }
}
