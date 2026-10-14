import SwiftUI

/// Dove porta una voce del pannello laterale: la schermata la apre (foglio) o cambia conversazione.
enum PanelDestination: Hashable {
    case newConversation
    case conversation(String)
    case reminders
    case brain
    case health
    case family
    case profile
    case skills
    case settings
    case whatsNew
}

/// Pannello laterale (bozzetto 4): scheda dell'utente, nuova conversazione, sezioni, storico delle conversazioni.
struct SidePanel: View {
    @Binding var isOpen: Bool
    let onSelect: (PanelDestination) -> Void

    @Environment(AppModel.self) private var model
    /// Conversazioni passate, ricaricate ogni volta che il pannello si apre.
    @State private var sessions: [TranscriptStore.SessionSummary] = []
    /// Skill dell'account: serve solo per sapere se «Salute» è attiva.
    @State private var skills: [SkillInfo] = []
    /// Spostamento durante il trascinamento verso sinistra (mai positivo).
    @State private var dragOffset: CGFloat = 0

    private let panelAnimation = Animation.spring(duration: 0.35, bounce: 0.15)

    var body: some View {
        GeometryReader { geo in
            let width = min(318, geo.size.width * 0.82)
            ZStack(alignment: .leading) {
                if isOpen {
                    dimLayer
                    panel(width: width)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
        }
        .animation(panelAnimation, value: isOpen)
        .allowsHitTesting(isOpen)
        .accessibilityHidden(!isOpen)
        // A ogni apertura: storico e skill attive (la riga «Salute» compare appena la skill viene accesa).
        .task(id: isOpen) {
            guard isOpen else { return }
            dragOffset = 0
            sessions = model.conversation?.pastSessions() ?? []
            skills = (try? await model.api?.skills()) ?? skills
        }
    }

    // MARK: - livelli

    /// Velo scuro sopra la chat: un tocco chiude il pannello.
    private var dimLayer: some View {
        Button {
            close()
        } label: {
            Color.black.opacity(0.38).ignoresSafeArea()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Chiudi il pannello")
        .transition(.opacity)
    }

    /// Il pannello vero e proprio: a tutta altezza, sotto la barra di stato.
    private func panel(width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            newConversationButton
            sectionRows
            Rectangle()
                .fill(Theme.hairline)
                .frame(height: 1)
            historyArea
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(panelFill.ignoresSafeArea())
        .shadow(color: .black.opacity(0.22), radius: 18, x: 6, y: 0)
        .offset(x: dragOffset)
        .simultaneousGesture(closeDrag)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { close() }
    }

    /// Un gradino più chiaro del fondo delle schermate (di sera, un gradino più chiaro del viola scuro).
    private var panelFill: Color {
        Theme.dynamic(light: 0xFBFAFE, dark: 0x191525)
    }

    // MARK: - intestazione

    private var header: some View {
        let name = model.profile?.displayName ?? ""
        return HStack(alignment: .center, spacing: 12) {
            Image("Mascot")
                .resizable()
                .scaledToFill()
                .frame(width: 48, height: 48)
                .background(Theme.accent)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.accent.opacity(0.6), lineWidth: 2))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(name.isEmpty ? "Tu" : name)
                    .font(Theme.title(18))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                Button {
                    choose(.profile)
                } label: {
                    Text("La tua scheda")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.accentText)
                }
                .buttonStyle(.plain)
            }

            Spacer(minLength: 8)

            GlassCircleButton(systemName: "gearshape", label: "Impostazioni") {
                choose(.settings)
            }
        }
    }

    private var newConversationButton: some View {
        Button {
            choose(.newConversation)
        } label: {
            Label("Nuova conversazione", systemImage: "plus")
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // MARK: - sezioni

    /// Promemoria, Second brain, (Salute se attiva), Skill, Famiglia, Novità.
    private var sectionRows: some View {
        VStack(spacing: 2) {
            sectionRow("Promemoria", icon: "bell.fill", tint: .reminders, badge: upcomingReminders, destination: .reminders)
            sectionRow("Second brain", icon: "brain.head.profile", tint: .brain, destination: .brain)
            if isHealthActive {
                sectionRow("Salute", icon: "heart.text.square.fill", tint: .health, locked: true, destination: .health)
            }
            sectionRow("Skill", icon: "bolt.shield.fill", tint: .neutral, destination: .skills)
            sectionRow("Famiglia", icon: "person.2.fill", tint: .neutral, destination: .family)
            sectionRow("Novità", icon: "sparkles", tint: .brain, destination: .whatsNew)
        }
    }

    private func sectionRow(
        _ title: String,
        icon: String,
        tint: SkillTint,
        badge: Int = 0,
        locked: Bool = false,
        destination: PanelDestination
    ) -> some View {
        var spoken = title
        if locked { spoken += ", privata" }
        if badge > 0 { spoken += ", \(badge) in programma" }

        return Button {
            choose(destination)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(tint.color)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.system(size: 15, weight: .medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if locked {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.inkSecondary)
                        .accessibilityHidden(true)
                }
                if badge > 0 {
                    Text("\(badge)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Theme.accent, in: Capsule())
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(PanelRowStyle())
        .accessibilityLabel(spoken)
    }

    /// Promemoria ancora da far scattare («scheduled» sono quelli in arrivo).
    private var upcomingReminders: Int {
        model.reminders.items.filter { $0.status == "scheduled" }.count
    }

    /// La skill «Salute» compare nel pannello solo quando è attiva.
    private var isHealthActive: Bool {
        skills.contains { $0.id == "salute" && $0.active }
    }

    // MARK: - storico

    private var historyArea: some View {
        Group {
            if sessions.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    eyebrow
                    Text("Le conversazioni passate compariranno qui.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.inkSecondary)
                        .padding(.horizontal, 12)
                    Spacer(minLength: 0)
                }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        eyebrow
                            .padding(.bottom, 4)
                        ForEach(historyGroups) { group in
                            Text(group.bucket.title)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.inkSecondary)
                                .padding(.horizontal, 12)
                                .padding(.top, 10)
                                .padding(.bottom, 2)
                            ForEach(group.sessions) { session in
                                sessionRow(session)
                            }
                        }
                    }
                    .padding(.bottom, 12)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var eyebrow: some View {
        Text("CONVERSAZIONI")
            .font(Theme.eyebrow)
            .kerning(0.4)
            .foregroundStyle(Theme.inkSecondary)
            .padding(.horizontal, 12)
    }

    /// Una conversazione passata: tocco per riaprirla; la aperta è evidenziata e non si elimina.
    private func sessionRow(_ session: TranscriptStore.SessionSummary) -> some View {
        let isCurrent = session.id == model.conversation?.sessionId
        let title = session.title.isEmpty ? "Conversazione" : session.title
        return Button {
            choose(.conversation(session.id))
        } label: {
            Text(title)
                .font(.system(size: 15))
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isCurrent ? Theme.surfaceMuted : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(PanelRowStyle())
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .contextMenu {
            if !isCurrent {
                Button("Elimina dal telefono", role: .destructive) {
                    model.conversation?.deleteSession(session.id)
                    sessions = model.conversation?.pastSessions() ?? []
                }
            }
        }
    }

    /// Le conversazioni raggruppate per quando sono state aggiornate, dalla più recente.
    private var historyGroups: [HistoryGroup] {
        let now = Date.now
        let byBucket = Dictionary(grouping: sessions) { HistoryBucket(date: $0.updatedAt, now: now) }
        return HistoryBucket.allCases.compactMap { bucket in
            guard let items = byBucket[bucket], !items.isEmpty else { return nil }
            return HistoryGroup(bucket: bucket, sessions: items.sorted { $0.updatedAt > $1.updatedAt })
        }
    }

    // MARK: - azioni

    /// Chiude il pannello (tocco sul velo, gesto, «Escape» di VoiceOver).
    private func close() {
        isOpen = false
    }

    /// Passa la scelta a chi ospita il pannello, poi lo chiude.
    private func choose(_ destination: PanelDestination) {
        onSelect(destination)
        isOpen = false
    }

    /// Trascinamento orizzontale verso sinistra: oltre una soglia il pannello si chiude, altrimenti torna al suo posto.
    private var closeDrag: some Gesture {
        DragGesture(minimumDistance: 16)
            .onChanged { value in
                guard abs(value.translation.width) > abs(value.translation.height) else { return }
                dragOffset = min(0, value.translation.width)
            }
            .onEnded { value in
                let shouldClose = value.translation.width < -90 || value.predictedEndTranslation.width < -160
                if shouldClose {
                    close()
                } else {
                    withAnimation(panelAnimation) { dragOffset = 0 }
                }
            }
    }
}

// MARK: - supporto

/// Stile delle righe toccabili: evidenziazione tenue mentre il dito le preme.
private struct PanelRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(configuration.isPressed ? Theme.accentText : Theme.ink)
            .background(
                configuration.isPressed ? Theme.accentSoft : Color.clear,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Fascia temporale dello storico, nell'ordine in cui compare.
private enum HistoryBucket: CaseIterable, Hashable {
    case today, yesterday, thisWeek, earlier

    init(date: Date, now: Date) {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            self = .today
        } else if calendar.isDateInYesterday(date) {
            self = .yesterday
        } else if let week = calendar.dateInterval(of: .weekOfYear, for: now), week.contains(date) {
            self = .thisWeek
        } else {
            self = .earlier
        }
    }

    var title: String {
        switch self {
        case .today: "Oggi"
        case .yesterday: "Ieri"
        case .thisWeek: "Questa settimana"
        case .earlier: "Prima"
        }
    }
}

/// Un gruppo dello storico: fascia temporale e conversazioni già ordinate.
private struct HistoryGroup: Identifiable {
    let bucket: HistoryBucket
    let sessions: [TranscriptStore.SessionSummary]

    var id: HistoryBucket { bucket }
}
