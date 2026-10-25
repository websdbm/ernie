import Foundation
import CryptoKit
import LocalAuthentication
import Security
import CommonCrypto

/// App-only access group: intentionally absent from share, notification and widget extensions.
@MainActor protocol DiaryKeyAccess {
    func unlock(existingVault: Bool) async throws -> SymmetricKey
    /// Cancella la chiave dal Keychain (eliminazione del diario). Nessuna autenticazione: senza file la chiave non
    /// apre più niente.
    func remove() throws
}

@MainActor final class BiometricDiaryKey: DiaryKeyAccess {
    private let scope: String
    private var context: LAContext?
    init(scope: String) { self.scope = scope }
    func remove() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.websdbm.ernie.private-diary",
            kSecAttrAccount as String: scope,
            kSecAttrAccessGroup as String: "76X78MBPR3.com.websdbm.ernie.private-diary",
        ]
        let result = SecItemDelete(query as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw DiaryError.unavailable }
    }
    func unlock(existingVault: Bool) async throws -> SymmetricKey {
        let context = LAContext()
        self.context = context
        context.localizedFallbackTitle = ""
        context.touchIDAuthenticationAllowableReuseDuration = 0
        defer { context.invalidate(); self.context = nil }
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil),
              try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Sblocca il tuo diario personale")
        else { throw DiaryError.unavailable }
        try Task.checkCancellation()
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.websdbm.ernie.private-diary",
            kSecAttrAccount as String: scope,
            kSecAttrAccessGroup as String: "76X78MBPR3.com.websdbm.ernie.private-diary",
            kSecUseAuthenticationContext as String: context,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var value: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &value)
        if result == errSecSuccess, let data = value as? Data, data.count == 32 { return SymmetricKey(data: data) }
        // Never silently replace a missing/invalidated key for an existing vault.
        // Chiave sparita per un diario che esiste: la biometria è cambiata (.biometryCurrentSet). Errore distinto, così
        // solo questo caso porta al ripristino che sostituisce il diario.
        if result == errSecItemNotFound, existingVault { throw DiaryError.keyInvalidated }
        guard result == errSecItemNotFound else { throw DiaryError.unavailable }
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil) else { throw DiaryError.unavailable }
        let key = SymmetricKey(size: .bits256)
        query.removeValue(forKey: kSecReturnData as String)
        query.removeValue(forKey: kSecMatchLimit as String)
        query[kSecAttrAccessControl as String] = access
        query[kSecAttrSynchronizable as String] = false
        query[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw DiaryError.unavailable }
        return key
    }
}

enum DiaryCrypto {
    static func seal(_ document: DiaryDocument, key: SymmetricKey, scope: String) throws -> Data {
        let data = try JSONEncoder().encode(document.validated())
        guard data.count <= 16_000_000 else { throw DiaryError.vaultFull }
        return try AES.GCM.seal(data, using: key, authenticating: Data(("ernie-private-diary-v1:" + scope).utf8)).combined!
    }
    /// Bozza in un file a parte, piccolo: la digitazione non ricifra l'intero diario. Contesto autenticato distinto,
    /// così una bozza non si può scambiare per il diario (né viceversa).
    static func sealDraft(_ draft: DiaryDraft, key: SymmetricKey, scope: String) throws -> Data {
        guard draft.text.count <= DiaryDocument.maxText else { throw DiaryError.textTooLong }
        let data = try JSONEncoder().encode(draft)
        return try AES.GCM.seal(data, using: key, authenticating: Data(("ernie-private-diary-draft-v1:" + scope).utf8)).combined!
    }
    static func openDraft(_ data: Data, key: SymmetricKey, scope: String) throws -> DiaryDraft {
        guard data.count <= 1_000_000 else { throw DiaryError.invalidArchive }
        do {
            let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key, authenticating: Data(("ernie-private-diary-draft-v1:" + scope).utf8))
            let draft = try JSONDecoder().decode(DiaryDraft.self, from: plain)
            guard draft.text.count <= DiaryDocument.maxText else { throw DiaryError.invalidArchive }
            return draft
        } catch { throw DiaryError.invalidArchive }
    }
    static func open(_ data: Data, key: SymmetricKey, scope: String) throws -> DiaryDocument {
        guard data.count <= 16_000_100 else { throw DiaryError.invalidArchive }
        do {
            let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key, authenticating: Data(("ernie-private-diary-v1:" + scope).utf8))
            return try JSONDecoder().decode(DiaryDocument.self, from: plain).validated()
        } catch { throw DiaryError.invalidArchive }
    }
    struct Backup: Codable {
        var version = 1
        var rounds = 600_000
        var salt: Data
        var sealed: Data
    }
    static func backup(_ document: DiaryDocument, password: String) throws -> Data {
        guard password.count >= 12 && password.utf8.count <= 4096 else { throw DiaryError.weakPassword }
        var salt = Data(count: 16)
        let result = salt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard result == errSecSuccess else { throw DiaryError.unavailable }
        let key = try passwordKey(password, salt: salt)
        return try JSONEncoder().encode(Backup(salt: salt, sealed: seal(document, key: key, scope: "portable-backup-v1")))
    }
    static func restore(_ data: Data, password: String) throws -> DiaryDocument {
        guard data.count <= 23_000_000, password.utf8.count <= 4096 else { throw DiaryError.invalidArchive }
        do {
            let backup = try JSONDecoder().decode(Backup.self, from: data)
            guard backup.version == 1, backup.rounds == 600_000, backup.salt.count == 16 else { throw DiaryError.invalidArchive }
            return try open(backup.sealed, key: passwordKey(password, salt: backup.salt), scope: "portable-backup-v1")
        } catch { throw DiaryError.invalidArchive }
    }
    private static func passwordKey(_ password: String, salt: Data) throws -> SymmetricKey {
        let bytes = Data(password.utf8)
        var derived = Data(count: 32)
        let result = derived.withUnsafeMutableBytes { output in
            bytes.withUnsafeBytes { input in
                salt.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), input.bindMemory(to: Int8.self).baseAddress, bytes.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        600_000, output.bindMemory(to: UInt8.self).baseAddress, 32)
                }
            }
        }
        guard result == kCCSuccess else { throw DiaryError.invalidArchive }
        return SymmetricKey(data: derived)
    }
}
