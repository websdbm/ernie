import MapKit
import SwiftUI

/// Scheda «Portami lì» (v1.19): anteprima della mappa con il punto d'arrivo, indirizzo e mezzo, e il percorso in
/// Google Maps dalla posizione attuale (se l'app di Google Maps c'è, il link la apre). In alternativa Apple Mappe.
struct DirectionsCard: View {
    let block: DirectionsBlock
    @Environment(\.openURL) private var openURL

    private var coordinate: CLLocationCoordinate2D? {
        guard let lat = block.lat, let lng = block.lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    private var modeLabel: (text: String, symbol: String) {
        switch block.mode {
        case "walking": ("A piedi", "figure.walk")
        case "bicycling": ("In bici", "bicycle")
        case "transit": ("Con i mezzi", "tram.fill")
        default: ("In auto", "car.fill")
        }
    }

    var body: some View {
        ErnieCard(icon: "location.north.line.fill", tint: .documents, eyebrow: "Portami lì", title: block.label.capitalizedFirst) {
            VStack(alignment: .leading, spacing: 12) {
                if let coordinate {
                    Map(initialPosition: .region(MKCoordinateRegion(center: coordinate, latitudinalMeters: 1200, longitudinalMeters: 1200)),
                        interactionModes: []) {
                        Marker(block.label.capitalizedFirst, systemImage: "mappin", coordinate: coordinate)
                            .tint(SkillTint.documents.color)
                    }
                    .frame(height: 150)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    if let address = block.address, address != block.label {
                        Label(address, systemImage: "mappin.and.ellipse")
                            .font(.subheadline)
                            .foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Label(modeLabel.text, systemImage: modeLabel.symbol)
                        .font(.caption)
                        .foregroundStyle(Theme.inkSecondary)
                }
                HStack(spacing: 10) {
                    Button {
                        if let url = URL(string: block.url) { openURL(url) }
                    } label: {
                        Label("Apri in Google Maps", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(SkillTint.documents.color)
                    Button { openInAppleMaps() } label: {
                        Image(systemName: "map")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 4)
                    }
                    .buttonStyle(.bordered)
                    .tint(SkillTint.documents.color)
                    .accessibilityLabel("Apri in Apple Mappe")
                }
            }
        }
    }

    /// Stesso percorso in Apple Mappe: con le coordinate il punto esatto, altrimenti l'indirizzo.
    private func openInAppleMaps() {
        let mode = switch block.mode {
        case "walking": MKLaunchOptionsDirectionsModeWalking
        case "transit": MKLaunchOptionsDirectionsModeTransit
        case "bicycling": MKLaunchOptionsDirectionsModeCycling
        default: MKLaunchOptionsDirectionsModeDriving
        }
        if let coordinate {
            let item = MKMapItem(location: CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude), address: nil)
            item.name = block.label.capitalizedFirst
            item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: mode])
        } else {
            var parts = URLComponents(string: "maps://")!
            parts.queryItems = [URLQueryItem(name: "daddr", value: block.address ?? block.label)]
            if let url = parts.url { openURL(url) }
        }
    }
}

private extension String {
    /// «casa» → «Casa»; i nomi già scritti con le maiuscole restano come sono.
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
