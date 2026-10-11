import SwiftUI

/// Primo avvio: indirizzo del server e chiave API (creata con `admin:create-user`); salvati nel Keychain.
struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @State private var server = "http://localhost:3000"
    @State private var apiKey = ""
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://ernie.esempio.it", text: $server)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("Chiave API") {
                    SecureField("ernie_…", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                if let error = model.signInError {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task {
                            working = true
                            defer { working = false }
                            guard let url = URL(string: server.trimmingCharacters(in: .whitespaces)) else { return }
                            _ = await model.signIn(serverURL: url, apiKey: apiKey.trimmingCharacters(in: .whitespaces))
                        }
                    } label: {
                        HStack {
                            Text("Entra")
                            if working { ProgressView().padding(.leading, 8) }
                        }
                    }
                    .disabled(working || apiKey.count < 20 || URL(string: server) == nil)
                } footer: {
                    Text("La chiave resta nel Keychain del dispositivo. Nessun dato viene inviato ad altri servizi.")
                }
            }
            .navigationTitle("Ernie")
        }
    }
}
