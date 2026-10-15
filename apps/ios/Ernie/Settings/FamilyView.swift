import SwiftUI

/// Famiglia: persone collegate (come le chiamo e cosa sono per me), inviti con codice, accettazione.
/// Il collegamento richiede il consenso dell'altra persona: inserisce il codice sul proprio telefono.
struct FamilyView: View {
    @Environment(AppModel.self) private var model
    @State private var links: [FamilyLink] = []
    @State private var invites: [FamilyInvite] = []
    /// Persone seguite (figli con il controllo genitori, nonni): sezione dedicata, solo se ce n'è almeno una.
    @State private var supervised: [SupervisedChild] = []
    @State private var error: String?
    @State private var loading = true
    @State private var showInvite = false
    @State private var showAccept = false
    /// Scollegamento di una persona seguita, in attesa di conferma: smetto anche di seguirne l'account.
    @State private var pendingUnlink: IndexSet?

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
                .onDelete { offsets in
                    if let i = offsets.first, isSupervised(links[i]) {
                        pendingUnlink = offsets
                    } else {
                        Task { await unlink(offsets) }
                    }
                }
            } header: {
                Text("Persone collegate")
            } footer: {
                Text("Di' «ricorda a \(links.first?.label ?? "Giorgio") di …»: il promemoria arriva sul suo telefono. Ognuno vede solo i propri dati; scorri a sinistra per scollegare.")
            }
            if !supervised.isEmpty {
                Section {
                    ForEach(supervised) { c in
                        NavigationLink {
                            ParentalControlView(child: c) { Task { await load() } }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.label).font(.body)
                                Text("\(FamilyRelation.title(for: c.relation ?? "figlio")) · seguito dal \(ParentalFormat.day(c.since))")
                                    .font(.caption).foregroundStyle(.secondary)
                                Text("ultima consultazione: \(Self.reviewText(c.lastReviewAt))")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Account seguiti")
                } footer: {
                    Text("Per ognuno scegli le skill che può usare.")
                }
            }
            if !invites.isEmpty {
                Section("Inviti in attesa") {
                    ForEach(invites) { i in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(i.code).font(.title3.monospaced().weight(.bold))
                                Spacer()
                                ShareLink(item: Self.shareText(i)) { Image(systemName: "square.and.arrow.up") }
                                    .accessibilityLabel("Condividi il codice \(i.code)")
                            }
                            Text("\(i.label) · \(FamilyRelation.title(for: i.relation)) · scade \(Self.expiry(i.expiresAt))")
                                .font(.caption).foregroundStyle(.secondary)
                            if i.supervised == true {
                                ErnieChip(text: FamilyRelation.supervisionTitle(for: i.relation).lowercased(), systemImage: "shield.lefthalf.filled", style: .selected)
                            }
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
        .confirmationDialog(
            "Scollegare \(pendingLabel)?",
            isPresented: Binding(get: { pendingUnlink != nil }, set: { if !$0 { pendingUnlink = nil } }),
            titleVisibility: .visible
        ) {
            Button("Scollega e smetti di seguirlo", role: .destructive) {
                if let offsets = pendingUnlink { Task { await unlink(offsets) } }
                pendingUnlink = nil
            }
            Button("Annulla", role: .cancel) { pendingUnlink = nil }
        } message: {
            Text("Scollegando \(pendingLabel) smetti di seguire il suo account: non potrai più scegliere le sue skill né leggere le sue conversazioni.")
        }
    }

    /// Nome della persona in attesa di scollegamento (per il titolo della conferma).
    private var pendingLabel: String {
        guard let i = pendingUnlink?.first, links.indices.contains(i) else { return "questa persona" }
        return links[i].label
    }

    /// Vero se la persona collegata è seguita da me (controllo genitori o account seguito).
    private func isSupervised(_ link: FamilyLink) -> Bool {
        supervised.contains { $0.childId == link.otherUserId }
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
        if let kids = try? await api.supervisedChildren() { supervised = kids }
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

    /// Ultima consultazione delle conversazioni della persona seguita, o «mai».
    static func reviewText(_ iso: String?) -> String {
        guard let iso else { return "mai" }
        return ParentalFormat.when(iso)
    }
}

/// Crea un invito: chi è l'altro per me, come lo chiamo, come propongo di farmi chiamare → codice da condividere.
/// Per figlio, nonno e nonna l'account può essere seguito, con le skill scelte qui persona per persona.
struct FamilyInviteSheet: View {
    var onCreated: (FamilyInvite) -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var relation: FamilyRelation = .figlio
    @State private var label = ""
    @State private var myLabel = ""
    /// Account seguito (figlio, nonno, nonna): acceso di default, chi accetta lo vede prima di confermare.
    @State private var supervised = true
    /// Skill concedibili e proposte per parentela (nil: server senza la 0032, decide lui).
    @State private var profiles: SkillProfiles?
    /// Skill scelte per questa persona; ripartono da quelle proposte quando cambia la parentela.
    @State private var allowed: Set<String> = []
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
                            ForEach(FamilyRelation.allCases) { r in
                                Label(r.title, systemImage: r.symbol).tag(r)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                    if relation.supervisable {
                        Section {
                            Toggle(relation == .figlio ? "Con controllo genitori" : "Segui il suo account", isOn: $supervised)
                        } footer: {
                            Text("Sceglierai tu le skill che può usare e potrai leggere le sue conversazioni. Lo saprà: lo vede prima di accettare e nella sua app. Solo tu potrai smettere di seguirlo.")
                        }
                        if supervised, let profiles {
                            Section {
                                ForEach(profiles.skills) { skill in
                                    Toggle(isOn: Binding(
                                        get: { allowed.contains(skill.id) },
                                        set: { on in if on { allowed.insert(skill.id) } else { allowed.remove(skill.id) } }
                                    )) {
                                        HStack(spacing: 12) {
                                            SkillIcon(systemName: skill.icon.isEmpty ? "sparkle" : skill.icon, tint: ParentalControlView.tint(for: skill.id))
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(skill.title).font(.body)
                                                Text(skill.summary).font(.caption).foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                            } header: {
                                Text("Skill che potrà usare")
                            } footer: {
                                Text("Proposte per \(relation.title.lowercased()): cambiale come vuoi. Potrai modificarle anche dopo, da Famiglia → Account seguiti.")
                            }
                        }
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
            .task {
                if myLabel.isEmpty { myLabel = model.profile?.displayName ?? "" }
                await loadProfiles()
            }
            .onChange(of: relation) { resetAllowed() }
        }
    }

    /// Skill concedibili e proposte; su un server vecchio resta nil e la sezione non compare.
    private func loadProfiles() async {
        guard profiles == nil, let api = model.api else { return }
        profiles = try? await api.skillProfiles()
        resetAllowed()
    }

    /// Riparte dalle skill proposte per la parentela scelta.
    private func resetAllowed() {
        allowed = Set(profiles?.defaults[relation.rawValue] ?? [])
    }

    private func create() async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            let invite = try await api.createFamilyInvite(
                label: label.trimmingCharacters(in: .whitespaces),
                relation: relation.rawValue,
                myLabel: myLabel.trimmingCharacters(in: .whitespaces),
                supervised: relation.supervisable && supervised,
                // Nell'ordine del catalogo; senza profili (server vecchio) decide il server.
                allowedSkills: profiles.map { p in p.skills.map(\.id).filter(allowed.contains) }
            )
            created = invite
            onCreated(invite)
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

/// Accetta un codice ricevuto in due passi: prima si controlla chi invita (e se c'è il controllo genitori), poi si accetta.
/// Il collegamento nasce qui, sul telefono di chi lo accetta.
struct FamilyAcceptSheet: View {
    var onAccepted: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var label = ""
    /// Passo 2: anteprima del codice (chi invita, controllo genitori). Nil finché il codice non è controllato.
    @State private var preview: FamilyInvitePreview?
    /// Cosa è per me chi invita, quando non è ovvio (invito come nonno, nonna o nipote).
    @State private var inverse: FamilyRelation?
    @State private var busy = false
    @State private var error: String?

    private var cleanCode: String { code.trimmingCharacters(in: .whitespaces).uppercased() }

    var body: some View {
        NavigationStack {
            Form {
                if let preview {
                    previewContent(preview)
                } else {
                    Section {
                        TextField("Codice (6 caratteri)", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .font(.body.monospaced())
                        TextField("Come vuoi chiamare chi ti ha invitato (facoltativo)", text: $label)
                    } footer: {
                        Text("Accettando, quella persona potrà metterti dei promemoria («ricorda a … di …»): arrivano come notifiche su questo telefono. Puoi scollegarti quando vuoi.")
                    }
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(.red) } }
            }
            .navigationTitle("Codice d'invito")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if preview == nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Continua") { Task { await checkCode() } }
                            .disabled(busy || cleanCode.count < 4)
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Indietro") { preview = nil; error = nil }
                            .disabled(busy)
                    }
                }
            }
        }
    }

    /// Passo 2: chi invita, e il consenso al controllo genitori quando l'invito lo prevede.
    @ViewBuilder
    private func previewContent(_ p: FamilyInvitePreview) -> some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: FamilyRelation.symbol(for: p.relation))
                    .font(.title2)
                    .foregroundStyle(Theme.accentText)
                    .frame(width: 36)
                    .accessibilityHidden(true)
                Text("«\(p.myLabel)» ti invita come \(FamilyRelation.title(for: p.relation).lowercased())")
                    .font(.body)
            }
        }
        if let choices = FamilyRelation(rawValue: p.relation)?.inverseChoices {
            Section {
                Picker("«\(p.myLabel)» per te è", selection: Binding(
                    get: { inverse ?? choices[0] },
                    set: { inverse = $0 }
                )) {
                    ForEach(choices) { r in Text(r.title).tag(r) }
                }
                .pickerStyle(.menu)
            }
        }
        if p.supervised {
            Section {
                ErnieCard(icon: "shield.lefthalf.filled", tint: .health, eyebrow: "Consenso richiesto", title: FamilyRelation.supervisionTitle(for: p.relation)) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Accettando, «\(p.myLabel)» sceglierà quali skill puoi usare e potrà leggere le tue conversazioni con Ernie. Nella tua app vedrai sempre che l'account è seguito e quando le ha guardate. Non potrai scollegarti da solo.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.inkSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let skills = p.skills {
                            Text(skills.isEmpty
                                 ? "Per ora nessuna skill: Ernie risponderà solo a domande generali."
                                 : "Per iniziare potrai usare: \(skills.map(\.title).joined(separator: ", ")).")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Theme.ink)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .listRowBackground(Color.clear)
        }
        Section {
            Button { Task { await accept() } } label: {
                Text("Accetta").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy)
            Button("Annulla", role: .cancel) { dismiss() }
                .frame(maxWidth: .infinity)
        }
    }

    /// Passo 1 → 2: controlla il codice e ne legge l'anteprima.
    private func checkCode() async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            let p = try await api.previewFamilyInvite(code: cleanCode)
            inverse = FamilyRelation(rawValue: p.relation).flatMap { r in
                r.inverseChoices == nil ? nil : r.defaultInverse(myLabel: p.myLabel)
            }
            preview = p
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    /// Passo 2 → fine: accetta l'invito controllato.
    private func accept() async {
        guard let api = model.api else { return }
        busy = true
        defer { busy = false }
        do {
            let clean = label.trimmingCharacters(in: .whitespaces)
            _ = try await api.acceptFamilyInvite(code: cleanCode, label: clean.isEmpty ? nil : clean, relation: inverse?.rawValue)
            onAccepted()
            dismiss()
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}
