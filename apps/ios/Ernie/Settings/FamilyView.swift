import SwiftUI

/// Famiglia: persone collegate (come le chiamo e cosa sono per me), inviti con codice, accettazione.
/// Il collegamento richiede il consenso dell'altra persona: inserisce il codice sul proprio telefono.
struct FamilyView: View {
    @Environment(AppModel.self) private var model
    @State private var links: [FamilyLink] = []
    @State private var invites: [FamilyInvite] = []
    @State private var error: String?
    @State private var loading = true
    @State private var showInvite = false
    @State private var showAccept = false

    var body: some View {
        List {
            Section {
                if links.isEmpty, !loading {
                    Text("Nessuna persona collegata").foregroundStyle(.secondary)
                }
                ForEach(links) { l in
                    HStack(spacing: 12) {
                        Image(systemName: FamilyRelation.symbol(for: l.relation))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(l.label).font(.body)
                            Text(FamilyRelation.title(for: l.relation)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .onDelete { offsets in Task { await unlink(offsets) } }
            } header: {
                Text("Persone collegate")
            } footer: {
                Text("Di' «ricorda a \(links.first?.label ?? "Giorgio") di …»: il promemoria arriva sul suo telefono. Ognuno vede solo i propri dati; scorri a sinistra per scollegare.")
            }
            if !invites.isEmpty {
                Section("Inviti in attesa") {
                    ForEach(invites) { i in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(i.code).font(.title3.monospaced().weight(.bold))
                                Spacer()
                                ShareLink(item: Self.shareText(i)) { Image(systemName: "square.and.arrow.up") }
                            }
                            Text("\(i.label) · \(FamilyRelation.title(for: i.relation)) · scade \(Self.expiry(i.expiresAt))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .onDelete { offsets in Task { await removeInvites(offsets) } }
                }
            }
            Section {
                Button { showInvite = true } label: { Label("Invita un familiare", systemImage: "person.badge.plus") }
                Button { showAccept = true } label: { Label("Ho un codice d'invito", systemImage: "key.horizontal") }
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
        }
        .navigationTitle("Famiglia")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showInvite) {
            FamilyInviteSheet { invite in invites.append(invite) }
        }
        .sheet(isPresented: $showAccept) {
            FamilyAcceptSheet { Task { await load() } }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            let o = try await api.family()
            links = o.links
            invites = o.invites
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
        loading = false
    }

    private func unlink(_ offsets: IndexSet) async {
        guard let api = model.api else { return }
        for i in offsets {
            do {
                try await api.unlinkFamily(otherUserId: links[i].otherUserId)
                error = nil
            } catch {
                self.error = AppModel.describe(error)
            }
        }
        await load()
    }

    private func removeInvites(_ offsets: IndexSet) async {
        guard let api = model.api else { return }
        for i in offsets { try? await api.deleteFamilyInvite(code: invites[i].code) }
        await load()
    }

    static func shareText(_ i: FamilyInvite) -> String {
        "Codice Ernie: \(i.code)\nIn Ernie apri Impostazioni → Famiglia → «Ho un codice d'invito» e inseriscilo entro 48 ore."
    }

    static func expiry(_ iso: String) -> String {
        guard let d = ReminderStore.date(iso) else { return iso }
        return d.formatted(date: .abbreviated, time: .shortened)
    }
}

/// Crea un invito: chi è l'altro per me, come lo chiamo, come propongo di farmi chiamare → codice da condividere.
struct FamilyInviteSheet: View {
    var onCreated: (FamilyInvite) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var relation: FamilyRelation = .figlio
    @State private var label = ""
    @State private var myLabel = ""
    @State private var created: FamilyInvite?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let created {
                    Section {
                        VStack(spacing: 10) {
                            Text(created.code).font(.system(size: 40, weight: .bold, design: .monospaced)).tracking(4)
                            Text("Chi riceve il codice lo inserisce in Impostazioni → Famiglia → «Ho un codice d'invito», entro 48 ore.")
                                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            ShareLink(item: FamilyView.shareText(created)) { Label("Condividi il codice", systemImage: "square.and.arrow.up") }
                                .buttonStyle(.borderedProminent)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                } else {
                    Section("Chi è per te") {
                        Picker("Parentela", selection: $relation) {
                            ForEach(FamilyRelation.allCases) { r in Text(r.title).tag(r) }
                        }
                        .pickerStyle(.segmented)
                    }
                    Section {
                        TextField("Come lo chiami (es. Giorgio)", text: $label)
                        TextField("Come ti chiamerà (es. papà)", text: $myLabel)
                    } footer: {
                        Text("Sono i nomi che userete parlando con Ernie: «ricorda a Giorgio…», «da papà».")
                    }
                    if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
                }
            }
            .navigationTitle("Invita un familiare")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(created == nil ? "Annulla" : "Fine") { dismiss() } }
                if created == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Crea codice") { Task { await create() } }
                            .disabled(busy || label.trimmingCharacters(in: .whitespaces).isEmpty || myLabel.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .task { if myLabel.isEmpty { myLabel = model.profile?.displayName ?? "" } }
        }
    }

    private func create() async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            let invite = try await api.createFamilyInvite(
                label: label.trimmingCharacters(in: .whitespaces),
                relation: relation.rawValue,
                myLabel: myLabel.trimmingCharacters(in: .whitespaces)
            )
            created = invite
            onCreated(invite)
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

/// Accetta un codice ricevuto: il collegamento nasce qui, sul telefono di chi lo accetta.
struct FamilyAcceptSheet: View {
    var onAccepted: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var label = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Codice (6 caratteri)", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    TextField("Come vuoi chiamare chi ti ha invitato (facoltativo)", text: $label)
                } footer: {
                    Text("Accettando, quella persona potrà metterti dei promemoria («ricorda a … di …»): arrivano come notifiche su questo telefono. Puoi scollegarti quando vuoi.")
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Codice d'invito")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Collega") { Task { await accept() } }
                        .disabled(busy || code.trimmingCharacters(in: .whitespaces).count < 4)
                }
            }
        }
    }

    private func accept() async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            let clean = label.trimmingCharacters(in: .whitespaces)
            _ = try await api.acceptFamilyInvite(code: code.trimmingCharacters(in: .whitespaces).uppercased(), label: clean.isEmpty ? nil : clean)
            onAccepted()
            dismiss()
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}
