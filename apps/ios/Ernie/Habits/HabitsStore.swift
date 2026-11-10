import CoreLocation
import Foundation
import Observation
import UIKit

@MainActor protocol HabitsLocationManaging: AnyObject {
    var authorizationStatus: CLAuthorizationStatus { get }
    func startMonitoringVisits()
    func stopMonitoringVisits()
    func requestWhenInUseAuthorization()
    func requestAlwaysAuthorization()
}

extension CLLocationManager: HabitsLocationManaging {}

@MainActor @Observable final class HabitsStore: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager: any HabitsLocationManaging
    private let now: @MainActor () -> Date
    private let isActive: @MainActor () -> Bool
    private var client: HabitsClient?
    private var activeCredentials: Credentials?
    private var queue: HabitsQueue?
    private var generation = UUID()
    private var presentation = UUID()
    private var syncing = false
    private var watching = false
    private var storageFailed = false
    private var leaseTask: Task<Void, Never>?
    private var pendingQuestion: HabitQuestion?
    private(set) var snapshot: HabitsSnapshot?
    private(set) var question: HabitQuestion?
    private(set) var error: String?
    private(set) var pendingCount = 0
    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    private(set) var busy = false
    private(set) var lastSync: Date?
    private(set) var deviceEnabled = false
    var collectingOnDevice: Bool { watching }
    private var requestingPermission = false

    init(observeLocation: Bool = true, location: (any HabitsLocationManaging)? = nil,
         now: @escaping @MainActor () -> Date = { .now },
         isActive: @escaping @MainActor () -> Bool = { UIApplication.shared.applicationState == .active }) {
        manager = location ?? CLLocationManager()
        self.now = now
        self.isActive = isActive
        super.init()
        if observeLocation, let locationManager = manager as? CLLocationManager { locationManager.delegate = self }
        authorization = manager.authorizationStatus
    }

    #if DEBUG
    func testConfigure(client: HabitsClient?, queue: HabitsQueue?, snapshot: HabitsSnapshot? = nil) {
        prepare(client: client, queue: queue)
        self.snapshot = snapshot
    }
    func testActivate(client: HabitsClient?, queue: HabitsQueue?) async {
        prepare(client: client, queue: queue)
        await refresh()
    }
    #endif

    func activate(credentials: Credentials?, userID: String?) async {
        guard let credentials, let scope = HabitsQueue.identity(credentials: credentials, userID: userID) else {
            deactivate()
            return
        }
        if activeCredentials == credentials, queue?.scope == scope {
            await refresh()
            return
        }
        prepare(client: HabitsClient(credentials: credentials), queue: HabitsQueue(scope: scope))
        activeCredentials = credentials
        await refresh()
    }

    private func prepare(client: HabitsClient?, queue: HabitsQueue?) {
        activeCredentials = nil
        generation = UUID(); syncing = false; busy = false; requestingPermission = false
        stopMonitoring()
        self.client?.close()
        if let old = self.queue, old.scope != queue?.scope, !old.clear() {
            error = "La raccolta precedente è bloccata, ma non è stato possibile eliminare tutti i dati locali."
        } else { error = nil }
        self.client = client; self.queue = queue
        snapshot = nil; question = nil; pendingQuestion = nil; lastSync = nil
        deviceEnabled = false; pendingCount = 0; presentation = UUID(); storageFailed = false
        // Restore only a persisted device opt-in; never prompt on launch or resume.
        _ = checkLocalState()
    }

    func scrubPresentation() {
        presentation = UUID()
        snapshot = nil; question = isActive() ? pendingQuestion : nil; error = nil
    }

    private func stopMonitoring() {
        manager.stopMonitoringVisits(); watching = false
        leaseTask?.cancel(); leaseTask = nil
    }

    func stopLocally() {
        generation = UUID(); syncing = false; busy = false; requestingPermission = false
        stopMonitoring()
        if let queue, !queue.clear() {
            error = "La raccolta è bloccata, ma non è stato possibile eliminare tutti i dati locali. Riprova."
        }
        pendingCount = 0; question = nil; pendingQuestion = nil; deviceEnabled = false
    }

    func deactivate() {
        activeCredentials = nil
        stopLocally(); client?.close(); client = nil; queue = nil
        snapshot = nil; question = nil; pendingQuestion = nil; lastSync = nil
        presentation = UUID()
    }

    private func queueFailed(_ failure: Error) {
        storageFailed = true
        stopMonitoring(); deviceEnabled = false
        if (failure as? HabitsFailure)?.code == "habits_capacity" {
            error = "L’archivio protetto è pieno. La raccolta è in pausa; sincronizza le visite in attesa."
        } else {
            error = "Non riesco ad accedere all’archivio protetto sul dispositivo. La raccolta e l’invio sono in pausa. Riprova."
        }
    }

    private func operationFailed(_ failure: Error, token: UUID) {
        guard token == generation else { return }
        _ = checkLocalState()
        guard token == generation else { return }
        if let failure = failure as? HabitsFailure, ["habits_disabled", "habits_paused"].contains(failure.code) {
            stopLocally()
            error = failure.localizedDescription
        } else if !storageFailed { error = failure.localizedDescription }
    }

    private func loadQueue() throws -> HabitsQueue.Payload? {
        do { return try queue?.load() }
        catch { queueFailed(error); throw error }
    }

    private func saveQueue(_ payload: HabitsQueue.Payload, begin: Bool = false) throws {
        guard let queue else { throw HabitsFailure(code: "habits_paused") }
        do {
            if begin { try queue.begin(payload) } else { try queue.save(payload) }
        } catch { queueFailed(error); throw error }
    }

    private func scheduleExpiry(_ deadline: Date) {
        leaseTask?.cancel()
        let delay = max(0, deadline.timeIntervalSince(now()))
        leaseTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            _ = self.checkLocalState()
        }
    }

    // Re-read iOS authorization after every suspension; delegate delivery may still be pending.
    @discardableResult func checkLocalState() -> HabitsQueue.Payload? {
        let wasAlways = authorization == .authorizedAlways
        authorization = manager.authorizationStatus
        if wasAlways && authorization != .authorizedAlways {
            stopLocally()
            return nil
        }
        do {
            guard var payload = try loadQueue() else {
                stopMonitoring(); deviceEnabled = false; pendingCount = 0
                return nil
            }
            if authorization == .denied || authorization == .restricted ||
                (payload.wasAuthorizedAlways && authorization != .authorizedAlways) {
                stopLocally()
                return nil
            }
            pendingCount = payload.visits.count
            guard payload.leaseUntil > now(), !storageFailed else {
                stopMonitoring(); deviceEnabled = false
                if !storageFailed { error = "Raccolta in pausa: sincronizza per rinnovare il permesso locale scaduto." }
                return nil
            }
            deviceEnabled = true
            if authorization == .authorizedAlways {
                if !payload.wasAuthorizedAlways {
                    payload.wasAuthorizedAlways = true
                    try saveQueue(payload)
                }
                if !watching { manager.startMonitoringVisits(); watching = true }
                scheduleExpiry(payload.leaseUntil)
            } else { stopMonitoring() }
            return payload
        } catch { return nil } // loadQueue has already surfaced the protected-storage failure.
    }

    private func apply(_ state: HabitsSnapshot, presentation token: UUID) throws {
        if token == presentation, isActive() { snapshot = state }
        guard state.collecting, state.skillEnabled else { stopLocally(); return }
        let operation = generation
        _ = checkLocalState()
        guard operation == generation else { return }
        guard var payload = try loadQueue() else {
            stopMonitoring(); deviceEnabled = false; pendingCount = 0
            return
        }
        guard payload.epoch == state.epoch, let enabledAt = HabitVisit.date(state.enabledAt) else {
            stopLocally()
            return
        }
        payload.wasAuthorizedAlways = payload.wasAuthorizedAlways || authorization == .authorizedAlways
        payload.enabledAt = max(payload.enabledAt, enabledAt)
        payload.leaseUntil = now().addingTimeInterval(24 * 3600)
        try saveQueue(payload)
        storageFailed = false
        _ = checkLocalState()
    }

    private func showQuestion(in state: HabitsSnapshot, presentation token: UUID) {
        if let pendingQuestion,
           !state.places.contains(where: { $0.id == pendingQuestion.placeId && !$0.excluded && $0.confirmedAt == nil }) {
            self.pendingQuestion = nil
        }
        if token == presentation, isActive() { question = pendingQuestion }
    }

    func refresh() async {
        _ = checkLocalState()
        guard let client, !syncing, !busy else { return }
        syncing = true; let token = generation; let visible = presentation
        defer {
            if token == generation {
                syncing = false
                // A sheet reopened while the previous read was finishing needs its own presentation.
                if visible != presentation, isActive() {
                    Task { [weak self] in await self?.refresh() }
                }
            }
        }
        do {
            let state = try await client.get()
            guard token == generation else { return }
            if !storageFailed { error = nil }
            try apply(state, presentation: visible)
            guard token == generation else { return }
            if !storageFailed { error = nil }
            // Remove only the exact version sent; a departure received during upload stays queued.
            for _ in 0..<20 {
                guard token == generation, let currentBatch = checkLocalState(),
                      authorization == .authorizedAlways else { break }
                let batch = Array(currentBatch.visits.prefix(50))
                if batch.isEmpty { break }
                try await client.upload(epoch: currentBatch.epoch, visits: batch)
                guard token == generation, var current = checkLocalState(),
                      authorization == .authorizedAlways, current.epoch == currentBatch.epoch else { return }
                current.visits.removeAll { item in batch.contains(item) }
                try saveQueue(current); pendingCount = current.visits.count
            }
            guard token == generation else { return }
            lastSync = now()
            showQuestion(in: state, presentation: visible)
            // Reading history and answering questions does not require device location consent.
            if isActive(), state.skillEnabled, state.collecting {
                if pendingQuestion == nil {
                    let nudge = try await client.question()
                    guard token == generation else { return }
                    _ = checkLocalState()
                    guard token == generation else { return }
                    pendingQuestion = nudge
                }
                let fresh = try await client.get()
                guard token == generation else { return }
                try apply(fresh, presentation: visible)
                guard token == generation else { return }
                showQuestion(in: fresh, presentation: visible)
            }
        } catch {
            guard token == generation else { return }
            if let failure = error as? HabitsFailure, ["habits_disabled", "habits_paused"].contains(failure.code) {
                stopLocally(); self.error = failure.localizedDescription
            } else {
                _ = checkLocalState()
                if token == generation, self.error == nil {
                    self.error = "Sincronizzazione Abitudini non riuscita. Le visite ancora nell’archivio protetto verranno ritentate."
                }
            }
        }
    }

    func configure(collecting: Bool, aiAllowed: Bool, retentionDays: Int, startOnDevice: Bool = false) async {
        guard let client, let state = snapshot, !busy else { return }
        if !collecting { stopLocally() }
        generation = UUID(); syncing = false; busy = true; let token = generation; let visible = presentation
        defer { if token == generation { busy = false } }
        do {
            let next = try await client.configure(.init(expectedRevision: state.revision, collecting: collecting, aiAllowed: aiAllowed, retentionDays: retentionDays))
            guard token == generation else { return }
            _ = checkLocalState()
            guard token == generation else { return }
            error = nil
            if collecting && startOnDevice {
                guard next.collecting, next.skillEnabled, queue != nil, let enabledAt = HabitVisit.date(next.enabledAt),
                      authorization != .denied, authorization != .restricted else {
                    try apply(next, presentation: visible)
                    self.error = "Raccolta non attivata su questo iPhone. Verifica la skill e i permessi di localizzazione nelle impostazioni iOS."
                    return
                }
                let previous = try loadQueue()
                let current = now()
                let sameEpoch = previous?.epoch == next.epoch
                try saveQueue(.init(epoch: next.epoch,
                                    enabledAt: sameEpoch ? max(enabledAt, previous?.enabledAt ?? current) : max(enabledAt, current),
                                    leaseUntil: current.addingTimeInterval(24 * 3600),
                                    visits: sameEpoch ? previous?.visits ?? [] : [],
                                    wasAuthorizedAlways: authorization == .authorizedAlways), begin: true)
                storageFailed = false; deviceEnabled = true
                requestingPermission = authorization == .notDetermined
                switch authorization {
                case .notDetermined: manager.requestWhenInUseAuthorization()
                case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
                default: requestingPermission = false
                }
            }
            try apply(next, presentation: visible)
            guard token == generation else { return }
            busy = false
            await refresh()
        } catch { operationFailed(error, token: token) }
    }

    func update(_ place: HabitPlace) async {
        guard let client, !busy else { return }
        generation = UUID(); syncing = false; busy = true; let token = generation; let visible = presentation
        defer { if token == generation { busy = false } }
        do {
            let next = try await client.update(place)
            guard token == generation else { return }
            try apply(next, presentation: visible)
            guard token == generation else { return }
            question = nil; pendingQuestion = nil; error = nil
        } catch { operationFailed(error, token: token) }
    }

    func act(_ action: String, id: String? = nil) async {
        guard let client, !busy else { return }
        if action == "clear" { stopLocally() }
        generation = UUID(); syncing = false; busy = true; let token = generation; let visible = presentation
        defer { if token == generation { busy = false } }
        do {
            let next = try await client.action(action, id: id)
            guard token == generation else { return }
            try apply(next, presentation: visible)
            guard token == generation else { return }
            question = nil; pendingQuestion = nil; error = nil
            if var pending = try loadQueue() {
                if action == "forget_visit" { pending.visits.removeAll { $0.id == id } }
                if action == "exclude_place" { pending.visits = [] }
                try saveQueue(pending); pendingCount = pending.visits.count
            }
        } catch { operationFailed(error, token: token) }
    }

    func dismissQuestion() { question = nil; pendingQuestion = nil }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        _ = checkLocalState()
        if requestingPermission, authorization == .authorizedWhenInUse, deviceEnabled {
            requestingPermission = false; self.manager.requestAlwaysAuthorization()
        } else if authorization != .notDetermined { requestingPermission = false }
        let token = generation
        Task { if token == generation { await refresh() } }
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        accept(arrival: visit.arrivalDate == .distantPast ? nil : visit.arrivalDate,
               departure: visit.departureDate == .distantFuture ? nil : visit.departureDate,
               latitude: visit.coordinate.latitude, longitude: visit.coordinate.longitude, accuracy: visit.horizontalAccuracy)
    }

    func accept(arrival: Date?, departure: Date?, latitude: Double, longitude: Double, accuracy: Double) {
        guard var payload = checkLocalState(), watching, authorization == .authorizedAlways,
              accuracy >= 0, accuracy.isFinite, latitude.isFinite, longitude.isFinite,
              (-90...90).contains(latitude), (-180...180).contains(longitude),
              let start = arrival ?? departure, start >= payload.enabledAt else { return }
        if let arrival, let departure, departure < arrival { return }
        let iso = ISO8601DateFormatter()
        var item = HabitVisit(id: HabitsQueue.visitID(arrival: arrival, departure: departure, latitude: latitude, longitude: longitude),
                              latitude: latitude, longitude: longitude, accuracyM: accuracy,
                              arrival: arrival.map { iso.string(from: $0) }, departure: departure.map { iso.string(from: $0) },
                              observedAt: iso.string(from: now()), timezone: TimeZone.current.identifier)
        if let index = payload.visits.firstIndex(where: { $0.id == item.id }) {
            let previous = payload.visits[index]
            item.arrival = item.arrival ?? previous.arrival
            if let previousDeparture = HabitVisit.date(previous.departure),
               departure.map({ previousDeparture > $0 }) ?? true { item.departure = previous.departure }
            payload.visits[index] = item
        } else { payload.visits.append(item) }
        do { try saveQueue(payload); pendingCount = payload.visits.count }
        catch { return } // saveQueue has already paused collection and surfaced the failure.
        let background = HabitsBackgroundLease()
        background.start()
        let token = generation
        Task {
            defer { background.end() }
            if token == generation { await refresh() }
        }
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
