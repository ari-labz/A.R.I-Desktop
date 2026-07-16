# A·R·I Desktop

The desktop client for [A·R·I](https://github.com/ari-labz/A.R.I). It connects to an A·R·I server — running on the same machine or elsewhere on your network — and gives you the chat and voice-mode interface as a native app instead of a browser tab. The interface (including the voice-mode Orb) is served by the server itself, so you get the same experience in the browser or in this app.

This repo holds two projects:

- **`ARI.Desktop`** — the Electron desktop app.
- **`ARI.Desktop.Installer`** — a small companion app that installs, updates, and downgrades the desktop app. It reads this repo's GitHub Releases so you can pick which version to run.

## Requirements

- A running [A·R·I server](https://github.com/ari-labz/A.R.I).
- [Bun](https://bun.sh) (the dev scripts use it).

## Installing

Download the latest installer for your platform from the [Releases page](https://github.com/ari-labz/A.R.I-Desktop/releases) and run it.

### Getting past the "unverified app" warning

The installers are **not** signed with a paid Apple/Windows certificate, so your OS will warn you the first time you open one. This is expected — the app is safe, it's just unsigned. How to proceed:

- **macOS** — if you see *"A·R·I Desktop … can't be opened because Apple cannot check it for malicious software"* (or *"is damaged"*), **right-click (Control-click) the app → Open → Open**. You only need to do this once. (Do not double-click — that offers no bypass.)
- **Windows** — if SmartScreen shows *"Windows protected your PC"*, click **More info → Run anyway**.
- **Linux** — the installer is an AppImage; mark it executable (`chmod +x ARI_Desktop_Installer_*.AppImage`, or right-click → Properties → allow executing) and run it.

## Development

```sh
cd ARI.Desktop
./dev.sh
```

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
