import AudioToolbox
import SwiftUI
import UserNotifications

/// Messaggi urgenti ricevuti e non ancora confermati («super snooze», richiesta dell'utente, 15 ott 2026: solo da un
/// genitore a un figlio). L'app li mostra a tutto schermo finché chi li riceve non conferma di averli letti; il server
/// intanto ripete la notifica. Restano salvati sul telefono anche se la conversazione cambia.
@MainActor
@Observable
final class FamilyUrgentStore {
    private(set) var pending: [FamilyMessageBlock] = []
    private static let key = "family.urgent.pending"

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.key),
           let list = try? JSONDecoder().decode([FamilyMessageBlock].self, from: data) {
            pending = list
        }
    }

    /// Il primo da confermare: è quello a tutto schermo.
    var current: FamilyMessageBlock? { pending.first }

    /// Ogni messaggio che arriva (chat, sincronizzazione, conferma da un altro telefono) passa di qui.
    func note(_ m: FamilyMessageBlock) {
        guard m.incoming, m.isUrgent else { return }
        if m.acknowledgedAt != nil {
            remove(m.id)
            return
        }
        if let i = pending.firstIndex(where: { $0.id == m.id }) {
            pending[i] = m
        } else {
            pending.append(m)
        }
        save()
    }

    /// Uscita dall'account: nessun urgente del vecchio account resta a tutto schermo.
    func clearAll() {
        pending = []
        save()
    }

    /// Dal pulsante del fumetto: lo porta davanti.
    func show(_ m: FamilyMessageBlock) {
        guard m.awaitingAck, m.incoming else { return }
        pending.removeAll { $0.id == m.id }
        pending.insert(m, at: 0)
        save()
    }

    func acknowledge(_ m: FamilyMessageBlock, api: ApiClient?, conversation: ConversationStore?) async throws {
        guard let api else { throw ApiError(status: 0, code: "offline", message: "Non sei collegato al server") }
        let updated = try await api.acknowledgeFamilyMessage(id: m.id)
        remove(m.id)
        conversation?.addFamily(updated)
    }

    private func remove(_ id: String) {
        pending.removeAll { $0.id == id }
        save()
        Self.clearDelivered(id)
    }

    private func save() {
        if let data = try? JSONEncoder().encode(pending) { UserDefaults.standard.set(data, forKey: Self.key) }
    }

    /// Toglie dal Centro notifiche le ripetizioni di quel messaggio.
    private static func clearDelivered(_ id: String) {
        let center = UNUserNotificationCenter.current()
        Task {
            let ids = await center.deliveredNotifications()
                .filter { (($0.request.content.userInfo["ernie"] as? [String: Any])?["id"] as? String) == id }
                .map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }
}

/// Messaggio urgente a tutto schermo: rosso, vibrazione continua, niente modo di chiuderlo se non confermando.
/// Per dimostrare di averlo letto si aspetta il tempo di leggerlo e poi si tiene premuto «Ho letto».
struct UrgentMessageCover: View {
    let message: FamilyMessageBlock
    @Environment(AppModel.self) private var model
    @State private var remaining: Int
    @State private var progress: CGFloat = 0
    @State private var sending = false
    @State private var error: String?
    @State private var image: UIImage?
    @State private var pulse = false

    private static let hold: Double = 1.5

    init(message: FamilyMessageBlock) {
        self.message = message
        // Circa tre parole al secondo, fra 3 e 12 secondi.
        let words = message.text.split(whereSeparator: \.isWhitespace).count
        _remaining = State(initialValue: min(12, max(3, words / 3)))
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.86, green: 0.12, blue: 0.12), Color(red: 0.96, green: 0.42, blue: 0.10)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                header
                messageCard
                Spacer(minLength: 0)
                confirmArea
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .interactiveDismissDisabled()
        .task(id: message.id) { await vibrate() }
        .task(id: message.id) { await countdown() }
        .task(id: message.id) {
            if message.image != nil { image = await FamilyImageCache.image(id: message.id, api: model.api) }
        }
        .onAppear { pulse = true }
    }

    private var header: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(.white.opacity(0.18))
                    .frame(width: 120, height: 120)
                    .scaleEffect(pulse ? 1.15 : 0.85)
                    .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: pulse)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 56, weight: .bold))
                    .foregroundStyle(.white)
                    .symbolEffect(.bounce, options: .repeating, value: pulse)
            }
            Text("MESSAGGIO URGENTE")
                .font(.title2.weight(.heavy))
                .tracking(2)
            Text("da \(message.label) · \(FamilyMessageBubble.time(message.at))")
                .font(.headline)
                .opacity(0.9)
        }
        .foregroundStyle(.white)
        .accessibilityElement(children: .combine)
    }

    /// Alto quanto il testo; scorre solo se è più lungo dello spazio.
    private var messageCard: some View {
        ViewThatFits(in: .vertical) {
            cardContent
            ScrollView { cardContent }.scrollBounceBehavior(.basedOnSize)
        }
        .frame(maxHeight: 420)
        .background(.white, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: .black.opacity(0.25), radius: 16, y: 8)
    }

    private var cardContent: some View {
            VStack(alignment: .leading, spacing: 12) {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Color(red: 0.2, green: 0.05, blue: 0.05))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
    }

    @ViewBuilder
    private var confirmArea: some View {
        VStack(spacing: 10) {
            if remaining > 0 {
                Text("Leggi il messaggio… \(remaining)")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .contentTransition(.numericText(countsDown: true))
                    .frame(height: 64)
            } else {
                holdButton
            }
            if let error {
                Text(error)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
            }
            Text("Il telefono continua a suonare finché non confermi.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.85))
        }
    }

    private var holdButton: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(.white.opacity(0.25))
            GeometryReader { geo in
                Capsule().fill(.white).frame(width: max(64, geo.size.width * progress))
            }
            Label(sending ? "Invio la conferma…" : "Tieni premuto: ho letto", systemImage: "hand.tap.fill")
                .font(.headline)
                .foregroundStyle(progress > 0.5 ? Color(red: 0.75, green: 0.1, blue: 0.1) : .white)
                .frame(maxWidth: .infinity)
        }
        .frame(height: 64)
        .contentShape(Capsule())
        .onLongPressGesture(minimumDuration: Self.hold, maximumDistance: 40) {
            Task { await confirm() }
        } onPressingChanged: { pressing in
            guard !sending else { return }
            if pressing {
                withAnimation(.linear(duration: Self.hold)) { progress = 1 }
            } else {
                withAnimation(.easeOut(duration: 0.2)) { progress = 0 }
            }
        }
        .disabled(sending)
        .accessibilityLabel("Ho letto il messaggio")
        .accessibilityHint("Tieni premuto per confermare a \(message.label) di averlo letto")
        .accessibilityAction(named: "Conferma di averlo letto") { Task { await confirm() } }
    }

    private func confirm() async {
        guard !sending else { return }
        sending = true
        progress = 1
        do {
            try await model.urgent.acknowledge(message, api: model.api, conversation: model.conversation)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            self.error = "Non riesco a mandare la conferma: controlla la connessione e riprova."
            sending = false
            withAnimation { progress = 0 }
        }
    }

    private func countdown() async {
        while remaining > 0 {
            try? await Task.sleep(for: .seconds(1))
            if Task.isCancelled { return }
            withAnimation { remaining -= 1 }
        }
    }

    /// Vibrazione continua finché il messaggio è a schermo e non è confermato.
    private func vibrate() async {
        while !Task.isCancelled {
            if !sending { AudioServicesPlayAlertSound(SystemSoundID(kSystemSoundID_Vibrate)) }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}
