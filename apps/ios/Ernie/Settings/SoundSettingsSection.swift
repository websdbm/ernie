import SwiftUI

struct SoundSettingsSection: View {
    @Environment(AppModel.self) private var model
    @AppStorage(ErnieSoundPlayer.enabledKey) private var enabled = true
    @AppStorage(ErnieSoundPlayer.volumeKey) private var volume = ErnieSoundPlayer.defaultVolume

    private var voiceBusy: Bool { model.speaker.isSpeaking || model.voice?.isActive == true }

    var body: some View {
        Section {
            Toggle("Suoni delle azioni", isOn: $enabled)
                .onChange(of: enabled) { _, active in if !active { ErnieSoundPlayer.shared.stop() } }
            if enabled {
                LabeledContent("Volume effetti", value: volume.formatted(.percent.precision(.fractionLength(0))))
                Slider(value: $volume, in: 0...1) { editing in
                    if !editing, !voiceBusy { ErnieSoundPlayer.shared.play(.check) }
                }
                .accessibilityLabel("Volume dei suoni di Ernie")
                Menu {
                    ForEach(ErnieSound.allCases, id: \.self) { sound in
                        Button(sound.title) { ErnieSoundPlayer.shared.play(sound) }
                    }
                } label: {
                    Label("Ascolta i suoni", systemImage: "speaker.wave.2")
                }
                .disabled(voiceBusy)
            }
        } header: {
            Text("Suoni di Ernie")
        } footer: {
            Text("Zampate, brontolii e piccoli accenti retro. Rispettano il silenzioso e lasciano la precedenza a microfono e voce. Il volume è separato dalla voce; nessun consumo AI.")
        }
    }
}
