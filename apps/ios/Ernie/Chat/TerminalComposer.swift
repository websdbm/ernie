import SwiftUI
import UIKit

/// UIKit conserva editing e selezione; un solo rettangolo segue la geometria UITextInput.
/// Il colore del cursore nativo viene nascosto solo con selezione collassata.
/// Durante selezione e IME ritorna la UI di sistema, con maniglie e marcatura visibili.
final class TerminalTextView: UITextView {
    let blockCursor = UIView()
    private let phosphor = UIColor(hex: 0x8DFFA8)
    private var lastSelection = NSRange(location: NSNotFound, length: 0)
    private var appActive = true

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        blockCursor.backgroundColor = phosphor.withAlphaComponent(0.78)
        blockCursor.isUserInteractionEnabled = false
        blockCursor.isAccessibilityElement = false
        blockCursor.isHidden = true
        addSubview(blockCursor)
        for name in [UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification,
                     UIAccessibility.reduceMotionStatusDidChangeNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(updateActivity(_:)), name: name, object: nil)
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { NotificationCenter.default.removeObserver(self) }

    override func caretRect(for position: UITextPosition) -> CGRect {
        var rect = super.caretRect(for: position)
        rect.size.width = ceil(("M" as NSString).size(withAttributes: [
            .font: font ?? UIFont.monospacedSystemFont(ofSize: 17, weight: .regular)
        ]).width)
        return rect
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        updateBlockCursor()
    }
    override func becomeFirstResponder() -> Bool {
        let result = super.becomeFirstResponder()
        updateBlockCursor()
        return result
    }
    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        updateBlockCursor()
        return result
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateBlockCursor()
    }
    @objc private func updateActivity(_ notification: Notification) {
        if notification.name == UIApplication.willResignActiveNotification { appActive = false }
        if notification.name == UIApplication.didBecomeActiveNotification { appActive = true }
        blockCursor.layer.removeAllAnimations()
        updateBlockCursor()
    }
    func updateBlockCursor() {
        let collapsed = selectedTextRange?.isEmpty == true && markedTextRange == nil
        let color: UIColor = collapsed ? .clear : phosphor
        if tintColor != color { tintColor = color }
        guard isFirstResponder, window != nil, appActive, collapsed,
              let position = selectedTextRange?.start else {
            blockCursor.isHidden = true
            blockCursor.layer.removeAllAnimations()
            return
        }
        let rect = caretRect(for: position)
        guard !rect.isNull, !rect.isInfinite, rect.height > 0 else {
            blockCursor.isHidden = true
            return
        }
        let restart = blockCursor.isHidden || lastSelection != selectedRange
        blockCursor.frame = rect
        blockCursor.isHidden = false
        bringSubviewToFront(blockCursor)
        lastSelection = selectedRange
        if restart { blockCursor.layer.removeAllAnimations() }
        // Core Animation: nessun timer o aggiornamento SwiftUI durante la digitazione.
        if !UIAccessibility.isReduceMotionEnabled, blockCursor.layer.animation(forKey: "pulse") == nil {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1
            pulse.toValue = 0.15
            pulse.duration = 0.6
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            blockCursor.layer.add(pulse, forKey: "pulse")
        }
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
        view.tintColor = .clear
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
        view.updateBlockCursor()
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
        func textViewDidChangeSelection(_ textView: UITextView) {
            (textView as? TerminalTextView)?.updateBlockCursor()
        }
        func textViewDidChange(_ textView: UITextView) {
            (textView as? TerminalTextView)?.updateBlockCursor()
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
