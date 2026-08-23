import { Capacitor } from "@capacitor/core";

// Where the API actually lives, and the key to talk to it — needed once this isn't just "open the
// page from the same machine running the backend" (a Capacitor mobile shell has no meaningful
// window.location.hostname to derive it from; a browser opened against a real deployment needs an
// explicit key). Resolution order, most to least specific:
//   1. localStorage (set via the Settings screen — what a mobile build or a remote deployment uses)
//   2. VITE_API_BASE_URL baked in at build time (frontend/.env, see .env.example)
//   3. window.location-derived guess (today's behavior — same machine, port 8000)
const URL_KEY = "swarm_api_url";
const KEY_KEY = "swarm_api_key";

function guessApiUrl() {
  // Capacitor.isNativePlatform() is the real check — the webview's own origin varies by platform
  // (capacitor://localhost on iOS, https://localhost on Android) and neither one is the actual
  // backend, so checking window.location.protocol alone would silently guess wrong on Android
  // instead of correctly falling through to "no sane guess, ask the user".
  if (typeof window === "undefined" || !window.location || Capacitor.isNativePlatform()) {
    return "";
  }
  return `${window.location.protocol}//${window.location.hostname}:8000`;
}

export function getApiUrl() {
  return localStorage.getItem(URL_KEY) || import.meta.env.VITE_API_BASE_URL || guessApiUrl();
}

export function setApiUrl(url) {
  if (url) localStorage.setItem(URL_KEY, url.replace(/\/$/, ""));
  else localStorage.removeItem(URL_KEY);
}

export function getApiKey() {
  return localStorage.getItem(KEY_KEY) || "";
}

export function setApiKey(key) {
  if (key) localStorage.setItem(KEY_KEY, key);
  else localStorage.removeItem(KEY_KEY);
}

// True once there's enough configured to plausibly reach a backend — used to gate the app behind
// the Settings screen on first run instead of firing requests at an empty string.
export function isConfigured() {
  return !!getApiUrl();
}
