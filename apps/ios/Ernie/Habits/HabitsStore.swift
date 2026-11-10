import CoreLocation
import Foundation
import Observation
import UIKit

@MainActor @Observable final class HabitsStore: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var client: HabitsClient?
    private var queue: HabitsQueue?
    private var generation = UUID()
    private var syncing = false
    private var watching = false
    private(set) var snapshot: HabitsSnapshot?
    private(set) var question: HabitQuestion?
    private(set) var error: String?
    private(set) var pendingCount = 0
    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    private(set) var busy = false
    private(set) var lastSync: Date?
    private(set) var deviceEnabled = false
    private var requestingPermission = false
    #if DEBUG
    func testConfigure(client: HabitsClient?, queue: HabitsQueue?, snapshot: HabitsSnapshot? = nil) {
        generation = UUID(); syncing = false; busy = false; self.client = client; self.queue = queue; self.snapshot = snapshot
    }
    #endif
    init(observeLocation: Bool = true) { super.init(); if observeLocation { manager.delegate = self }; authorization = manager.authorizationStatus }

    func activate(credentials: Credentials?, userID: String?) async {
        generation = UUID(); syncing = false; busy = false; requestingPermission = false; error = nil; lastSync = nil; deviceEnabled = false
        client?.close(); client = nil; stopMonitoring(); snapshot = nil; question = nil
        guard let credentials, let scope = HabitsQueue.identity(credentials: credentials, userID: userID) else { queue?.clear(); queue = nil; pendingCount = 0; return }
        let next = HabitsQueue(scope: scope)
        if let queue, queue.scope != next.scope { queue.clear() }
        queue = next; client = HabitsClient(credentials: credentials)
        // Resume only an unexpired explicit opt-in on this account. Never request permission on launch.
        deviceEnabled = (try? next.load()) != nil
        if let payload = try? next.load(), payload.leaseUntil > .now, manager.authorizationStatus == .authorizedAlways {
            manager.startMonitoringVisits(); watching = true; pendingCount = payload.visits.count
        }
        await refresh()
    }
    func scrubPresentation() { snapshot = nil; question = nil; error = nil }
    private func stopMonitoring() { manager.stopMonitoringVisits(); watching = false }
    func stopLocally() {
        generation = UUID(); syncing = false; busy = false; requestingPermission = false
        stopMonitoring(); queue?.clear(); pendingCount = 0; question = nil; deviceEnabled = false
    }
    func deactivate() {
        stopLocally(); client?.close(); client = nil; queue = nil; scrubPresentation()
    }
    func refresh() async {
        guard let client, !syncing else { return }
        syncing = true; let token = generation
        defer { if token == generation { syncing = false } }
        do {
            let state = try await client.get(); guard token == generation else { return }
            snapshot = state; authorization = manager.authorizationStatus
            if !state.collecting || !state.skillEnabled { stopLocally(); error = nil; return }
            guard let queue, let enabledAt = HabitVisit.date(state.enabledAt) else { return }
            // No local consent file means this device has never opted in (or was explicitly paused).
            guard var payload = try queue.load() else { deviceEnabled = false; stopMonitoring(); return }
            guard payload.epoch == state.epoch else { stopLocally(); return }
            if authorization == .denied || authorization == .restricted || (payload.wasAuthorizedAlways && authorization != .authorizedAlways) { stopLocally(); return }
            payload.wasAuthorizedAlways = payload.wasAuthorizedAlways || authorization == .authorizedAlways
            payload.enabledAt = max(payload.enabledAt, enabledAt)
            deviceEnabled = true
            payload.leaseUntil = Date().addingTimeInterval(24 * 3600)
            try queue.save(payload)
            if authorization == .authorizedAlways { manager.startMonitoringVisits(); watching = true }
            else { stopMonitoring() }
            // Drain bounded batches. New arrivals added while awaiting a request remain in the file.
            for _ in 0..<20 {
                guard token == generation, let currentBatch = try queue.load(), currentBatch.epoch == payload.epoch else { return }
                let batch = Array(currentBatch.visits.prefix(50)); pendingCount = currentBatch.visits.count
                if batch.isEmpty || authorization != .authorizedAlways { break }
                try await client.upload(epoch: currentBatch.epoch, visits: batch)
                guard token == generation, var current = try queue.load(), current.epoch == payload.epoch else { return }
                current.visits.removeAll { item in batch.contains(where: { $0 == item }) }
                try queue.save(current); pendingCount = current.visits.count
            }
            lastSync = .now; error = nil
            if UIApplication.shared.applicationState == .active {
                let nudge = try await client.question(); guard token == generation else { return }
                if let nudge { question = nudge }
                let fresh = try await client.get(); guard token == generation else { return }; snapshot = fresh
            }
        } catch {
            guard token == generation else { return }
            if let failure = error as? HabitsFailure, ["habits_disabled", "habits_paused"].contains(failure.code) { stopLocally() }
            if let payload = try? queue?.load(), payload.leaseUntil <= .now { stopMonitoring() }
            self.error = "Sincronizzazione Abitudini non riuscita. Le visite protette in attesa verranno ritentate."
        }
    }
    func configure(collecting: Bool, aiAllowed: Bool, retentionDays: Int, startOnDevice: Bool = false) async {
        guard let client, let state = snapshot, !busy else { return }
        // Invalidate older reads before changing consent. A stale response must never restart collection.
        if !collecting { stopLocally() }
        generation = UUID(); syncing = false; busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let next = try await client.configure(.init(expectedRevision: state.revision, collecting: collecting, aiAllowed: aiAllowed, retentionDays: retentionDays))
            guard token == generation else { return }; snapshot = next; error = nil
            if collecting && startOnDevice, let queue, let enabledAt = HabitVisit.date(next.enabledAt) {
                try queue.begin(.init(epoch: next.epoch, enabledAt: max(enabledAt, .now), leaseUntil: Date().addingTimeInterval(24 * 3600), visits: []))
                deviceEnabled = true
                requestingPermission = true
                switch manager.authorizationStatus {
                case .notDetermined: manager.requestWhenInUseAuthorization()
                case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
                default: requestingPermission = false
                }
            }
            await refresh()
        } catch { if token == generation { self.error = error.localizedDescription; await refresh() } }
    }
    func update(_ place: HabitPlace) async {
        guard let client, !busy else { return }; busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do { let next = try await client.update(place); guard token == generation else { return }; snapshot = next; question = nil; error = nil }
        catch { if token == generation { self.error = error.localizedDescription } }
    }
    func act(_ action: String, id: String? = nil) async {
        guard let client, !busy else { return }
        if action == "clear" { stopLocally() }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let next = try await client.action(action, id: id); guard token == generation else { return }
            snapshot = next; question = nil; error = nil
            if action == "forget_visit", var pending = try queue?.load() { pending.visits.removeAll { $0.id == id }; try queue?.save(pending) }
            if action == "exclude_place", var pending = try queue?.load() {
                pending.visits = []; try queue?.save(pending); pendingCount = 0
            }
        } catch { if token == generation { self.error = error.localizedDescription } }
    }
    func dismissQuestion() { question = nil }
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            let wasAlways = self.authorization == .authorizedAlways
            self.authorization = self.manager.authorizationStatus
            if self.requestingPermission, self.authorization == .authorizedWhenInUse {
                self.requestingPermission = false; self.manager.requestAlwaysAuthorization()
            } else if self.authorization != .notDetermined { self.requestingPermission = false }
            if self.authorization == .denied || self.authorization == .restricted ||
                (wasAlways && self.authorization == .authorizedWhenInUse) {
                self.stopLocally()
            } else if self.authorization != .authorizedAlways { self.stopMonitoring() }
            await self.refresh()
        }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let arrival = visit.arrivalDate == .distantPast ? nil : visit.arrivalDate
        let departure = visit.departureDate == .distantFuture ? nil : visit.departureDate
        let latitude = visit.coordinate.latitude, longitude = visit.coordinate.longitude, accuracy = visit.horizontalAccuracy
        Task { @MainActor in self.accept(arrival: arrival, departure: departure, latitude: latitude, longitude: longitude, accuracy: accuracy) }
    }
    func accept(arrival: Date?, departure: Date?, latitude: Double, longitude: Double, accuracy: Double) {
        guard watching, authorization == .authorizedAlways, let queue, var payload = try? queue.load(), payload.leaseUntil > .now,
              accuracy >= 0, accuracy.isFinite, latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude), (-180...180).contains(longitude),
              let start = arrival ?? departure, start >= payload.enabledAt else { return }
        let iso = ISO8601DateFormatter()
        let item = HabitVisit(id: HabitsQueue.visitID(arrival: arrival, departure: departure, latitude: latitude, longitude: longitude), latitude: latitude, longitude: longitude, accuracyM: accuracy,
                              arrival: arrival.map { iso.string(from: $0) }, departure: departure.map { iso.string(from: $0) }, observedAt: iso.string(from: .now), timezone: TimeZone.current.identifier)
        if let index = payload.visits.firstIndex(where: { $0.id == item.id }) { payload.visits[index] = item } else { payload.visits.append(item) }
        do { try queue.save(payload); pendingCount = payload.visits.count }
        catch { self.error = "Non riesco a proteggere la visita sul dispositivo. La raccolta è in pausa."; stopMonitoring(); return }
        let background = HabitsBackgroundLease()
        background.start()
        Task { await refresh(); background.end() }
    }
}

@MainActor private final class HabitsBackgroundLease {
    private var id = UIBackgroundTaskIdentifier.invalid
    func start() {
        id = UIApplication.shared.beginBackgroundTask(withName: "Invio visita protetta") {
            Task { @MainActor [weak self] in self?.end() }
        }
    }
    func end() { if id != .invalid { UIApplication.shared.endBackgroundTask(id); id = .invalid } }
}
