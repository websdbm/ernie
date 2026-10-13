import CoreLocation
import MapKit
import UIKit

/// Ora locale e posizione del telefono per il contesto dei turni (protocollo v1.10), solo con il permesso
/// dell'utente («Mentre usi l'app»). Posizione approssimata: precisione di circa 100 m al rilevamento, il server
/// la arrotonda a circa 1 km; il nome del luogo (città, provincia, paese) si ricava sul telefono con MapKit.
/// Niente rilevamento continuo: una lettura all'avvio, al ritorno in primo piano e quando è più vecchia di 10 minuti.
@MainActor
final class DeviceContextProvider: NSObject, CLLocationManagerDelegate {
    static let shared = DeviceContextProvider()
    static let defaultsKey = "device.location"

    /// Preferenza dell'utente (predefinita: attiva; il permesso di iOS resta comunque necessario).
    static var locationEnabled: Bool {
        get { UserDefaults.standard.object(forKey: defaultsKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }

    private struct Fix: Sendable {
        let latitude: Double
        let longitude: Double
        let accuracy: Double
        let at: Date
    }

    private let manager = CLLocationManager()
    private var fix: Fix?
    private var place: String?
    private var placeFix: Fix?
    private var lastRequest: Date?
    private static let maxAge: TimeInterval = 600

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in DeviceContextProvider.shared.refresh(force: true) }
        }
    }

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }

    private var authorized: Bool {
        manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways
    }

    /// All'avvio: chiede il permesso la prima volta (se l'opzione è attiva), altrimenti legge la posizione.
    func start() {
        guard Self.locationEnabled else { return }
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        } else {
            refresh(force: true)
        }
    }

    /// Nuova lettura se quella che c'è è vecchia (o se richiesto), al massimo una ogni 2 minuti.
    func refresh(force: Bool = false) {
        guard Self.locationEnabled, authorized else { return }
        if let fix, !force, Date().timeIntervalSince(fix.at) < Self.maxAge { return }
        if let lastRequest, Date().timeIntervalSince(lastRequest) < 120 { return }
        lastRequest = .now
        manager.requestLocation()
    }

    /// Contesto da allegare al messaggio: ora e fuso sempre, posizione solo con permesso e opzione attiva.
    func context() -> DeviceContextPayload {
        refresh()
        let iso = ISO8601DateFormatter()
        iso.timeZone = .current
        iso.formatOptions = [.withInternetDateTime]
        var location: DeviceContextPayload.Location?
        if Self.locationEnabled, authorized, let fix {
            location = .init(
                latitude: fix.latitude,
                longitude: fix.longitude,
                accuracyM: fix.accuracy >= 0 ? fix.accuracy : nil,
                place: place,
                at: iso.string(from: fix.at)
            )
        }
        return DeviceContextPayload(timezone: TimeZone.current.identifier, localTime: iso.string(from: .now), location: location)
    }

    /// Spegnendo l'opzione si dimentica subito l'ultima posizione.
    func forget() {
        fix = nil
        place = nil
        placeFix = nil
    }

    // MARK: - CLLocationManagerDelegate

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in DeviceContextProvider.shared.refresh(force: true) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last else { return }
        let fix = Fix(latitude: l.coordinate.latitude, longitude: l.coordinate.longitude, accuracy: l.horizontalAccuracy, at: l.timestamp)
        Task { @MainActor in await DeviceContextProvider.shared.update(fix) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        Log.app.info("posizione non disponibile: \(error.localizedDescription, privacy: .public)")
    }

    private func update(_ new: Fix) async {
        fix = new
        // Il nome del luogo si ricalcola solo se ci si è spostati di oltre 1 km.
        if let placeFix, place != nil,
           CLLocation(latitude: placeFix.latitude, longitude: placeFix.longitude)
            .distance(from: CLLocation(latitude: new.latitude, longitude: new.longitude)) < 1000 {
            return
        }
        guard let request = MKReverseGeocodingRequest(location: CLLocation(latitude: new.latitude, longitude: new.longitude)) else { return }
        request.preferredLocale = Locale(identifier: "it_IT")
        do {
            let items = try await request.mapItems
            if let rep = items.first?.addressRepresentations {
                place = rep.cityWithContext(.full) ?? rep.cityName
                placeFix = new
            }
        } catch {
            Log.app.info("nome del luogo non disponibile: \(error.localizedDescription, privacy: .public)")
        }
    }
}
