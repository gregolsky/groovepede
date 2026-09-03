# ![Groovepede](frontend/public/favicon.png)

**Never lose a great album recommendation again.**

Groovepede is a minimalist, local-first PWA inbox for Spotify albums. Save albums from your phone's share sheet, browse them with covers and genre tags, and check them off as you listen.

**[Open the app →](https://groovepede.gregolsky.pl/)**

---

## Features

- **Share sheet integration** — share any Spotify album directly to Groovepede from the Spotify app
- **Album metadata** — covers, artist names, and release year from the Spotify API; genre tags from Last.fm, backed up by Deezer and MusicBrainz for artists Last.fm doesn't cover well
- **Artist info** — expand any album card to see an artist bio and similar artists, powered by Last.fm
- **Explore mode** — full-screen view per album with track listing, artist image, and keyboard/swipe navigation
- **Genre filtering** — filter your queue by genre tags as they build up
- **Listening stats** — track how many albums you've queued, listened to, and added today
- **Installable PWA** — add to your home screen on Android or desktop, works offline
- **Local-first** — all data lives in your browser's localStorage, nothing is sent anywhere

## How to use

1. Open [groovepede](https://groovepede.gregolsky.pl/) — no account or login needed
2. Install it as an app (tap "Add to Home Screen" on mobile, or the install icon in your browser's address bar)
3. In the Spotify app, find an album you want to listen to, tap **Share → Groovepede**
4. When you're ready to listen, tap **Listen** to open it directly in Spotify
5. Tap **Done** when you've listened — your count goes up

## Tech

Vite for dev server and production builds. No framework, no runtime dependencies. Deployed via GitHub Pages.

- [Last.fm API](https://www.last.fm/api) for genre tags, artist bios, and similar artist recommendations
- Service worker for offline support and PWA installability
- `localStorage` for persistent album storage

## Self-hosting

If you want to run your own instance:

1. Fork this repo
2. Enable GitHub Pages on the `main` branch
3. Push — that's it

## Privacy

There's no login and no account, so there's nothing tied to your identity. Your album queue is stored locally in your browser and never leaves your device.
