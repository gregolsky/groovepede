# 💿 Groovepede

**Never lose a great album recommendation again.**

Groovepede is a minimalist, local-first PWA inbox for Spotify albums. Save albums from your phone's share sheet, browse them with covers and genre tags, and check them off as you listen.

**[Open the app →](https://gregolsky.github.io/groovepede/)**

---

## Features

- **Share sheet integration** — share any Spotify album directly to Groovepede from the Spotify app
- **Album metadata** — covers, artist names, release year and genres fetched from the Spotify API
- **Genre filtering** — filter your queue by genre as it builds up
- **Listening stats** — track how many albums you've queued, listened to, and added today
- **Installable PWA** — add to your home screen on Android or desktop, works offline
- **Local-first** — all data lives in your browser's localStorage, nothing is sent anywhere

## How to use

1. Open [groovepede](https://gregolsky.github.io/groovepede/) and connect your Spotify account
2. Install it as an app (tap "Add to Home Screen" on mobile, or the install icon in your browser's address bar)
3. In the Spotify app, find an album you want to listen to, tap **Share → Groovepede**
4. When you're ready to listen, tap **Listen** to open it directly in Spotify
5. Tap **Done** when you've listened — your count goes up

## Tech

A single `index.html` with no build step, no framework, no dependencies. Deployed via GitHub Pages.

- Spotify OAuth using the [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) — no backend required, no secrets stored
- [Spotify Web API](https://developer.spotify.com/documentation/web-api) for album metadata
- Service worker for offline support and PWA installability
- `localStorage` for persistent album storage

## Self-hosting

If you want to run your own instance:

1. Fork this repo
2. Enable GitHub Pages on the `main` branch
3. Create a [Spotify Developer app](https://developer.spotify.com/dashboard) and set the redirect URI to your Pages URL
4. Replace the `CLIENT_ID` value in `index.html` with your own
5. Push — that's it

## Privacy

Groovepede only requests the `user-read-private` Spotify scope (needed to display your name and avatar). It never reads your listening history, playlists, or any other Spotify data. Your album queue is stored locally in your browser and never leaves your device.
