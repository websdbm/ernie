import SwiftUI
import WidgetKit

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

    @ViewBuilder private var applicationContent: some View {
        if model.credentials == nil { OnboardingView() } else { ChatView() }
    }

    var body: some View {
        Group {
            #if DEBUG
            if ProcessInfo.processInfo.environment["ERNIE_DEBUG_TRIX"] == "1" {
                ErnieTRIXDebugPreview()
            } else {
                applicationContent
            }
            #else
            applicationContent
            #endif
        }
        .animation(.default, value: model.credentials == nil)
        // Messaggio urgente da confermare: copre tutto finché non si conferma di averlo letto.
        .fullScreenCover(item: Binding(get: { model.credentials == nil ? nil : model.urgent.current }, set: { _ in })) { m in
            UrgentMessageCover(message: m).environment(model)
        }
        .onOpenURL { url in model.pendingLink = AppLink(url: url) }
        .onChange(of: scenePhase) { _, phase in
            // Ritorno in primo piano: le condivisioni fatte nel foglio «Ernie» entrano nel second brain.
            if phase == .active {
                Task { await model.mediaUploads.resume() }
                Task { await model.processShareInbox() }
                // Promemoria rimessi in pari: anche quelli legati a un luogo scattati mentre l'app era chiusa.
                Task { await model.reminders.refresh() }
                // Le schede delle automazioni (approvazioni, esiti) arrivate mentre l'app era in background.
                Task { await model.inbox.refresh() }
                Task { await model.syncFamilyMessages() }
            }
            // In uscita: i widget dell'orso rileggono impegni e automazioni dal server.
            if phase == .background {
                model.voice?.cancelListening()
                WidgetCenter.shared.reloadTimelines(ofKind: "ErnieBear")
            }
        }
    }
}
