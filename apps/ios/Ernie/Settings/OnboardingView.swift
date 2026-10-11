import SwiftUI

/// Primo avvio: indirizzo del server e chiave API (creata con `admin:create-user`); salvati nel Keychain.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var server = "https://"
    @State private var apiKey = ""
    @State private var working = false
    @State private var localError: String?

    private var serverTrimmed: String { server.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var keyTrimmed: String { apiKey.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var serverURL: URL? {
        guard let url = URL(string: serverTrimmed), let scheme = url.scheme?.lowercased(), url.host() != nil,
              scheme == "https" || scheme == "http" else { return nil }
        return url
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://ernie.esempio.it", text: $server)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server")
                } footer: {
                    Text("Su iPhone serve un indirizzo HTTPS (es. il tuo server o il Mac esposto con Tailscale). Nel simulatore va bene http://localhost:3000.")
                }
                Section {
                    SecureField("ernie_…", text: $apiKey)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Chiave API")
                } footer: {
                    Text("Spazi e a capo vengono ignorati. La chiave inizia con «ernie_».")
                }
                if let error = localError ?? model.signInError {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        HStack {
                            Text("Entra")
                            if working { ProgressView().padding(.leading, 8) }
                        }
                    }
                    .disabled(working)
                } footer: {
                    Text("La chiave resta nel Keychain del dispositivo. Nessun dato viene inviato ad altri servizi.")
                }
            }
            .navigationTitle("Ernie")
        }
    }

    private func submit() async {
        localError = nil
        guard let url = serverURL else {
            localError = "Indirizzo del server non valido: deve iniziare con https:// (o http:// per il simulatore)."
            return
        }
        guard keyTrimmed.hasPrefix("ernie_"), keyTrimmed.count >= 20 else {
            localError = "Chiave API mancante o incompleta: incolla la chiave che inizia con «ernie_»."
            return
        }
        working = true
        defer { working = false }
        _ = await model.signIn(serverURL: url, apiKey: keyTrimmed)
    }
}
