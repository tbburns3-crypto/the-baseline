# Burnside Sports 🎾

Live tennis and sports scores — ATP, WTA, Challenger, ITF, NBA, MLB, NFL.

Deployed free on GitHub Pages. No server, no cost, no setup beyond uploading three files.

---

## How to Put It on the Internet (GitHub Pages)

1. Go to [github.com](https://github.com) and sign in (or create a free account).
2. Click the **+** in the top-right corner → **New repository**.
3. Name it something like `the-baseline`. Make it **Public**. Click **Create repository**.
4. On the next screen, click **uploading an existing file**.
5. Drag and drop these three files:
   - `index.html`
   - `style.css`
   - `app.js`
6. Click **Commit changes**.
7. Go to **Settings** → scroll down to **Pages** → under **Source** choose **Deploy from a branch** → pick `main` branch, `/ (root)` folder → click **Save**.
8. Wait about 60 seconds, then your site will be live at:
   `https://YOUR-USERNAME.github.io/the-baseline`

That's it!

---

## How to Update Your API Keys

Open `app.js` in any text editor and find this section near the top:

```js
const CFG = {
  tennis: {
    key: 'YOUR-TENNIS-KEY-HERE',
    ...
  },
  bdl: {
    key: 'YOUR-BALLDONTLIE-KEY-HERE',
  },
  apisports: {
    key: 'YOUR-APISPORTS-KEY-HERE',
  }
};
```

Replace the key values with your new keys, save the file, and re-upload it to GitHub.

---

## Features

- **Live tennis scores** — ATP, WTA, Challenger Men/Women, ITF Men/Women, Doubles
- **Real-time updates** via WebSocket (auto-reconnects, falls back to 30-second polling)
- **Date browser** — Yesterday through 3 days ahead
- **Tournament sidebar** with search
- **Filter chips** to show just one category
- **Click any match** to expand set-by-set breakdown
- **Live rankings** — ATP Top 20 and WTA Top 20
- **NBA, MLB, NFL scores** and standings
- Fully **mobile-friendly**
- Connection status always visible

---

## APIs Used

| API | What It Powers |
|-----|---------------|
| [api-tennis.com](https://api-tennis.com) | All tennis data + live WebSocket |
| [BallDontLie](https://www.balldontlie.io) | NBA / MLB / NFL scores (primary) |
| [API-Sports](https://api-sports.io) | NBA / MLB / NFL fallback |

---

## Troubleshooting

**"Could not load matches"** — The CORS proxy (corsproxy.io) may be temporarily down. Refresh in a minute.

**Scores not updating live** — The WebSocket may have disconnected. You'll see "polling every 30s" in the status bar — scores still update, just slightly delayed.

**No NBA/MLB/NFL games showing** — Check if it's the offseason! NFL runs Sep–Feb, MLB runs Apr–Oct, NBA runs Oct–Jun.
