import SwiftUI

@main
struct ErnieApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task {
                    appDelegate.model = model
                    await model.start()
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.credentials == nil {
                OnboardingView()
            } else {
                ChatView()
            }
        }
        .animation(.default, value: model.credentials == nil)
        .onChange(of: scenePhase) { _, phase in
            // Ritorno in primo piano: le condivisioni fatte nel foglio «Ernie» entrano nel second brain.
            if phase == .active { Task { await model.processShareInbox() } }
        }
    }
}
