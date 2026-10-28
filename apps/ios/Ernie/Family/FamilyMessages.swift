import PhotosUI
import SwiftUI
import UIKit
import UserNotifications
import WidgetKit

// MARK: - API (REST /v1/family/messages, server ≥ 0033)

extension ApiClient {
    /// Messaggi miei (inviati e ricevuti) dopo `since`, dal più vecchio.
    func familyMessages(since: String?, limit: Int = 50) async throws -> [FamilyMessageBlock] {
        struct Out: Decodable { var messages: [FamilyMessageBlock] }
        var path = "/v1/family/messages?limit=\(limit)"
        if let since, let enc = since.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) {
            path += "&since=\(enc)"
        }
        let out: Out = try await request("GET", path)
        return out.messages
    }

    func sendFamilyMessage(
        to: String, text: String, image: (data: Data, width: Int, height: Int)?, replyTo: String?, urgent: Bool = false
    ) async throws -> FamilyMessageBlock {
        struct Img: Encodable { var mime: String; var data: String; var width: Int; var height: Int }
        struct Body: Encodable { var to: String; var text: String; var replyTo: String?; var image: Img?; var urgent: Bool? }
        struct Out: Decodable { var message: FamilyMessageBlock }
        let body = Body(
            to: to,
            text: text,
            replyTo: replyTo,
            image: image.map { Img(mime: "image/jpeg", data: $0.data.base64EncodedString(), width: $0.width, height: $0.height) },
            urgent: urgent ? true : nil
        )
        let out: Out = try await request("POST", "/v1/family/messages", body: body)
        return out.message
    }

    func familyMessageImage(id: String) async throws -> Data {
        guard let url = URL(string: "/v1/family/messages/\(id)/image", relativeTo: credentials.serverURL) else {
            throw ApiError(status: 0, code: "bad_url", message: "URL non valido")
        }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(credentials.apiKey)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: req)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ApiError(status: (response as? HTTPURLResponse)?.statusCode ?? 0, code: "image", message: "foto non disponibile")
        }
        return data
    }

    /// Conferma di lettura di un messaggio urgente (v1.17): il telefono smette di suonare, chi l'ha mandato lo sa.
    func acknowledgeFamilyMessage(id: String) async throws -> FamilyMessageBlock {
        struct Empty: Encodable {}
        struct Out: Decodable { var message: FamilyMessageBlock }
        let out: Out = try await request("POST", "/v1/family/messages/\(id)/ack", body: Empty())
        return out.message
    }

    func markFamilyMessagesRead(ids: [String]) async throws {
        struct Body: Encodable { var ids: [String] }
        struct Out: Decodable { var updated: Int }
        let _: Out = try await request("POST", "/v1/family/messages/read", body: Body(ids: ids))
    }
}

private extension CharacterSet {
    static let urlQueryValueAllowed: CharacterSet = {
        var s = CharacterSet.urlQueryAllowed
        s.remove(charactersIn: "+&=")
        return s
    }()
}

// MARK: - foto (cache su disco: non cambiano mai)

@MainActor
enum FamilyImageCache {
    private static var generation = UUID()
    static func clear() {
        generation = UUID()
        memory.removeAllObjects()
        if let folder = fileURL("cache")?.deletingLastPathComponent() { try? FileManager.default.removeItem(at: folder) }
    }
    /// In memoria al più una trentina di foto decodificate (circa 10 MB l'una): il resto si rilegge dal disco.
    private static let memory: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 30
        return c
    }()

    private static func fileURL(_ id: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("family-media", isDirectory: true)
            .appendingPathComponent("\(id).jpg")
    }

    static func image(id: String, api: ApiClient?) async -> UIImage? {
        let token = generation
        if let m = memory.object(forKey: id as NSString) { return m }
        if let url = fileURL(id), let data = try? Data(contentsOf: url), let img = UIImage(data: data) {
            memory.setObject(img, forKey: id as NSString)
            return img
        }
        guard let api, let data = try? await api.familyMessageImage(id: id), let img = UIImage(data: data) else { return nil }
        guard token == generation, !Task.isCancelled else { return nil }
        memory.setObject(img, forKey: id as NSString)
        if let url = fileURL(id) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
        return img
    }

    /// Foto appena mandata: subito in cache, senza riscaricarla.
    static func store(_ data: Data, id: String) {
        if let img = UIImage(data: data) { memory.setObject(img, forKey: id as NSString) }
        if let url = fileURL(id) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Ridotta sul telefono (lato lungo 1600 px, JPEG): pochi centinaia di kB.
    static func prepare(_ image: UIImage) -> (data: Data, width: Int, height: Int)? {
        let maxSide: CGFloat = 1600
        let size = image.size
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let data = resized.jpegData(compressionQuality: 0.75) else { return nil }
        return (data, Int(target.width), Int(target.height))
    }
}

// MARK: - scheda messaggio

/// Il destinatario, il contenuto e l'esito restano nella stessa superficie, anche con testo grande.
/// Lo stato descrive la conferma ricevuta dal server, non presume la consegna o l'audio sul telefono.
enum FamilyMessageReceipt: Equatable {
    case sent, received, awaitingConfirmation, needsConfirmation, confirmed(String)

    init(_ message: FamilyMessageBlock) {
        if message.isUrgent, let at = message.acknowledgedAt { self = .confirmed(at) }
        else if message.awaitingAck { self = message.incoming ? .needsConfirmation : .awaitingConfirmation }
        else { self = message.incoming ? .received : .sent }
    }
}

struct FamilyMessageBubble: View {
    let message: FamilyMessageBlock
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?
    @State private var showImage = false
    @State private var replying = false

    var body: some View {
        HStack(spacing: 0) {
            if !message.incoming, !message.isUrgent { Spacer(minLength: 20) }
            FamilyMessageCard(message: message, image: image,
                              onPhoto: { if image != nil { showImage = true } },
                              onReply: { replying = true },
                              onConfirm: { model.urgent.show(message) })
            if message.incoming, !message.isUrgent { Spacer(minLength: 20) }
        }
        .task(id: message.id) {
            if message.image != nil, image == nil { image = await FamilyImageCache.image(id: message.id, api: model.api) }
        }
        .sheet(isPresented: $replying) {
            FamilyComposerSheet(preset: .init(userId: message.otherUserId, label: message.label), replyTo: message.id)
        }
        .fullScreenCover(isPresented: $showImage) {
            FamilyImageViewer(image: image) { showImage = false }
        }
    }

    static func time(_ iso: String) -> String {
        guard let d = ReminderStore.date(iso) else { return "" }
        let it = Locale(identifier: "it_IT")
        let t = d.formatted(.dateTime.hour().minute().locale(it))
        if Calendar.current.isDateInToday(d) { return t }
        if Calendar.current.isDateInYesterday(d) { return "ieri \(t)" }
        return "\(d.formatted(.dateTime.day().month(.abbreviated).locale(it))) \(t)"
    }
}

/// Vista senza dipendenze di rete, condivisa fra chat, blocchi e anteprime.
struct FamilyMessageCard: View {
    let message: FamilyMessageBlock
    var image: UIImage?
    var onPhoto: () -> Void = {}
    var onReply: () -> Void = {}
    var onConfirm: () -> Void = {}
    @Environment(\.chatPalette) private var palette
    @Environment(\.dynamicTypeSize) private var typeSize

    private var receipt: FamilyMessageReceipt { FamilyMessageReceipt(message) }
    private var urgentColor: Color { Theme.dynamic(light: 0xB42318, dark: 0xFFAAA2) }
    private var confirmationColor: Color { palette.terminal ? palette.positive : SkillTint.recipes.color }
    private var confirmed: Bool { if case .confirmed = receipt { true } else { false } }
    private func font(_ style: Font.TextStyle, _ weight: Font.Weight = .regular) -> Font {
        .system(style, design: palette.terminal ? .monospaced : .default).weight(weight)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            if message.image != nil { photo }
            if !message.text.isEmpty {
                Text(message.text)
                    .font(font(.body))
                    .foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            footer
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(palette.hairline, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: message.incoming ? "arrow.down.left" : "paperplane.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(palette.accentText)
                .frame(width: 34, height: 34)
                .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 10))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(message.incoming ? "Da \(message.label)" : "A \(message.label)")
                    .font(font(.subheadline, .semibold))
                    .foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { metadata }
                    VStack(alignment: .leading, spacing: 4) { metadata }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var metadata: some View {
        if message.isUrgent {
            Label("Urgente", systemImage: "exclamationmark.circle.fill")
                .font(font(.caption, .semibold))
                .foregroundStyle(confirmed ? palette.inkSecondary : urgentColor)
                .fixedSize()
        }
        Text(FamilyMessageBubble.time(message.at))
            .font(font(.caption))
            .foregroundStyle(palette.inkSecondary)
            .fixedSize()
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(palette.hairline).frame(height: 1).accessibilityHidden(true)
            switch receipt {
            case .awaitingConfirmation:
                status("In attesa di conferma", icon: "clock", color: palette.inkSecondary)
            case .needsConfirmation:
                status("Conferma di lettura richiesta", icon: "bell.badge", color: urgentColor)
            case .confirmed(let at):
                status(message.incoming ? "Hai confermato · \(FamilyMessageBubble.time(at))" : "Letto e confermato · \(FamilyMessageBubble.time(at))",
                       icon: "checkmark.circle.fill", color: confirmationColor)
            case .sent:
                status("Inviato", icon: "checkmark", color: palette.inkSecondary)
            case .received:
                EmptyView()
            }
            if message.incoming {
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) { actions }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 10) { actions }
                        VStack(alignment: .leading, spacing: 8) { actions }
                    }
                }
            }
        }
    }

    private func status(_ text: String, icon: String, color: Color) -> some View {
        Label { Text(text).fixedSize(horizontal: false, vertical: true) }
            icon: { Image(systemName: icon).accessibilityHidden(true) }
            .font(font(.footnote))
            .foregroundStyle(color)
            .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var actions: some View {
        if message.awaitingAck {
            Button(action: onConfirm) {
                Label("Apri e conferma", systemImage: "hand.tap")
                    .font(font(.subheadline, .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12).frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(palette.bubbleText)
            .background(palette.accent, in: RoundedRectangle(cornerRadius: 12))
        }
        Button(action: onReply) {
            Label("Rispondi", systemImage: "arrowshape.turn.up.left")
                .font(font(.subheadline, .semibold))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(palette.accentText)
        .background(palette.accentSoft, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityHint("Scrivi a \(message.label)")
    }

    private var photo: some View {
        Button(action: onPhoto) {
            Group {
                if let image { Image(uiImage: image).resizable().scaledToFit() }
                else {
                    ZStack { palette.surfaceMuted; ProgressView() }
                        .aspectRatio(photoRatio, contentMode: .fit)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: 240)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(image == nil)
        .accessibilityLabel("Apri la foto del messaggio")
    }

    private var photoRatio: CGFloat {
        guard let width = message.image?.width, let height = message.image?.height, width > 0, height > 0 else { return 4 / 3 }
        return CGFloat(width) / CGFloat(height)
    }
}

/// Foto a schermo intero, con condivisione.
struct FamilyImageViewer: View {
    let image: UIImage?
    var onClose: () -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Chiudi", action: onClose) }
                if let image {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: Image(uiImage: image), preview: SharePreview("Foto", image: Image(uiImage: image)))
                    }
                }
            }
        }
    }
}

// MARK: - composizione

/// Nuovo messaggio a un familiare (o risposta): destinatario, testo, foto dalla libreria o dalla fotocamera.
struct FamilyComposerSheet: View {
    struct Recipient: Hashable, Identifiable {
        var userId: String
        var label: String
        /// Cosa è per me («figlio», «genitore»…): gli urgenti solo ai figli.
        var relation: String? = nil
        var id: String { userId }
    }

    var preset: Recipient?
    var replyTo: String?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var recipients: [Recipient] = []
    @State private var to: Recipient?
    @State private var text = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var picked: UIImage?
    @State private var showCamera = false
    @State private var sending = false
    @State private var error: String?
    @State private var urgent = false
    /// Parentela del destinatario scelto (anche per le risposte, dal collegamento).
    @State private var relations: [String: String] = [:]
    @FocusState private var focused: Bool

    init(preset: Recipient? = nil, replyTo: String? = nil, initialText: String = "") {
        self.preset = preset
        self.replyTo = replyTo
        _text = State(initialValue: initialText)
    }

    /// «Super snooze» solo da un genitore a un figlio (richiesta dell'utente, 15 ott 2026).
    private var canUrgent: Bool { to.map { relations[$0.userId] == "figlio" } ?? false }

    private var canSend: Bool {
        to != nil && !sending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || picked != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let preset {
                        LabeledContent("A", value: preset.label)
                    } else if recipients.isEmpty {
                        Text("Nessuna persona collegata: collegala da Impostazioni › Famiglia.")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        Picker("A", selection: $to) {
                            Text("Scegli…").tag(Recipient?.none)
                            ForEach(recipients) { r in Text(r.label).tag(Recipient?.some(r)) }
                        }
                    }
                }
                Section {
                    TextField("Messaggio", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                        .focused($focused)
                    if let picked {
                        HStack(alignment: .top) {
                            Image(uiImage: picked)
                                .resizable().scaledToFill()
                                .frame(width: 120, height: 120)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            Spacer()
                            Button("Togli", role: .destructive) { self.picked = nil; photoItem = nil }
                                .buttonStyle(.borderless)
                        }
                    }
                    HStack(spacing: 18) {
                        PhotosPicker(selection: $photoItem, matching: .images) {
                            Label("Foto", systemImage: "photo.on.rectangle")
                        }
                        if UIImagePickerController.isSourceTypeAvailable(.camera) {
                            Button { showCamera = true } label: { Label("Scatta", systemImage: "camera") }
                        }
                    }
                    .buttonStyle(.borderless)
                } footer: {
                    Text("Arriva nella sua chat di Ernie con una notifica, e può risponderti.")
                }
                if canUrgent {
                    Section {
                        Toggle(isOn: $urgent) {
                            Label {
                                Text("Urgente (super snooze)")
                            } icon: {
                                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                            }
                        }
                        .tint(.red)
                    } footer: {
                        Text("Il suo telefono continua a suonare e vibrare finché non apre il messaggio e conferma di averlo letto. Ti avviso quando lo fa.")
                    }
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle(replyTo == nil ? "Messaggio" : "Rispondi")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "Invio…" : "Invia") { Task { await send() } }
                        .disabled(!canSend)
                }
            }
            .task { await load() }
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) { picked = img }
                }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { img in
                    showCamera = false
                    if let img { picked = img }
                }
                .ignoresSafeArea()
            }
        }
    }

    private func load() async {
        if let preset { to = preset; focused = true }
        guard let api = model.api, let family = try? await api.family() else { return }
        relations = Dictionary(family.links.map { ($0.otherUserId, $0.relation) }, uniquingKeysWith: { a, _ in a })
        guard preset == nil else { return }
        recipients = family.links.map { Recipient(userId: $0.otherUserId, label: $0.label, relation: $0.relation) }
        if recipients.count == 1 { to = recipients.first }
        focused = true
    }

    private func send() async {
        guard let api = model.api, let to else { return }
        sending = true
        defer { sending = false }
        let prepared = picked.flatMap(FamilyImageCache.prepare)
        do {
            let sent = try await api.sendFamilyMessage(
                to: to.userId,
                text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                image: prepared,
                replyTo: replyTo,
                urgent: urgent && canUrgent
            )
            guard model.credentials == api.credentials, !Task.isCancelled else { return }
            if let prepared { FamilyImageCache.store(prepared.data, id: sent.id) }
            model.conversation?.addFamily(sent)
            dismiss()
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

/// Fotocamera di sistema per una foto da mandare.
struct CameraPicker: UIViewControllerRepresentable {
    var onFinish: (UIImage?) -> Void
    var onCapture: ((MediaImportPhoto) -> Void)? = nil

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish, onCapture: onCapture) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void
        let onCapture: ((MediaImportPhoto) -> Void)?
        init(onFinish: @escaping (UIImage?) -> Void, onCapture: ((MediaImportPhoto) -> Void)?) { self.onFinish = onFinish; self.onCapture = onCapture }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard let onCapture, let image = info[.originalImage] as? UIImage else {
                onFinish(info[.originalImage] as? UIImage); return
            }
            let properties = info[.mediaMetadata] as? [String: Any] ?? [:]
            let capturedAt = MediaLocation.cameraDate(properties: properties)
            let location = MediaLocation.read(properties: properties) ?? DeviceContextProvider.shared.photoLocation(capturedAt: capturedAt)
            onCapture(MediaImportPhoto(image: image, location: location))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onFinish(nil) }
    }
}

// MARK: - sincronizzazione

/// Messaggi arrivati mentre l'app era chiusa: all'avvio, al ritorno in primo piano e all'arrivo di una notifica si
/// chiedono al server quelli successivi all'ultimo visto e si aggiungono alla conversazione.
@MainActor
enum FamilyMessageSync {
    private static let key = "family.messages.lastSeen"
    /// Ricevuti già mostrati, da segnare come letti sul server.
    static var pendingRead: Set<String> = []

    static var lastSeen: String? { UserDefaults.standard.string(forKey: key) }

    static func noteSeen(_ m: FamilyMessageBlock) {
        if let last = lastSeen, let a = ReminderStore.date(last), let b = ReminderStore.date(m.at), b <= a { return }
        UserDefaults.standard.set(m.at, forKey: key)
    }

    static func sync(api: ApiClient?, conversation: ConversationStore?) async {
        guard let api, let conversation else { return }
        // Prima volta su questo telefono: gli ultimi messaggi, per non partire da una chat vuota.
        let since = lastSeen
        guard let list = try? await api.familyMessages(since: since, limit: since == nil ? 20 : 100) else { return }
        guard conversation.isAttached, !Task.isCancelled else { return }
        for m in list { conversation.addFamily(m) }
        let ids = Array(pendingRead)
        if !ids.isEmpty, (try? await api.markFamilyMessagesRead(ids: ids)) != nil, conversation.isAttached { pendingRead.subtract(ids) }
    }
}

// MARK: - widget «Messaggi» e permessi delle notifiche

extension FamilyLatest {
    init?(block m: FamilyMessageBlock) {
        guard let at = FamilyLatest.date(m.at) else { return nil }
        self.init(id: m.id, direction: m.direction, label: m.label, text: m.text, image: m.image != nil, at: at,
                  urgent: m.awaitingAck ? true : nil)
    }

    /// Aggiorna il widget della schermata di blocco se è il messaggio più recente.
    func saveAndReload() {
        if saveIfNewer() { WidgetCenter.shared.reloadTimelines(ofKind: Self.widgetKind) }
    }
}

/// Come arrivano i messaggi sul blocco: dipende dai permessi delle notifiche, che decide la persona nelle
/// Impostazioni di iOS. In Famiglia si mostra cosa manca, con il collegamento alle impostazioni di Ernie.
struct FamilyNotificationStatus: View {
    @State private var settings: (allowed: Bool, lockScreen: Bool, timeSensitive: Bool)?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if let s = settings {
                if s.allowed && s.lockScreen {
                    Label(s.timeSensitive
                          ? "I messaggi arrivano sulla schermata di blocco, in evidenza."
                          : "I messaggi arrivano sulla schermata di blocco. Attiva «Notifiche urgenti» per tenerli in cima anche con Full immersion.",
                          systemImage: "lock.iphone")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if !s.timeSensitive { settingsButton }
                } else {
                    Label(s.allowed
                          ? "Le notifiche di Ernie non compaiono sulla schermata di blocco: i messaggi dei familiari si vedono solo aprendo l'app."
                          : "Le notifiche di Ernie sono spente: i messaggi dei familiari si vedono solo aprendo l'app.",
                          systemImage: "bell.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                    settingsButton
                }
            }
        }
        .task { await load() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await load() } } }
    }

    private var settingsButton: some View {
        Button("Apri le impostazioni delle notifiche") {
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
        }
        .font(.footnote)
    }

    private func load() async {
        let s = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
        settings = (allowed, s.lockScreenSetting == .enabled, s.timeSensitiveSetting == .enabled)
    }
}
