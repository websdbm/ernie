import SwiftUI

/// Cambia l'indirizzo del server tenendo la chiave API (es. passaggio dal Mac a staging3): verifica su /v1/me,
/// salva nel Keychain e ricollega la conversazione. Memorie, liste e promemoria vivono sul server, non nel telefono.
struct ChangeServerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var server = ""
    @State private var working = false
    @State private var error: String?

    private var serverURL: URL? {
        let s = server.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: s), let scheme = url.scheme?.lowercased(), url.host() != nil,
              scheme == "https" || scheme == "http" else { return nil }
        return url
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://…", text: $server)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if server != DefaultServer.url.absoluteString {
                        Button("Usa il server della famiglia (\(DefaultServer.url.host() ?? ""))") { server = DefaultServer.url.absoluteString }
                    }
                } header: {
                    Text("Indirizzo del server")
                } footer: {
                    Text("La chiave API resta la stessa. La conversazione sul telefono riparte da capo; memorie, liste, documenti e promemoria sono sul server.")
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Cambia server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(working ? "Verifico…" : "Salva") { Task { await save() } }
                        .disabled(working || serverURL == nil || serverURL == model.credentials?.serverURL)
                }
            }
            .task { server = model.credentials?.serverURL.absoluteString ?? DefaultServer.url.absoluteString }
        }
    }

    private func save() async {
        guard let url = serverURL else { return }
        working = true
        defer { working = false }
        if await model.changeServer(to: url) {
            dismiss()
        } else {
            error = model.signInError ?? "Il server non ha accettato la chiave."
        }
    }
}
