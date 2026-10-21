import SwiftUI

struct StatusLine: View {
    @ObservedObject var feed: FeedClient

    var body: some View {
        let s = feed.status
        VStack(alignment: .leading, spacing: 2) {
            Text("\(s.state) · version \(s.version ?? "–") · \(s.itemCount) items")
                .font(.footnote.monospaced())
            if let err = s.lastError {
                Text(err).font(.footnote).foregroundStyle(.orange)
            }
        }
    }
}

struct SettingsForm: View {
    @ObservedObject var model: AppModel
    @AppStorage(SettingsKeys.feedUrl) private var feedUrl = SettingsKeys.defaultFeedUrl
    @AppStorage(SettingsKeys.worldKey) private var worldKey = ""
    @AppStorage(SettingsKeys.soundOn) private var soundOn = false

    var body: some View {
        Form {
            Section("VLM feed") {
                TextField("Feed URL", text: $feedUrl)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                SecureField("World key (vlmw_…)", text: $worldKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Toggle("Sound (videos and sounds)", isOn: $soundOn)
                Button("Connect") { model.connect() }
            }
            Section("Status") {
                StatusLine(feed: model.feed)
            }
            Section {
                Text("Get a world key from vlm.gg → Deploy → Your Hyperfy worlds → Connect a world. Spike: the key is stored in UserDefaults.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
