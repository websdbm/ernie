import CoreLocation

/// Permesso di posizione per i promemoria legati a un luogo: basta «mentre usi l'app» (le notifiche all'arrivo
/// le consegna il sistema anche ad app chiusa). Si chiede una volta, al primo promemoria che ne ha bisogno.
@MainActor
enum PlacePermission {
    private static let manager = CLLocationManager()

    static func requestIfNeeded() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
    }
}
