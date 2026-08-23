# Mobile app (Capacitor)

The `android/` and `ios/` folders are real native projects wrapping the same React app in
`frontend/src/` — not a separate codebase. There's nothing AI-generatable left here: building and
running them needs Xcode (iOS) or Android Studio (Android) on your own machine, which this
environment doesn't have.

## First time setup

1. Install the platform tooling you need:
   - **Android**: [Android Studio](https://developer.android.com/studio) (installs the SDK too)
   - **iOS**: Xcode, from the Mac App Store — only builds on macOS, there's no way around that
2. `cd frontend && npm install`

## Point it at your deployed backend

The app has no `window.location` to guess an API URL from (see `src/config.js`), so set one before
building — either:
- Copy `.env.example` to `.env` and set `VITE_API_BASE_URL` to your backend's real URL (e.g. the EC2
  domain from the deploy docs), or
- Leave it unset and set the URL (and API key, if `API_KEY` is configured server-side) from the
  in-app Settings screen after install — it force-opens on first run if nothing's configured.

## Build and open in the native IDE

```bash
npm run cap:android   # builds the web app, syncs it into android/, opens Android Studio
npm run cap:ios       # same, but opens Xcode (macOS only)
```

From there it's the normal native workflow: pick a simulator/device and hit Run in the IDE. To ship
to the Play Store / App Store you'll go through each store's normal signing and submission process —
Capacitor's own docs cover that: https://capacitorjs.com/docs/android/deploying and
https://capacitorjs.com/docs/ios/deploying.

## After changing frontend code

Re-run `npm run cap:sync` (or `cap:android`/`cap:ios`, which do this for you) to rebuild the web
assets and copy them into both native projects. The native project files themselves
(`android/app/src/main/AndroidManifest.xml`, icons, `ios/App/App/Info.plist`, etc.) are committed and
edited directly when you need to change permissions, the app icon, splash screen, and so on — `cap
sync` won't touch those.
