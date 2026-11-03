# NBA MVP race – market odds

A small static site with running odds for the NBA MVP race, built from Kalshi and Polymarket prices.

- `fetch.py` reads both markets' public APIs (no keys, Python stdlib only) and writes `site/data.json`. It also reads ESPN's public NBA feed: the team list plus all 30 rosters, about 2 seconds. From those it adds each player's team, team logo and headshot. If ESPN fails, the prices still publish and the page shows initials instead of photos.
- Images load straight from ESPN's image server (`a.espncdn.com/combiner`), resized to the size shown.
- Sportsbook odds:
  - **DraftKings** comes from ESPN's futures feed (`sports.core.api.espn.com/.../seasons/2027/futures`, "NBA - Regular Season MVP") and is matched by ESPN player ID.
  - **Unibet** comes from Kambi's public offering feed (`eu-offering-api.kambicdn.com/offering/v2018/ub`) and is matched by name.
  - Neither needs a key.
  - The Odds API has no MVP market, only the championship winner.
- Each player's detail panel uses three ESPN sources:
  - the injury report (status, note, expected return)
  - the player's game log (last regular-season game and season averages; one call per player at 1% or more)
  - league standings (record, seed, streak, last 10, home/road, points for and against)
- `site/` is plain HTML, CSS and JavaScript with no dependencies. It shows the favourite, a chart of the chance over time, and a table of every candidate.
- `.github/workflows/update.yml` runs `fetch.py` every 30 minutes on GitHub's servers and publishes `site/` to GitHub Pages.

## Run locally

```
python fetch.py
cd site
python -m http.server 8765
```

Then open http://127.0.0.1:8765/.

From a Hungarian connection, `clob.polymarket.com` is blocked, so the local build has no Polymarket price history. The table still shows today's Polymarket prices (via `gamma-api.polymarket.com`), and the chart says which history is missing. GitHub's runners are outside Hungary and get everything.

## Publish on GitHub Pages

1. Push this folder to a GitHub repository. Pages is free for public repos; private repos need a paid plan.
2. Go to Settings → Pages → Source and choose **GitHub Actions**.
3. Go to Actions → Update odds → **Run workflow** once. After that it runs on its own.

GitHub pauses scheduled workflows in public repos after 60 days without a commit. Re-enable it from the Actions tab, or push any small change.

## New season

Change `SEASON`, `KALSHI_EVENT`, `POLYMARKET_EVENT` and `ESPN_SEASON` (the year the season ends) at the top of `fetch.py`. Unibet's market is found by name, so it needs no change. Kalshi's event ticker is `KXNBAMVP-<yy>`. Search Polymarket's slug with
`https://gamma-api.polymarket.com/public-search?q=nba%20mvp`.

## How the numbers are made

- **Chance**: the midpoint between the best bid and ask when the spread is 10¢ or less, otherwise the last trade (Polymarket's own display rule). The same rule applies to Kalshi, now and in the history.
- **Average**: the mean of the markets that list the player. Missing days carry the last price forward.
- **Fair odds**: 1 ÷ chance, with no bookmaker margin.
- **Change**: in percentage points, over the selected range.

## Before making it public

- Kalshi's Developer Agreement (§3, §3.1) limits API data to a member's own trading and forbids sharing it with third parties without written authorization. Polymarket's Terms of Use (§4.2) also forbid redistributing its data unless agreed in writing. Get written permission from both before the site goes public.
- ESPN's headshots and the team logos are ESPN's and the teams' property. ESPN offers no licence for this use. Hobby sites commonly hotlink them, but that isn't permission. If that matters, Wikimedia Commons has freely licensed player photos (credit required). There is no free alternative for team logos, so you could drop them and keep the team names, which are fine as text.
- Hungary bans advertising unlicensed gambling, and Polymarket is under SZTFH proceedings. The site therefore has no links to either market, no referral codes and no "bet here" wording. Keep it that way.
- The sportsbook columns carry more risk in Hungary. DraftKings and Unibet aren't licensed there; Szerencsejáték (Tippmix) is the only licensed sportsbook. Their names next to their prices is what an odds-comparison ad looks like. Get a Hungarian lawyer's view before serving them to Hungarian visitors, or hide those two columns there.
- ESPN's and Kambi's feeds are undocumented. Neither publishes terms that permit reuse, and either can change or close without notice.
