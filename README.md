# 🏏 Cricket Live — Railway Deployment

Real-time cricket game with live Cricbuzz scraping. Open the link on any phone/PC/OBS.

## How It Works
```
Cricbuzz → Railway scraper (every 15s) → Game HTML → Your phone/OBS → YouTube Live
```

## Deploy Steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOURNAME/cricket-live.git
git push -u origin main
```

### 2. Deploy on Railway
1. Go to railway.app → login with GitHub
2. New Project → Deploy from GitHub repo → select this repo
3. Railway auto-detects Node.js and deploys
4. Settings → Generate Domain → get your URL

### 3. Open on phone
Just open the Railway URL in Chrome on your phone. Done.

## API Endpoints
- `GET /` — the cricket game
- `GET /api/live` — all live matches
- `GET /api/scorecard/:matchId` — batting/bowling details  
- `GET /api/status` — server health
