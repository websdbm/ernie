import SpriteKit
import UIKit

/// One bundled fur sprite, tinted once into seven cached pixel textures; no downloads or filters per frame.
@MainActor enum TRIXFur {
    static let colors: [UIColor] = [
        UIColor(red: 0.32, green: 0.73, blue: 1, alpha: 1),
        UIColor(red: 1, green: 0.76, blue: 0.22, alpha: 1),
        UIColor(red: 0.72, green: 0.38, blue: 1, alpha: 1),
        UIColor(red: 0.20, green: 0.86, blue: 0.66, alpha: 1),
        UIColor(red: 1, green: 0.36, blue: 0.51, alpha: 1),
        UIColor(red: 0.38, green: 0.47, blue: 1, alpha: 1),
        UIColor(red: 1, green: 0.51, blue: 0.22, alpha: 1)
    ]
    static let images: [UIImage] = colors.map { color in
        let source = UIImage(named: "ErnieTRIXFur")
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1; format.opaque = false
        let bounds = CGRect(x: 0, y: 0, width: 64, height: 64)
        return UIGraphicsImageRenderer(size: bounds.size, format: format).image { renderer in
            let context = renderer.cgContext
            context.interpolationQuality = .none
            if let source {
                source.draw(in: bounds)
                context.setBlendMode(.multiply)
                context.setFillColor(color.cgColor)
                context.fill(bounds)
                source.draw(in: bounds, blendMode: .destinationIn, alpha: 1)
            } else {
                // A readable fallback even if an asset is missing from a development build.
                context.setFillColor(color.cgColor)
                context.fill(bounds.insetBy(dx: 2, dy: 2))
            }
        }
    }
    static let textures: [SKTexture] = images.map {
        let texture = SKTexture(image: $0)
        texture.filteringMode = .nearest
        return texture
    }
}

@MainActor final class ErnieTRIXScene: SKScene {
    private let session: ErnieTRIXSession
    private var lastTime: TimeInterval?
    private var drawnRevision = -1
    private var observedCelebration = 0
    private let blocks = SKNode()
    private let effects = SKNode()
    var reduceMotion = false

    init(session: ErnieTRIXSession, accent: UIColor) {
        self.session = session
        super.init(size: CGSize(width: 300, height: 600))
        scaleMode = .aspectFit
        backgroundColor = UIColor(red: 0.035, green: 0.025, blue: 0.065, alpha: 1)
        let grid = CGMutablePath()
        for column in 0...10 {
            grid.move(to: CGPoint(x: column * 30, y: 0)); grid.addLine(to: CGPoint(x: column * 30, y: 600))
        }
        for row in 0...20 {
            grid.move(to: CGPoint(x: 0, y: row * 30)); grid.addLine(to: CGPoint(x: 300, y: row * 30))
        }
        let lines = SKShapeNode(path: grid)
        lines.strokeColor = accent.withAlphaComponent(0.17)
        lines.lineWidth = 0.7
        addChild(lines); addChild(blocks); addChild(effects)
        render()
    }
    required init?(coder: NSCoder) { nil }

    func resetClock() { lastTime = nil }

    override func update(_ currentTime: TimeInterval) {
        if let lastTime { session.tick(currentTime - lastTime) }
        lastTime = currentTime
        guard drawnRevision != session.revision else { return }
        drawnRevision = session.revision
        render()
    }
    override func didFinishUpdate() {
        if session.game.status != .playing {
            resetClock()
            view?.isPaused = true
        }
    }
    private func render() {
        blocks.removeAllChildren()
        let game = session.game
        for (index, value) in game.board.enumerated() where value > 0 {
            tile(kind: value, cell: TRIXCell(x: index % 10, y: index / 10))
        }
        if game.status != .gameOver {
            for cell in game.ghost.cells where cell.y >= 0 {
                let outline = SKShapeNode(rectOf: CGSize(width: 26, height: 26), cornerRadius: 2)
                outline.position = point(cell)
                outline.strokeColor = TRIXFur.colors[game.active.kind.rawValue - 1].withAlphaComponent(0.65)
                outline.fillColor = .clear; outline.lineWidth = 1.5
                blocks.addChild(outline)
            }
            for cell in game.active.cells where cell.y >= 0 { tile(kind: game.active.kind.rawValue, cell: cell) }
        }
        if session.celebration != observedCelebration {
            observedCelebration = session.celebration
            guard !reduceMotion else { return }
            for row in game.lastClearedRows {
                let flash = SKSpriteNode(color: .white.withAlphaComponent(0.6), size: CGSize(width: 300, height: 28))
                flash.position = CGPoint(x: 150, y: 585 - row * 30)
                effects.addChild(flash)
                flash.run(.sequence([.fadeOut(withDuration: 0.25), .removeFromParent()]))
            }
        }
    }
    private func point(_ cell: TRIXCell) -> CGPoint { CGPoint(x: cell.x * 30 + 15, y: 585 - cell.y * 30) }
    private func tile(kind: Int, cell: TRIXCell) {
        let tile = SKSpriteNode(texture: TRIXFur.textures[kind - 1], size: CGSize(width: 30, height: 30))
        tile.position = point(cell)
        blocks.addChild(tile)
    }
}
