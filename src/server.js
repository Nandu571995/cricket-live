const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── In-memory cache (no DB needed) ───────────────────────────
let cachedMatches   = [];
let cachedScorecard = {};   // { matchId: scorecardData }
let lastUpdated     = null;
let scrapeStatus    = 'idle'; // idle | scraping | ok | error

// ─── SCRAPER HEADERS (rotate to avoid blocks) ──────────────────
const HEADERS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];
function randHeader() {
  return HEADERS[Math.floor(Math.random() * HEADERS.length)];
}

// ─── SCRAPE LIVE MATCHES LIST ──────────────────────────────────
async function scrapeLiveMatches() {
  try {
    scrapeStatus = 'scraping';
    const { data } = await axios.get('https://www.cricbuzz.com/cricket-match/live-scores', {
      headers: { 'User-Agent': randHeader(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });

    const $       = cheerio.load(data);
    const matches = [];

    // Each live match card
    $('div.cb-mtch-lst.cb-tms-itm').each((i, el) => {
      try {
        const matchEl  = $(el);
        const linkEl   = matchEl.find('a.text-hvr-underline').first();
        const href     = linkEl.attr('href') || '';

        // Extract match ID from href like /live-cricket-scores/12345/...
        const idMatch  = href.match(/\/(\d+)\//);
        const matchId  = idMatch ? idMatch[1] : null;

        // Team names
        const teams    = matchEl.find('.cb-hmscg-tm-nm').map((_, t) => $(t).text().trim()).get();

        // Scores — can be multiple innings
        const scoreBlocks = matchEl.find('.cb-hmscg-tm-scr-itm');
        const scores   = scoreBlocks.map((_, s) => $(s).text().trim()).get();

        // Match status / commentary
        const statusEl = matchEl.find('.cb-text-live, .cb-text-complete, .cb-text-stumps, .cb-text-inprogress');
        const status   = statusEl.first().text().trim() ||
                         matchEl.find('.cb-scr-wll-chvrn').text().trim();

        // Venue and series
        const series   = matchEl.closest('.cb-col-100').find('.text-hvr-underline').first().text().trim();
        const venue    = matchEl.find('.cb-font-12').first().text().trim();

        // Format detection
        const titleTxt = matchEl.text().toLowerCase();
        const format   = titleTxt.includes('test') ? 'TEST' :
                         titleTxt.includes('t20')  ? 'T20'  :
                         titleTxt.includes('odi')  ? 'ODI'  : 'T20';

        // Only include if we have at least team names
        if (teams.length >= 2) {
          matches.push({
            matchId,
            team1:   teams[0] || 'Team A',
            team2:   teams[1] || 'Team B',
            score1:  scores[0] || '—',
            score2:  scores[1] || '—',
            status:  status || 'Live',
            series,
            venue,
            format,
            isLive:  statusEl.hasClass('cb-text-live') || status.toLowerCase().includes('live'),
          });
        }
      } catch(e) { /* skip bad card */ }
    });

    // If no matches found via first selector, try alternate
    if (matches.length === 0) {
      $('div.cb-scr-wll-chvrn').parent().each((i, el) => {
        const txt   = $(el).text().trim();
        const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          matches.push({
            matchId:  i.toString(),
            team1:    lines[0],
            team2:    lines[1] || '',
            score1:   lines[2] || '—',
            score2:   lines[3] || '—',
            status:   lines[lines.length - 1],
            format:   'T20',
            isLive:   true,
          });
        }
      });
    }

    cachedMatches = matches;
    lastUpdated   = new Date().toISOString();
    scrapeStatus  = 'ok';
    console.log(`[Scraper] ✅ Fetched ${matches.length} matches at ${lastUpdated}`);
    return matches;
  } catch(e) {
    scrapeStatus = 'error';
    console.error('[Scraper] ❌ Error:', e.message);
    return cachedMatches; // return stale cache on error
  }
}

// ─── SCRAPE SCORECARD FOR A MATCH ─────────────────────────────
async function scrapeScorecard(matchId) {
  try {
    const url = `https://www.cricbuzz.com/live-cricket-scorecard/${matchId}`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randHeader(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });

    const $      = cheerio.load(data);
    const result = { matchId, batsmen: [], bowlers: [], extras: '', total: '', updated: new Date().toISOString() };

    // ── Batting ──
    $('div#innings_1, div#innings_2').first().find('table.cb-ltst-wgt-hdr').each((ti, table) => {
      const headers = $(table).find('thead th').map((_, th) => $(th).text().trim()).get();

      if (headers.includes('R') || headers.includes('Runs')) {
        // Batting table
        $(table).find('tbody tr').each((_, row) => {
          const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
          if (cells.length >= 6 && cells[0] && !cells[0].includes('Extras') && !cells[0].includes('Total')) {
            result.batsmen.push({
              name:   cells[0].replace(/\(c\)|\(wk\)/g, '').trim(),
              status: cells[1] || '',
              runs:   cells[2] || '0',
              balls:  cells[3] || '0',
              fours:  cells[4] || '0',
              sixes:  cells[5] || '0',
              sr:     cells[6] || '0.00',
              isOut:  cells[1] ? !cells[1].toLowerCase().includes('batting') : true,
            });
          }
          // Extras line
          if (cells[0] && cells[0].toLowerCase().includes('extras')) {
            result.extras = cells[cells.length - 1] || '';
          }
          // Total line
          if (cells[0] && cells[0].toLowerCase().includes('total')) {
            result.total = cells[cells.length - 1] || '';
          }
        });
      } else {
        // Bowling table
        $(table).find('tbody tr').each((_, row) => {
          const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
          if (cells.length >= 5 && cells[0] && cells[0].length > 2) {
            result.bowlers.push({
              name:    cells[0],
              overs:   cells[1] || '0',
              maidens: cells[2] || '0',
              runs:    cells[3] || '0',
              wickets: cells[4] || '0',
              economy: cells[5] || '0.00',
            });
          }
        });
      }
    });

    // Fallback simple scrape if tables empty
    if (result.batsmen.length === 0) {
      $('div.cb-col-100.cb-col').each((_, el) => {
        const name  = $(el).find('a.cb-text-link').first().text().trim();
        const score = $(el).find('div.cb-col-8.cb-col').first().text().trim();
        if (name && score && !isNaN(parseInt(score))) {
          result.batsmen.push({ name, runs: score, balls: '—', fours: '—', sixes: '—', sr: '—' });
        }
      });
    }

    cachedScorecard[matchId] = result;
    return result;
  } catch(e) {
    console.error('[Scorecard] ❌', e.message);
    return cachedScorecard[matchId] || { matchId, batsmen: [], bowlers: [], error: e.message };
  }
}

// ─── CRON: scrape every 15 seconds ────────────────────────────
scrapeLiveMatches(); // immediate on start
cron.schedule('*/15 * * * * *', scrapeLiveMatches);

// ─── AUTO-SCRAPE scorecard for first live match every 30s ──────
cron.schedule('*/30 * * * * *', async () => {
  const live = cachedMatches.find(m => m.isLive) || cachedMatches[0];
  if (live?.matchId) await scrapeScorecard(live.matchId);
});

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/live — all live matches
app.get('/api/live', (req, res) => {
  res.json({
    matches:     cachedMatches,
    lastUpdated,
    scrapeStatus,
    count:       cachedMatches.length,
  });
});

// GET /api/scorecard/:matchId — batting/bowling details
app.get('/api/scorecard/:matchId', async (req, res) => {
  const { matchId } = req.params;
  // Return cached if fresh (< 30s old)
  if (cachedScorecard[matchId]) {
    return res.json(cachedScorecard[matchId]);
  }
  const data = await scrapeScorecard(matchId);
  res.json(data);
});

// GET /api/status — health + scrape info
app.get('/api/status', (req, res) => {
  res.json({
    status:      'ok',
    scrapeStatus,
    matchCount:  cachedMatches.length,
    lastUpdated,
    server:      'Cricket Live Railway Server',
    time:        new Date().toISOString(),
  });
});

// GET /api/first — convenience: first live match + its scorecard
app.get('/api/first', async (req, res) => {
  const match = cachedMatches.find(m => m.isLive) || cachedMatches[0];
  if (!match) return res.json({ match: null, scorecard: null });
  let scorecard = cachedScorecard[match.matchId];
  if (!scorecard) scorecard = await scrapeScorecard(match.matchId);
  res.json({ match, scorecard });
});

// Serve game HTML at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏏 Cricket Live Server running on port ${PORT}`);
  console.log(`📡 Scraping Cricbuzz every 15 seconds`);
  console.log(`🌐 Open: http://localhost:${PORT}\n`);
});
