import PhotosUI
import SwiftUI
import UIKit

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

    func sendFamilyMessage(to: String, text: String, image: (data: Data, width: Int, height: Int)?, replyTo: String?) async throws -> FamilyMessageBlock {
        struct Img: Encodable { var mime: String; var data: String; var width: Int; var height: Int }
        struct Body: Encodable { var to: String; var text: String; var replyTo: String?; var image: Img? }
        struct Out: Decodable { var message: FamilyMessageBlock }
        let body = Body(
            to: to,
            text: text,
            replyTo: replyTo,
            image: image.map { Img(mime: "image/jpeg", data: $0.data.base64EncodedString(), width: $0.width, height: $0.height) }
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
    private static var memory: [String: UIImage] = [:]

    private static func fileURL(_ id: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("family-media", isDirectory: true)
            .appendingPathComponent("\(id).jpg")
    }

    static func image(id: String, api: ApiClient?) async -> UIImage? {
        if let m = memory[id] { return m }
        if let url = fileURL(id), let data = try? Data(contentsOf: url), let img = UIImage(data: data) {
            memory[id] = img
            return img
        }
        guard let api, let data = try? await api.familyMessageImage(id: id), let img = UIImage(data: data) else { return nil }
        memory[id] = img
        if let url = fileURL(id) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
        return img
    }

    /// Foto appena mandata: subito in cache, senza riscaricarla.
    static func store(_ data: Data, id: String) {
        if let img = UIImage(data: data) { memory[id] = img }
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

// MARK: - fumetto

/// Etichetta a forma di busta con chi scrive («da papo») o a chi è andato («a Giorgio»).
struct EnvelopeTag: View {
    let text: String
    let tint: Color
    let fill: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "envelope.fill")
                .font(.caption.weight(.bold))
            Text(text)
                .font(.caption.weight(.bold))
                .lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 10)
        .padding(.top, 9)
        .padding(.bottom, 5)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous).fill(fill)
                // La patta della busta: una V sottile dagli angoli in alto.
                EnvelopeFlap()
                    .stroke(tint.opacity(0.45), style: StrokeStyle(lineWidth: 1.2, lineJoin: .round))
                RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(tint.opacity(0.45), lineWidth: 1.2)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct EnvelopeFlap: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + 3, y: rect.minY + 2))
        p.addLine(to: CGPoint(x: rect.midX, y: rect.minY + min(8, rect.height * 0.32)))
        p.addLine(to: CGPoint(x: rect.maxX - 3, y: rect.minY + 2))
        return p
    }
}

/// Messaggio in famiglia nella chat: fumetto color sabbia (ricevuto, a sinistra) o verde acqua (mandato, a destra),
/// diverso da quelli dell'utente e di Ernie; etichetta a busta, foto, ora e «Rispondi».
struct FamilyMessageBubble: View {
    let message: FamilyMessageBlock
    @Environment(AppModel.self) private var model
    @State private var image: UIImage?
    @State private var showImage = false
    @State private var replying = false

    private var tint: SkillTint { message.incoming ? .shopping : .sentinels }

    var body: some View {
        HStack {
            if !message.incoming { Spacer(minLength: 40) }
            VStack(alignment: message.incoming ? .leading : .trailing, spacing: 8) {
                EnvelopeTag(
                    text: message.incoming ? "da \(message.label)" : "a \(message.label)",
                    tint: tint.color,
                    fill: tint.soft
                )
                VStack(alignment: .leading, spacing: 8) {
                    if message.image != nil { photo }
                    if !message.text.isEmpty {
                        Text(message.text)
                            .foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: 10) {
                        Text(Self.time(message.at))
                            .font(.caption2)
                            .foregroundStyle(Theme.inkSecondary)
                        if message.incoming {
                            Spacer(minLength: 8)
                            Button { replying = true } label: {
                                Label("Rispondi", systemImage: "arrowshape.turn.up.left.fill")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(tint.color)
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Scrivi a \(message.label)")
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(tint.soft, in: UnevenRoundedRectangle(
                    topLeadingRadius: message.incoming ? 6 : 20,
                    bottomLeadingRadius: 20,
                    bottomTrailingRadius: 20,
                    topTrailingRadius: message.incoming ? 20 : 6,
                    style: .continuous
                ))
                .overlay(
                    UnevenRoundedRectangle(
                        topLeadingRadius: message.incoming ? 6 : 20,
                        bottomLeadingRadius: 20,
                        bottomTrailingRadius: 20,
                        topTrailingRadius: message.incoming ? 20 : 6,
                        style: .continuous
                    )
                    .strokeBorder(tint.color.opacity(0.3), lineWidth: 1)
                )
            }
            if message.incoming { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .contain)
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

    @ViewBuilder
    private var photo: some View {
        let ratio: CGFloat = {
            if let w = message.image?.width, let h = message.image?.height, w > 0, h > 0 { return CGFloat(w) / CGFloat(h) }
            return 4.0 / 3.0
        }()
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    Theme.surfaceMuted
                    ProgressView()
                }
            }
        }
        .frame(width: ratio >= 1 ? 230 : 230 * ratio, height: ratio >= 1 ? 230 / ratio : 230)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { if image != nil { showImage = true } }
        .accessibilityLabel("Foto")
        .accessibilityAddTraits(.isButton)
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
    @FocusState private var focused: Bool

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
        if let preset { to = preset; focused = true; return }
        guard let api = model.api, let family = try? await api.family() else { return }
        recipients = family.links.map { Recipient(userId: $0.otherUserId, label: $0.label) }
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
                replyTo: replyTo
            )
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

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onFinish: (UIImage?) -> Void
        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onFinish(info[.originalImage] as? UIImage)
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
        for m in list { conversation.addFamily(m) }
        let ids = Array(pendingRead)
        if !ids.isEmpty, (try? await api.markFamilyMessagesRead(ids: ids)) != nil { pendingRead.subtract(ids) }
    }
}
