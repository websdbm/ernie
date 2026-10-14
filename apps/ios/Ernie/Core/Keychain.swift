import Foundation
import Security

/// Accesso minimo al Keychain: stringhe per account, nel servizio dell'app, disponibili dopo il primo sblocco.
/// Le voci stanno nel gruppo di accesso condiviso con l'estensione «Condividi con Ernie» (stesso Team): così il foglio
/// di condivisione legge le stesse credenziali. Le voci scritte prima di questa versione (senza gruppo) restano leggibili
/// e vengono riscritte nel gruppo condiviso al primo salvataggio.
enum Keychain {
    static let service = "com.websdbm.ernie"
    /// Gruppo di accesso condiviso da app ed estensione (entitlement `keychain-access-groups`).
    static let accessGroup = "76X78MBPR3.com.websdbm.ernie"

    enum KeychainError: LocalizedError {
        case unexpectedStatus(OSStatus)

        var errorDescription: String? {
            switch self {
            case .unexpectedStatus(let status):
                let message = SecCopyErrorMessageString(status, nil) as String? ?? "errore sconosciuto"
                return "Keychain: \(message) (\(status))"
            }
        }
    }

    /// Salva la voce nel gruppo condiviso e toglie le copie che stanno in altri gruppi. Senza l'entitlement del gruppo
    /// (build senza firma) scrive nel gruppo predefinito dell'app, come prima.
    static func set(_ value: String, account: String) throws {
        do {
            try write(value, account: account, group: accessGroup)
        } catch KeychainError.unexpectedStatus(let status) where status == errSecMissingEntitlement {
            try write(value, account: account, group: nil)
            return
        }
        removeCopies(account: account, keeping: accessGroup)
    }

    /// Legge prima dal gruppo condiviso, poi dalla forma senza gruppo (credenziali salvate da versioni precedenti).
    static func get(account: String) -> String? {
        read(account: account, group: accessGroup) ?? read(account: account, group: nil)
    }

    /// Cancella la voce dal gruppo condiviso e dalla forma senza gruppo.
    static func delete(account: String) {
        SecItemDelete(baseQuery(account: account, group: accessGroup) as CFDictionary)
        SecItemDelete(baseQuery(account: account, group: nil) as CFDictionary)
    }

    // MARK: - privato

    private static func baseQuery(account: String, group: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    private static func write(_ value: String, account: String, group: String?) throws {
        let query = baseQuery(account: account, group: group)
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            let added = SecItemAdd(insert as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError.unexpectedStatus(added) }
        } else if status != errSecSuccess {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private static func read(account: String, group: String?) -> String? {
        var query = baseQuery(account: account, group: group)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Toglie le copie della voce in altri gruppi di accesso; quella nel gruppo `group` resta.
    private static func removeCopies(account: String, keeping group: String) {
        var query = baseQuery(account: account, group: nil)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]] else { return }
        for item in items {
            guard let other = item[kSecAttrAccessGroup as String] as? String, other != group else { continue }
            SecItemDelete(baseQuery(account: account, group: other) as CFDictionary)
        }
    }
}
