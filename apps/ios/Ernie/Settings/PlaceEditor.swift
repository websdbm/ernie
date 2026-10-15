import CoreLocation
import MapKit
import SwiftUI

// MARK: - modello (REST /v1/profile, campo places)

/// Luogo della scheda (casa, lavoro, palestra…): indirizzo e posizione per i promemoria «quando arrivo a …».
struct ProfilePlace: Codable, Sendable, Equatable {
    var id: String?
    var label: String
    var address: String?
    var lat: Double?
    var lng: Double?
    var radius: Double?
    var source: String?
    var at: String?
    /// Identità locale per le liste (i luoghi nuovi non hanno ancora un id del server).
    var localId = UUID().uuidString

    enum CodingKeys: String, CodingKey { case id, label, address, lat, lng, radius, source, at }
    var listId: String { id ?? localId }
    var located: Bool { lat != nil && lng != nil }
    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

/// Luogo trovato nelle note del second brain (cartella Luoghi), da aggiungere alla scheda con un tocco.
struct PlaceSuggestion: Codable, Sendable, Equatable, Identifiable {
    var label: String
    var title: String
    var address: String?
    var lat: Double?
    var lng: Double?
    var id: String { title }
}

extension ApiClient {
    func placeSuggestions() async throws -> [PlaceSuggestion] {
        struct Out: Decodable { var suggestions: [PlaceSuggestion] }
        let out: Out = try await request("GET", "/v1/profile/place-suggestions")
        return out.suggestions
    }
}

// MARK: - ricerca degli indirizzi (Mappe di Apple, sul telefono)

/// Suggerimenti mentre si scrive un indirizzo («via Roma 3, Tre…»).
@MainActor
@Observable
final class AddressCompleter: NSObject, MKLocalSearchCompleterDelegate {
    private(set) var results: [MKLocalSearchCompletion] = []
    @ObservationIgnored private let completer = MKLocalSearchCompleter()

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = [.address, .pointOfInterest]
    }

    func update(_ query: String) {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.count < 3 { results = []; return }
        completer.queryFragment = q
    }

    func clear() { results = [] }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        MainActor.assumeIsolated { self.results = Array(self.completer.results.prefix(5)) }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: any Error) {
        MainActor.assumeIsolated { self.results = [] }
    }
}

// MARK: - editor

/// Un luogo della scheda: nome, indirizzo (con suggerimenti), punto sulla mappa (si sposta toccandola) e ampiezza
/// della zona. L'arrivo si riconosce entrando nel cerchio: per una casa bastano 150 m.
struct PlaceEditor: View {
    @State var place: ProfilePlace
    let onSave: (ProfilePlace) -> Void
    let onCancel: () -> Void

    @State private var query: String
    @State private var completer = AddressCompleter()
    @State private var camera: MapCameraPosition
    @State private var busy = false
    @State private var message: String?

    private static let labels = ["casa", "lavoro", "scuola", "palestra", "università"]

    init(place: ProfilePlace, onSave: @escaping (ProfilePlace) -> Void, onCancel: @escaping () -> Void) {
        _place = State(initialValue: place)
        self.onSave = onSave
        self.onCancel = onCancel
        _query = State(initialValue: place.address ?? "")
        if let c = place.coordinate {
            _camera = State(initialValue: .region(MKCoordinateRegion(center: c, latitudinalMeters: 900, longitudinalMeters: 900)))
        } else {
            _camera = State(initialValue: .userLocation(fallback: .automatic))
        }
    }

    private var radius: Double { place.radius ?? 150 }

    var body: some View {
        Form {
            Section {
                TextField("Nome del luogo (es. casa)", text: $place.label)
                    .textInputAutocapitalization(.never)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(Self.labels, id: \.self) { l in
                            Button(l) { place.label = l }
                                .buttonStyle(.bordered).controlSize(.small)
                        }
                    }
                }
            } header: {
                Text("Nome")
            } footer: {
                Text("È il nome che userai con Ernie: «ricordami … quando arrivo \(Self.preposition(place.label))».")
            }

            Section("Indirizzo") {
                TextField("Cerca un indirizzo o un posto", text: $query)
                    .textContentType(.fullStreetAddress)
                    .onChange(of: query) { _, q in
                        if q != place.address { completer.update(q) }
                    }
                ForEach(completer.results, id: \.self) { r in
                    Button {
                        Task { await select(r) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.title).foregroundStyle(.primary)
                            if !r.subtitle.isEmpty { Text(r.subtitle).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                Button {
                    Task { await useCurrentLocation() }
                } label: {
                    Label("Usa la mia posizione attuale", systemImage: "location.fill")
                }
                .disabled(busy)
            }

            Section {
                MapReader { proxy in
                    Map(position: $camera) {
                        if let c = place.coordinate {
                            MapCircle(center: c, radius: radius)
                                .foregroundStyle(Color.accentColor.opacity(0.18))
                                .stroke(Color.accentColor, lineWidth: 1.5)
                            Marker(place.label.isEmpty ? "Luogo" : place.label.capitalized, systemImage: "mappin", coordinate: c)
                                .tint(Color.accentColor)
                        }
                        UserAnnotation()
                    }
                    .onTapGesture { point in
                        if let c = proxy.convert(point, from: .local) { setCoordinate(c) }
                    }
                }
                .frame(height: 260)
                .listRowInsets(EdgeInsets())
                VStack(alignment: .leading, spacing: 4) {
                    Text("Zona: \(Int(radius)) m").font(.subheadline)
                    Slider(value: Binding(get: { radius }, set: { place.radius = ($0 / 50).rounded() * 50 }), in: 100...500, step: 50)
                }
            } header: {
                Text("Sulla mappa")
            } footer: {
                Text(place.located
                     ? "Tocca la mappa per spostare il punto. Il promemoria scatta entrando nel cerchio (o uscendone)."
                     : "Cerca l'indirizzo o tocca la mappa nel punto giusto.")
            }

            if let message { Section { Text(message).font(.footnote).foregroundStyle(.secondary) } }
        }
        .navigationTitle(place.label.isEmpty ? "Nuovo luogo" : place.label.capitalized)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Annulla", action: onCancel) }
            ToolbarItem(placement: .confirmationAction) {
                Button("Fatto") {
                    var p = place
                    let typed = query.trimmingCharacters(in: .whitespaces)
                    if !typed.isEmpty { p.address = typed }
                    p.label = p.label.trimmingCharacters(in: .whitespaces).lowercased()
                    onSave(p)
                }
                .disabled(place.label.trimmingCharacters(in: .whitespaces).isEmpty
                          || (!place.located && query.trimmingCharacters(in: .whitespaces).isEmpty))
            }
        }
        .task {
            // Indirizzo senza posizione (detto in chat): la cerco subito.
            if !place.located, let address = place.address, !address.isEmpty,
               let c = await ReminderStore.geocode(address) {
                setCoordinate(c)
            }
        }
    }

    private func setCoordinate(_ c: CLLocationCoordinate2D) {
        place.lat = c.latitude
        place.lng = c.longitude
        withAnimation { camera = .region(MKCoordinateRegion(center: c, latitudinalMeters: 900, longitudinalMeters: 900)) }
    }

    /// Suggerimento scelto: posizione dalla ricerca di Mappe, indirizzo come lo mostra il suggerimento.
    private func select(_ r: MKLocalSearchCompletion) async {
        busy = true
        defer { busy = false }
        let address = r.subtitle.isEmpty ? r.title : "\(r.title), \(r.subtitle)"
        guard let response = try? await MKLocalSearch(request: MKLocalSearch.Request(completion: r)).start(),
              let item = response.mapItems.first else {
            message = "Non trovo la posizione di questo indirizzo: tocca la mappa nel punto giusto."
            return
        }
        place.address = address
        query = address
        completer.clear()
        setCoordinate(item.location.coordinate)
        message = nil
    }

    private func useCurrentLocation() async {
        busy = true
        defer { busy = false }
        PlacePermission.requestIfNeeded()
        let session = CLServiceSession(authorization: .whenInUse)
        defer { session.invalidate() }
        do {
            for try await update in CLLocationUpdate.liveUpdates() {
                if let loc = update.location, loc.horizontalAccuracy >= 0, loc.horizontalAccuracy < 200 {
                    setCoordinate(loc.coordinate)
                    message = "Ho messo il punto dove sei adesso."
                    return
                }
                if update.authorizationDenied || update.authorizationDeniedGlobally {
                    message = "Serve il permesso di posizione: Impostazioni › Ernie › Posizione."
                    return
                }
            }
        } catch {
            message = "Non riesco a leggere la posizione adesso."
        }
    }

    /// «a casa», «al lavoro»… per la frase d'esempio.
    static func preposition(_ label: String) -> String {
        let l = label.trimmingCharacters(in: .whitespaces).lowercased()
        switch l {
        case "": return "a casa"
        case "casa": return "a casa"
        case "lavoro": return "al lavoro"
        case "ufficio": return "in ufficio"
        case "scuola": return "a scuola"
        case "palestra": return "in palestra"
        case "università": return "all'università"
        default: return "a \(l)"
        }
    }
}
