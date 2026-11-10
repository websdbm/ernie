import CoreLocation
import MapKit
import SwiftUI

struct HabitsView: View {
    @Bindable var store: HabitsStore
    @Environment(\.dismiss) private var dismiss
    @State private var editing: HabitPlace?
    @State private var confirmStart = false
    @State private var confirmAI = false
    @State private var confirmClear = false
    var body: some View {
        NavigationStack {
            List {
                if let error = store.error {
                    Section { Text(error).foregroundStyle(.secondary); Button("Riprova") { Task { await store.refresh() } } }
                }
                if let state = store.snapshot {
                    Section {
                        Label(store.collectingOnDevice ? "Raccolta abilitata su questo iPhone" : "Raccolta ferma su questo iPhone", systemImage: store.collectingOnDevice ? "location.fill" : "location.slash")
                        if !state.skillEnabled { Text("Attiva Abitudini dal pannello Skill per iniziare. Lo storico resta consultabile.").foregroundStyle(.secondary) }
                        else if !store.deviceEnabled {
                            Button("Attiva su questo iPhone") { confirmStart = true }
                        } else {
                            Button("Sospendi la raccolta", role: .destructive) { Task { await store.configure(collecting: false, aiAllowed: state.aiAllowed, retentionDays: state.retentionDays) } }
                        }
                        if state.skillEnabled, store.authorization != .authorizedAlways,
                           store.deviceEnabled || store.authorization == .denied || store.authorization == .restricted {
                            Text("Per le soste in background scegli Sempre nelle impostazioni di localizzazione di iOS.").foregroundStyle(.secondary)
                            Button("Apri impostazioni iOS") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
                        }
                        Picker("Conserva le visite", selection: Binding(get: { state.retentionDays }, set: { days in Task { await store.configure(collecting: state.collecting, aiAllowed: state.aiAllowed, retentionDays: days) } })) {
                            Text("7 giorni").tag(7); Text("30 giorni").tag(30); Text("90 giorni").tag(90)
                        }
                        Toggle("Contesto pertinente per l’AI", isOn: Binding(get: { state.aiAllowed }, set: { value in
                            if value { confirmAI = true } else { Task { await store.configure(collecting: state.collecting, aiAllowed: false, retentionDays: state.retentionDays) } }
                        })).disabled(!state.skillEnabled)
                        if store.pendingCount > 0 { Text("\(store.pendingCount) visite protette in attesa di invio").foregroundStyle(.secondary) }
                    } header: { Text("Privacy e raccolta") } footer: {
                        Text("iOS rileva soste approssimative: non è un tracciamento continuo. I dati sono cifrati sul dispositivo e nel tuo account. Un dispositivo offline recepisce la pausa alla prossima sincronizzazione; il permesso locale scade dopo 24 ore senza contatto con il server.")
                    }
                    if let question = store.question, let place = state.places.first(where: { $0.id == question.placeId }) {
                        Section("Un luogo da conoscere") {
                            Text(question.question)
                            Text(place.label).font(.headline)
                            Button("Descrivi questo luogo") { editing = place }
                            Button("Un’altra volta") { Task { await store.act("later", id: place.id) } }
                            Button("Non imparare questo luogo", role: .destructive) { Task { await store.act("exclude_place", id: place.id) } }
                        }
                    }
                    Section("Luoghi") {
                        if state.places.filter({ !$0.excluded }).isEmpty { Text("Le soste compariranno qui. Sarai tu a spiegarne il significato.").foregroundStyle(.secondary) }
                        ForEach(state.places.filter { !$0.excluded }) { place in
                            Button { editing = place } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(place.label).font(.headline)
                                        Text(place.confirmedAt == nil ? "Da confermare" : (place.purpose.isEmpty ? "Confermato da te" : place.purpose)).font(.subheadline).foregroundStyle(.secondary)
                                    }
                                    Spacer(); Image(systemName: "chevron.right").foregroundStyle(.secondary)
                                }.padding(.vertical, 4)
                            }.buttonStyle(.plain)
                        }
                    }
                    if !state.patterns.isEmpty {
                        Section {
                            ForEach(state.patterns) { pattern in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(state.places.first { $0.id == pattern.placeId }?.label ?? "Luogo").font(.headline)
                                    Text("\(Self.weekday(pattern.weekday)), tra le \(pattern.arrivalStart) e le \(pattern.arrivalEnd)")
                                    Text("Ipotesi basata su \(pattern.days) giorni osservati. Non è un impegno confermato.").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        } header: { Text("Possibili abitudini") } footer: { Text("Revisione al massimo una volta al giorno, senza chiamate al modello AI.") }
                    }
                    Section("Soste recenti") {
                        if state.visits.isEmpty { Text("Nessuna visita registrata").foregroundStyle(.secondary) }
                        ForEach(Array(state.visits.prefix(50))) { visit in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(state.places.first { $0.id == visit.placeId }?.label ?? "Sosta osservata").font(.headline)
                                if let arrival = HabitVisit.date(visit.arrival) { Text(arrival, format: .dateTime.day().month().hour().minute()) }
                                Text(visit.departure == nil ? "Partenza non ancora rilevata" : "Sosta conclusa").font(.caption).foregroundStyle(.secondary)
                            }.swipeActions { Button("Dimentica", role: .destructive) { Task { await store.act("forget_visit", id: visit.id) } } }
                        }
                    }
                    if state.places.contains(where: \.excluded) {
                        Section("Luoghi esclusi") { Text("\(state.places.filter(\.excluded).count) aree escluse. Le coordinate servono soltanto a ignorare nuove visite in queste aree.").foregroundStyle(.secondary) }
                    }
                    Section { Button("Elimina tutti i dati di Abitudini", role: .destructive) { confirmClear = true } }
                } else if store.error == nil { ProgressView("Caricamento…") }
            }
            .disabled(store.busy)
            .navigationTitle("Abitudini")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Fine") { dismiss() } } }
            .task { await store.refresh() }
            .refreshable { await store.refresh() }
            .sheet(item: $editing) { place in HabitPlaceEditor(place: place, store: store) }
            .alert("Attivare Abitudini?", isPresented: $confirmStart) {
                Button("Annulla", role: .cancel) {}
                Button("Attiva e continua") { if let s = store.snapshot { Task { await store.configure(collecting: true, aiAllowed: s.aiAllowed, retentionDays: s.retentionDays, startOnDevice: true) } } }
            } message: { Text("Ernie raccoglierà le soste anche in background e le conserverà cifrate nel tuo account. iOS ti chiederà il permesso di localizzazione. Puoi sospendere e cancellare tutto in qualsiasi momento.") }
            .alert("Condividere il contesto con l’AI?", isPresented: $confirmAI) {
                Button("Annulla", role: .cancel) {}
                Button("Consenti") { if let s = store.snapshot { Task { await store.configure(collecting: s.collecting, aiAllowed: true, retentionDays: s.retentionDays) } } }
            } message: { Text("Quando chiedi delle tue abitudini, i luoghi e le routine pertinenti potranno essere inviati al modello esterno configurato. Le risposte restano nella chat. La revoca interrompe i nuovi invii, ma non ritira quelli già avvenuti.") }
            .confirmationDialog("Eliminare lo storico, i luoghi e le abitudini?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Elimina e interrompi la raccolta", role: .destructive) { Task { await store.act("clear") } }
            }
        }
    }
    static func weekday(_ day: Int) -> String { ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"][max(0, min(day, 6))] }
}

private struct HabitPlaceEditor: View {
    @State var place: HabitPlace
    @Bindable var store: HabitsStore
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Map(initialPosition: .region(.init(center: .init(latitude: place.latitude, longitude: place.longitude), span: .init(latitudeDelta: 0.005, longitudeDelta: 0.005)))) {
                        Marker(place.label, coordinate: .init(latitude: place.latitude, longitude: place.longitude))
                    }.frame(height: 180).accessibilityLabel("Posizione approssimativa della sosta")
                    TextField("Nome del luogo", text: $place.label)
                    TextField("Che cosa fai qui?", text: $place.purpose, axis: .vertical).lineLimit(2...5)
                    Picker("Frequenza", selection: $place.frequency) { Text("Da capire").tag("unknown"); Text("Abituale").tag("habitual"); Text("Occasionale").tag("occasional") }
                } footer: { Text("Il significato che inserisci viene registrato come confermato da te. La posizione rilevata da iOS può essere approssimativa.") }
                if let error = store.error { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Descrivi il luogo")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Salva") { Task { await store.update(place); if store.error == nil { dismiss() } } }.disabled(store.busy || place.label.trimmingCharacters(in: .whitespaces).isEmpty) }
                }
        }
    }
}
