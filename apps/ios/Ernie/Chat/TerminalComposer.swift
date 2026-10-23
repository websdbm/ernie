import SwiftUI
import UIKit

/// Il cursore appartiene a UITextInput: segue selezione, dettatura e composizione IME.
/// Nessun timer aggiuntivo: lampeggio e accessibilità restano gestiti da iOS.
final class TerminalTextView: UITextView {
    override func caretRect(for position: UITextPosition) -> CGRect {
        var rect = super.caretRect(for: position)
        let width = ("M" as NSString).size(withAttributes: [.font: font ?? UIFont.monospacedSystemFont(ofSize: 17, weight: .regular)]).width
        rect.size.width = ceil(width)
        return rect
    }

    func configureFont(size: CGFloat = 17) {
        // SwiftUI fornisce la misura scalata, anche con una categoria impostata nell’ambiente.
        let desiredFont = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        if font != desiredFont { font = desiredFont }
        adjustsFontForContentSizeCategory = false
        // Spazio anche per il cursore a blocco al termine di una riga piena.
        let inset = UIEdgeInsets(top: 11, left: 0, bottom: 11, right: ceil(size))
        if textContainerInset != inset { textContainerInset = inset }
    }
}

struct TerminalComposer: UIViewRepresentable {
    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
    @Binding var text: String
    @Binding var focused: Bool
    var placeholder: String

    func makeUIView(context: Context) -> TerminalTextView {
        let view = TerminalTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textColor = UIColor(hex: 0x8DFFA8)
        view.tintColor = UIColor(hex: 0x8DFFA8).withAlphaComponent(0.65)
        view.keyboardAppearance = .dark
        view.configureFont(size: fontSize)
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityLabel = placeholder
        view.accessibilityIdentifier = "terminal-composer"
        view.isScrollEnabled = false
        return view
    }

    func updateUIView(_ view: TerminalTextView, context: Context) {
        context.coordinator.parent = self
        view.configureFont(size: fontSize)
        // Non riscrivere durante il marked text: preserva composizione e selezione.
        if view.text != text, view.markedTextRange == nil {
            let selection = view.selectedRange
            view.text = text
            let length = (text as NSString).length
            view.selectedRange = NSRange(location: min(selection.location, length), length: min(selection.length, max(0, length - selection.location)))
            view.invalidateIntrinsicContentSize()
        }
        context.coordinator.synchronizeFocus(view)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: TerminalTextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
        // Con caratteri accessibili lascia spazio alla conversazione e alla tastiera.
        let maxHeight = min(180, (uiView.font?.lineHeight ?? 21) * 6 + 22)
        let desired = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        uiView.isScrollEnabled = desired > maxHeight
        return CGSize(width: width, height: min(maxHeight, max(44, desired)))
    }

    static func dismantleUIView(_ view: TerminalTextView, coordinator: Coordinator) {
        coordinator.focusTask?.cancel()
        view.delegate = nil
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: TerminalComposer
        var focusTask: Task<Void, Never>?
        init(_ parent: TerminalComposer) { self.parent = parent }
        func synchronizeFocus(_ view: TerminalTextView) {
            focusTask?.cancel()
            guard parent.focused != view.isFirstResponder else { return }
            // Keyboard notifications and delegate callbacks must not reenter a SwiftUI update.
            focusTask = Task { @MainActor [weak self, weak view] in
                guard !Task.isCancelled, let self, let view, view.window != nil else { return }
                if self.parent.focused, !view.isFirstResponder { view.becomeFirstResponder() }
                if !self.parent.focused, view.isFirstResponder { view.resignFirstResponder() }
            }
        }
        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
        }
        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.focused { parent.focused = true }
        }
        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.focused { parent.focused = false }
        }
    }
}
