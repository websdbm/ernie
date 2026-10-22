import AVFoundation
import MediaPlayer
import SwiftUI

/// Controllo pubblico di iOS: il volume resta scelto dall'utente, per l'uscita audio corrente.
struct SpeechVolumeControl: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Volume della voce")
                Spacer()
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    Text(AVAudioSession.sharedInstance().outputVolume, format: .percent.precision(.fractionLength(0)))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            SystemVolumeSlider()
                .frame(height: 36)
            Text("Regolalo mentre ascolti l’esempio, oppure usa i pulsanti del volume dell’iPhone.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

private struct SystemVolumeSlider: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView(frame: .zero)
        view.tintColor = UIColor(Theme.accentText)
        view.accessibilityLabel = "Volume della voce"
        return view
    }

    func updateUIView(_ view: MPVolumeView, context: Context) {}
}
