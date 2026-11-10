import CryptoKit
import Foundation
import Security

/// Device-only encrypted queue. The key lives in the app-only access group, outside extensions.
struct HabitsQueue {
    struct Payload: Codable {
        var epoch: String
        var enabledAt: Date
        var leaseUntil: Date
        var visits: [HabitVisit]
        var wasAuthorizedAlways = false
    }
    let scope: String
    private let directory: URL
    private let suppliedKey: SymmetricKey?
    init(scope: String, directory: URL? = nil, suppliedKey: SymmetricKey? = nil) {
        self.suppliedKey = suppliedKey
        self.scope = scope
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("HabitsQueue", isDirectory: true)
    }
    static func scope(credentials: Credentials, userID: String) -> String {
        SHA256.hash(data: Data("\(credentials.serverURL.absoluteString)|\(userID)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func identity(credentials: Credentials, userID: String?, defaults: UserDefaults = .standard) -> String? {
        let registry = "ernie.habits.scopeByAccount"
        let account = SHA256.hash(data: Data((credentials.serverURL.absoluteString + "\n" + credentials.apiKey).utf8)).map { String(format: "%02x", $0) }.joined()
        var remembered = defaults.dictionary(forKey: registry) as? [String: String] ?? [:]
        guard let userID else { return remembered[account] }
        let value = scope(credentials: credentials, userID: userID)
        remembered[account] = value; defaults.set(remembered, forKey: registry)
        return value
    }
    private var blockedKey: String { "ernie.habits.paused." + scope }
    private var file: URL { directory.appendingPathComponent(scope + ".sealed") }
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.websdbm.ernie.habits", kSecAttrAccount as String: scope, kSecAttrAccessGroup as String: "76X78MBPR3.com.websdbm.ernie.private-diary"] }
    private func key(create: Bool) throws -> SymmetricKey {
        if let suppliedKey { return suppliedKey }
        var read = query; read[kSecReturnData as String] = true; read[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(read as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, data.count == 32 { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound, create else { throw HabitsFailure(code: "key_unavailable") }
        let key = SymmetricKey(size: .bits256)
        var write = query
        write[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        write[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(write as CFDictionary, nil) == errSecSuccess else { throw HabitsFailure(code: "key_unavailable") }
        return key
    }
    func load() throws -> Payload? {
        guard !UserDefaults.standard.bool(forKey: blockedKey), FileManager.default.fileExists(atPath: file.path) else { return nil }
        let data = try Data(contentsOf: file)
        return try JSONDecoder().decode(Payload.self, from: AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key(create: false), authenticating: Data(scope.utf8)))
    }
    func save(_ payload: Payload) throws {
        guard payload.visits.count <= 1000 else { throw HabitsFailure(code: "habits_capacity") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var protectedDirectory = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try protectedDirectory.setResourceValues(values)
        let sealed = try AES.GCM.seal(JSONEncoder().encode(payload), using: key(create: true), authenticating: Data(scope.utf8))
        guard let data = sealed.combined else { throw HabitsFailure(code: "encryption_failed") }
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var protectedFile = file; try protectedFile.setResourceValues(values)
    }
    func begin(_ payload: Payload) throws {
        try save(payload)
        UserDefaults.standard.set(false, forKey: blockedKey)
    }
    @discardableResult func clear() -> Bool {
        // Persist the pause first. Failure to erase a protected file/key cannot restore consent on relaunch.
        UserDefaults.standard.set(true, forKey: blockedKey)
        var removed = true
        if FileManager.default.fileExists(atPath: file.path) {
            do { try FileManager.default.removeItem(at: file) } catch { removed = false }
        }
        let status = SecItemDelete(query as CFDictionary)
        return removed && (status == errSecSuccess || status == errSecItemNotFound)
    }
    static func visitID(arrival: Date?, departure: Date?, latitude: Double, longitude: Double) -> String {
        let material = "\((arrival ?? departure ?? .now).timeIntervalSince1970)|\(String(format: "%.3f", latitude))|\(String(format: "%.3f", longitude))"
        var bytes = Array(SHA256.hash(data: Data(material.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }
        return [hex[0..<4].joined(), hex[4..<6].joined(), hex[6..<8].joined(), hex[8..<10].joined(), hex[10..<16].joined()].joined(separator: "-")
    }
}
