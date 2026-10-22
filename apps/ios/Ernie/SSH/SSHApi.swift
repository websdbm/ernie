import Foundation

extension ApiClient {
    func sshSnapshot() async throws -> SshSnapshot { try await request("GET", "/v1/ssh") }
    func sshKey(rotate: Bool) async throws -> SshSnapshot {
        struct Body: Encodable, Sendable { var rotate: Bool }
        return try await request("POST", "/v1/ssh/key", body: Body(rotate: rotate))
    }
    func sshRevokeKey() async throws -> SshSnapshot { try await request("DELETE", "/v1/ssh/key") }
    func sshSaveServer(_ input: SshServerInput) async throws -> SshSnapshot { try await request("POST", "/v1/ssh/servers", body: input) }
    func sshSaveSite(_ input: SshSiteInput) async throws -> SshSnapshot { try await request("POST", "/v1/ssh/sites", body: input) }
    func sshProbe(_ serverId: String) async throws -> String {
        struct Response: Decodable { var fingerprint: String }
        let response: Response = try await request("POST", "/v1/ssh/servers/\(serverId)/probe", body: [String: String]())
        return response.fingerprint
    }
    func sshTrust(_ serverId: String, fingerprint: String) async throws -> SshSnapshot {
        struct Body: Encodable, Sendable { var fingerprint: String }
        return try await request("POST", "/v1/ssh/servers/\(serverId)/trust", body: Body(fingerprint: fingerprint))
    }
    func sshDiagnose(_ input: SshDiagnosticInput) async throws -> String {
        struct Response: Decodable { var output: String }
        let response: Response = try await request("POST", "/v1/ssh/diagnose", body: input)
        return response.output
    }
    func sshConnectProvider(_ input: SshProviderCredentials) async throws -> SshSnapshot {
        try await request("PUT", "/v1/ssh/providers/\(input.provider.rawValue)", body: input)
    }
    func sshDisconnectProvider(_ provider: SshProvider) async throws -> SshSnapshot {
        try await request("DELETE", "/v1/ssh/providers/\(provider.rawValue)")
    }
    func sshProviderInstances(_ provider: SshProvider) async throws -> [SshProviderInstance] {
        struct Response: Decodable { var instances: [SshProviderInstance] }
        let response: Response = try await request("GET", "/v1/ssh/providers/\(provider.rawValue)/instances")
        return response.instances
    }
    func sshImportPreview(_ input: SshImportInput) async throws -> SshImportPreview { try await request("POST", "/v1/ssh/import/preview", body: input) }
    func sshImportApply(_ input: SshImportInput) async throws -> SshSnapshot { try await request("POST", "/v1/ssh/import/apply", body: input) }
    func sshPlan(_ input: SshPlanInput) async throws -> SshOperation { try await request("POST", "/v1/ssh/operations", body: input) }
    func sshApprove(_ id: String) async throws -> SshOperation { try await request("POST", "/v1/ssh/operations/\(id)/approve", body: [String: String]()) }
    func sshReject(_ id: String) async throws -> SshOperation { try await request("POST", "/v1/ssh/operations/\(id)/reject", body: [String: String]()) }
    func sshOperation(_ id: String) async throws -> SshOperation { try await request("GET", "/v1/ssh/operations/\(id)") }
}
