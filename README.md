# Hue Switch Studio

A desktop app for configuring Philips Hue and Friends of Hue switches beyond what the
official Hue app allows.

- **All 6 buttons** on Friends of Hue / Senic switches — including the two the official app
  cannot see.
- **A different zone or room per button**, so one switch can drive several parts of the house.
- **A different target for short press than for hold**, which the official app does not offer.

![A six-button Friends of Hue switch open in Hue Switch Studio, with a short press and a hold configured per button](https://raw.githubusercontent.com/xdjinnx/hue-switch-studio/main/img/demo.png)

Everything it configures runs **on the bridge**. Once you have saved, your switches keep
working with this app closed and your PC switched off.

## Requirements

- A Philips Hue Bridge (the square v2 bridge) on the same network as your PC.
- Node.js 18 or newer.
- Windows is the tested platform. The app is Electron and should run elsewhere, but the
  encrypted credential store and the backup folder path are only verified on Windows.

## Running it

```
npm install
npm start
```

On first launch the app looks for your bridge on the local network. Press the round link
button on top of the bridge, then click **Connect** — this is the standard Hue pairing
handshake and gives the app its own application key. You only do it once.

## Using it

1. Pick a switch from the sidebar. The app reads its current configuration from the bridge.
2. Choose what each button should do. For every button you can set a **short press** and a
   **hold**, and point each one at a room, a zone, or a scene.
3. Click **Save**. The app writes to the bridge and takes a backup first.

Where the UI can tell that a combination will not work — the bridge refuses some, and others
are silently impossible — it says so before you save rather than letting the write fail.

## What it does with your bridge

- **Your credentials stay on your machine.** The application key is a bearer token for full
  control of your lights, so it is encrypted at rest with Windows DPAPI where the OS provides
  it. If encryption is unavailable the app falls back to plaintext and says so in the sidebar
  rather than quietly implying the key is protected.
- **It verifies the bridge's identity.** The bridge's certificate is signed by a private Hue
  CA that no operating system trusts, so normal verification cannot succeed. Instead of
  turning verification off, the app pins the bridge's public key on first connection and
  enforces it afterwards. If it ever changes, you get a hard error saying what changed.
- **It leaves alone what you did not edit.** Anything you have not changed is written back
  exactly as the bridge gave it, byte for byte. Only what you edited is regenerated.
- **It backs up before every write**, to `%APPDATA%/hue-switch-studio/backups`. *Back up all*
  and *Restore…* in the sidebar cover the whole bridge; a restore only touches the switch
  configuration this app manages, so the rest of your setup is left as it is.

## Good to know

- **Buttons 5 and 6 support a single press action** — no hold, no toggle. They are configured
  through an older bridge mechanism that cannot measure how long a button was held or check
  what a light is currently doing. The app warns you and saves a plain scene recall.
- **Editing buttons 1–4 here may confuse the official app's setup screen for that switch**,
  because it did not author the configuration. The switch itself keeps working normally.
  Buttons 5 and 6 are invisible to the official app and carry no such risk.
- **If a button was pointed at one individual bulb by the Hue app, that survives** a save
  here, but this UI works at room and zone level and cannot edit it.

## License

MIT
