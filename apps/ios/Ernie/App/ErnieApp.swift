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

    var body: some View {
        Group {
            if model.credentials == nil {
                OnboardingView()
            } else {
                ChatView()
            }
        }
        .animation(.default, value: model.credentials == nil)
    }
}
