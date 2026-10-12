import SwiftUI
import UIKit

/// Lo schema a frecce disegnato come sul quaderno: catene orizzontali di frasi collegate da frecce, ramificazioni
/// a ventaglio verso destra, una sezione per paragrafo. L'impaginazione è calcolata qui (albero → posizioni) e il
/// disegno avviene su Canvas: nessun servizio esterno, nessuna immagine generata, leggibile anche in modalità scura.
struct OutlineLayout {
    struct NodeBox { let text: String; let rect: CGRect; let bold: Bool }
    struct Arrow { let from: CGPoint; let to: CGPoint }
    struct Title { let text: String; let rect: CGRect }

    private(set) var nodes: [NodeBox] = []
    private(set) var arrows: [Arrow] = []
    private(set) var titles: [Title] = []
    private(set) var size: CGSize = .zero

    static let font = UIFont.preferredFont(forTextStyle: .footnote)
    static let boldFont = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .semibold)
    static let titleFont = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .caption1).pointSize, weight: .bold)
    static let maxTextWidth: CGFloat = 150
    static let chainGap: CGFloat = 28
    static let branchGap: CGFloat = 36
    static let siblingGap: CGFloat = 8
    static let headGap: CGFloat = 16

    /// Sottoalbero misurato: dimensione del nodo, ingombro totale, posizione del nodo e dei figli nell'ingombro.
    private struct Sub {
        let text: String
        let bold: Bool
        let nodeSize: CGSize
        let size: CGSize
        let nodeOrigin: CGPoint
        let children: [(Sub, CGPoint)]
    }

    init(sections: [OutlineSection]) {
        var y: CGFloat = 0
        var maxWidth: CGFloat = 0
        for (index, section) in sections.enumerated() {
            let title = section.title.uppercased()
            let ts = Self.textSize(title, font: Self.titleFont, maxWidth: 360)
            titles.append(Title(text: title, rect: CGRect(origin: CGPoint(x: 0, y: y), size: ts)))
            maxWidth = max(maxWidth, ts.width)
            y += ts.height + 8
            for head in section.nodes {
                let sub = Self.measure(head, bold: true)
                place(sub, origin: CGPoint(x: 6, y: y))
                y += sub.size.height + Self.headGap
                maxWidth = max(maxWidth, sub.size.width + 6)
            }
            if index < sections.count - 1 { y += 10 }
        }
        size = CGSize(width: maxWidth + 12, height: max(y, 20))
    }

    static func textSize(_ s: String, font: UIFont, maxWidth: CGFloat) -> CGSize {
        let r = (s as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        return CGSize(width: ceil(r.width) + 8, height: ceil(r.height) + 4)
    }

    private static func measure(_ node: OutlineNode, bold: Bool) -> Sub {
        let ns = textSize(node.label, font: bold ? boldFont : font, maxWidth: maxTextWidth)
        let kids = node.next ?? []
        if kids.isEmpty {
            return Sub(text: node.label, bold: bold, nodeSize: ns, size: ns, nodeOrigin: .zero, children: [])
        }
        if kids.count == 1, let only = kids.first {
            // Catena: il seguito sta a destra, centri allineati sulla stessa riga.
            let child = measure(only, bold: false)
            let x = ns.width + chainGap
            let childCenter = child.nodeOrigin.y + child.nodeSize.height / 2
            let center = max(ns.height / 2, childCenter)
            let nodeY = center - ns.height / 2
            let childY = center - childCenter
            let height = max(nodeY + ns.height, childY + child.size.height)
            return Sub(text: node.label, bold: bold, nodeSize: ns, size: CGSize(width: x + child.size.width, height: height),
                       nodeOrigin: CGPoint(x: 0, y: nodeY), children: [(child, CGPoint(x: x, y: childY))])
        }
        // Ramificazione: i figli impilati a destra, il nodo al centro della pila (frecce a ventaglio).
        let subs = kids.map { measure($0, bold: false) }
        let x = ns.width + branchGap
        var stackY: CGFloat = 0
        var maxChildWidth: CGFloat = 0
        var placed: [(Sub, CGPoint)] = []
        for s in subs {
            placed.append((s, CGPoint(x: x, y: stackY)))
            stackY += s.size.height + siblingGap
            maxChildWidth = max(maxChildWidth, s.size.width)
        }
        let stackHeight = stackY - siblingGap
        let center = max(ns.height / 2, stackHeight / 2)
        let nodeY = center - ns.height / 2
        let shift = center - stackHeight / 2
        placed = placed.map { ($0.0, CGPoint(x: $0.1.x, y: $0.1.y + shift)) }
        let height = max(nodeY + ns.height, shift + stackHeight)
        return Sub(text: node.label, bold: bold, nodeSize: ns, size: CGSize(width: x + maxChildWidth, height: height),
                   nodeOrigin: CGPoint(x: 0, y: nodeY), children: placed)
    }

    private mutating func place(_ sub: Sub, origin: CGPoint) {
        let rect = CGRect(origin: CGPoint(x: origin.x + sub.nodeOrigin.x, y: origin.y + sub.nodeOrigin.y), size: sub.nodeSize)
        nodes.append(NodeBox(text: sub.text, rect: rect, bold: sub.bold))
        for (child, offset) in sub.children {
            let childOrigin = CGPoint(x: origin.x + offset.x, y: origin.y + offset.y)
            let childRect = CGRect(origin: CGPoint(x: childOrigin.x + child.nodeOrigin.x, y: childOrigin.y + child.nodeOrigin.y), size: child.nodeSize)
            arrows.append(Arrow(from: CGPoint(x: rect.maxX + 2, y: rect.midY), to: CGPoint(x: childRect.minX - 3, y: childRect.midY)))
            place(child, origin: childOrigin)
        }
    }
}

/// Il disegno vero e proprio, alla dimensione naturale (per la scheda, dentro uno scorrimento orizzontale; per l'esportazione intero).
struct OutlineCanvas: View {
    let layout: OutlineLayout
    /// Riduzione applicata nel disegno stesso (niente scaleEffect: la dimensione di layout resta coerente).
    var scale: CGFloat = 1

    var body: some View {
        Canvas { ctx, _ in
            ctx.scaleBy(x: scale, y: scale)
            for t in layout.titles {
                ctx.draw(Text(t.text).font(.caption.weight(.bold)).foregroundColor(.accentColor), in: t.rect)
            }
            for a in layout.arrows {
                var path = Path()
                path.move(to: a.from)
                path.addLine(to: a.to)
                // Punta aperta, come a mano: due tratti a 28° dalla direzione della freccia.
                let angle = atan2(a.to.y - a.from.y, a.to.x - a.from.x)
                for side in [-1.0, 1.0] {
                    let theta = angle + side * (.pi * 28 / 180) + .pi
                    path.move(to: a.to)
                    path.addLine(to: CGPoint(x: a.to.x + cos(theta) * 7, y: a.to.y + sin(theta) * 7))
                }
                ctx.stroke(path, with: .color(.accentColor), style: StrokeStyle(lineWidth: 1.3, lineCap: .round, lineJoin: .round))
            }
            for n in layout.nodes {
                ctx.draw(Text(n.text).font(n.bold ? .footnote.weight(.semibold) : .footnote).foregroundColor(.primary), in: n.rect)
            }
        }
        .frame(width: layout.size.width * scale, height: layout.size.height * scale)
    }
}

/// Nella scheda: si rimpicciolisce fino all'80 % per stare nello schermo; oltre, scorre in orizzontale.
struct OutlineDiagramView: View {
    let sections: [OutlineSection]

    var body: some View {
        let layout = OutlineLayout(sections: sections)
        let scale = Self.scale(for: layout)
        ScrollView(.horizontal, showsIndicators: true) {
            OutlineCanvas(layout: layout, scale: scale)
        }
        .frame(height: layout.size.height * scale + 4)
        .accessibilityLabel("Schema a frecce: \(sections.count) sezioni")
    }

    static func scale(for layout: OutlineLayout) -> CGFloat {
        let available = UIScreen.main.bounds.width - 56
        return min(1, max(0.8, available / max(layout.size.width, 1)))
    }
}
