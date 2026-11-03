"""Fetch NBA MVP prices from Kalshi and Polymarket and write site/data.json.

Run:  python fetch.py
Stdlib only. If one market fails, the other still publishes; if both fail,
data.json is left untouched and the script exits with an error. Everything
else is optional and drops out on its own if its source is down:
- ESPN: teams, logos, headshots, injuries, game logs, standings, and
  DraftKings' MVP odds (ESPN's futures feed).
- Kambi's public offering feed: Unibet's MVP odds.
"""
import json
import re
import sys
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Change these each season.
SEASON = "2026-27"
KALSHI_EVENT = "KXNBAMVP-27"
POLYMARKET_EVENT = "nba-2026-27-mvp"
ESPN_SEASON = 2027                       # ESPN names a season by the year it ends

HISTORY_MIN = 0.01   # price history and game logs for players at 1% or more
MAX_SPREAD = 0.10    # wider bid/ask spreads use the last trade instead of the midpoint
TIMEOUT = 20

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
ESPN_V2 = "https://site.api.espn.com/apis/v2/sports/basketball/nba"
ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba"
ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba"
KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/ub"   # "ub" = Unibet
KAMBI_PARAMS = {"lang": "en_GB", "market": "GB"}
SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}
OUT = Path(__file__).resolve().parent / "site" / "data.json"
HEADERS = {"User-Agent": "nba-mvp-odds/1.0", "Accept": "application/json"}


def get_json(url, params=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.load(r)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def key(name):
    """Match players across sources: 'Nikola Jokić' = 'Nikola Jokic', 'Jimmy Butler III' = 'Jimmy Butler'."""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    words = s.lower().replace(".", "").replace("-", " ").split()
    return " ".join(w for w in words if w not in SUFFIXES)


def path(url):
    """ESPN image URL -> path, so the page can ask ESPN's resizer for the size it needs."""
    return urllib.parse.urlparse(url).path if url else None


def price(bid, ask, last):
    """Midpoint when the spread is tight, otherwise the last trade (Polymarket's display rule)."""
    if bid and ask and ask - bid <= MAX_SPREAD:
        return (bid + ask) / 2
    return last


def day(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


# --- Kalshi -----------------------------------------------------------------

def kalshi_current():
    data = get_json(f"{KALSHI}/markets", {"event_ticker": KALSHI_EVENT, "status": "open", "limit": 200})
    out = {}
    for m in data["markets"]:
        if m["ticker"].endswith("-TIE"):
            continue
        p = price(num(m.get("yes_bid_dollars")), num(m.get("yes_ask_dollars")), num(m.get("last_price_dollars")))
        if p is None:
            continue
        out[key(m["yes_sub_title"])] = {
            "name": m["yes_sub_title"],
            "id": m["ticker"],
            "p": p,
            "open": m.get("open_time"),
        }
    return out


def kalshi_history(tickers, start):
    """Daily closes per ticker, as {ticker: {date: price}}."""
    now = int(datetime.now(timezone.utc).timestamp())
    out = {}
    for i in range(0, len(tickers), 50):
        data = get_json(f"{KALSHI}/markets/candlesticks", {
            "market_tickers": ",".join(tickers[i:i + 50]),
            "start_ts": start, "end_ts": now, "period_interval": 1440,
        })
        for m in data.get("markets", []):
            series = {}
            for c in m.get("candlesticks", []):
                p = price(num(c["yes_bid"].get("close_dollars")),
                          num(c["yes_ask"].get("close_dollars")),
                          num(c["price"].get("close_dollars")))
                if p is not None:
                    series[day(c["end_period_ts"] - 1)] = p
            out[m["market_ticker"]] = series
    return out


# --- Polymarket -------------------------------------------------------------

def polymarket_current():
    events = get_json(f"{GAMMA}/events", {"slug": POLYMARKET_EVENT})
    if not events:
        raise RuntimeError(f"no Polymarket event {POLYMARKET_EVENT!r}")
    out = {}
    for m in events[0]["markets"]:
        if not m.get("active") or m.get("closed") or m.get("negRiskOther"):
            continue
        outcomes = json.loads(m["outcomes"])
        yes = outcomes.index("Yes")
        p = num(json.loads(m["outcomePrices"])[yes])
        if p is None:
            continue
        out[key(m["groupItemTitle"])] = {
            "name": m["groupItemTitle"],
            "id": json.loads(m["clobTokenIds"])[yes],
            "p": p,
        }
    return out


def polymarket_history(token):
    data = get_json(f"{CLOB}/prices-history", {"market": token, "interval": "max", "fidelity": 1440})
    series = {}
    for pt in data.get("history", []):
        series[day(pt["t"])] = float(pt["p"])
    return series


# --- ESPN (teams, logos, headshots) -----------------------------------------

def espn():
    """Returns ({abbr: team}, {player key: {id, team, teamId, headshot}}) from all 30 rosters."""
    teams = [t["team"] for t in get_json(f"{ESPN}/teams")["sports"][0]["leagues"][0]["teams"]]
    with ThreadPoolExecutor(8) as ex:
        rosters = list(ex.map(lambda t: get_json(f"{ESPN}/teams/{t['id']}/roster"), teams))
    team_out, players = {}, {}
    for t, roster in zip(teams, rosters):
        logos = {tuple(sorted(l.get("rel", []))): l["href"] for l in t.get("logos", [])}
        team_out[t["abbreviation"]] = {
            "name": t["displayName"],
            "short": t.get("shortDisplayName") or t["name"],
            "logo": path(logos.get(("default", "full"))),
            "logoDark": path(logos.get(("dark", "full"))),
        }
        for a in roster.get("athletes", []):
            players[key(a["displayName"])] = {
                "id": a["id"],
                "team": t["abbreviation"],
                "teamId": t["id"],
                "headshot": path((a.get("headshot") or {}).get("href")),
            }
    return team_out, players


def espn_standings():
    """{abbr: record, seed, conference, streak, last 10, home/road, points per game for/against}."""
    out = {}
    for conf in get_json(f"{ESPN_V2}/standings")["children"]:
        short = "East" if "East" in conf["name"] else "West"
        for e in conf["standings"]["entries"]:
            s = {x["name"]: x.get("displayValue") for x in e["stats"]}
            out[e["team"]["abbreviation"]] = {
                "record": s.get("overall"), "seed": s.get("playoffSeed"), "conf": short,
                "streak": s.get("streak"), "last10": s.get("Last Ten Games"),
                "home": s.get("Home"), "road": s.get("Road"), "gb": s.get("gamesBehind"),
                "ppg": s.get("avgPointsFor"), "oppg": s.get("avgPointsAgainst"), "diff": s.get("differential"),
                "games": int(s.get("wins") or 0) + int(s.get("losses") or 0),
            }
    return out


def espn_injuries():
    """{athlete id: status, note, injury, expected return} for everyone on ESPN's injury report."""
    out = {}
    for team in get_json(f"{ESPN}/injuries").get("injuries", []):
        for i in team.get("injuries", []):
            href = ((i.get("athlete") or {}).get("links") or [{}])[0].get("href", "")
            m = re.search(r"/id/(\d+)", href)
            if not m:
                continue
            d = i.get("details") or {}
            out[m.group(1)] = {
                "status": i.get("status"),
                "note": i.get("shortComment"),
                "injury": " ".join(x for x in (d.get("side") if d.get("side") not in (None, "Not Specified") else None, d.get("type")) if x),
                "returns": d.get("returnDate"),
            }
    return out


def espn_gamelog(athlete_id, team_id):
    """Last regular-season game (opponent, result, stat line) and season averages."""
    d = get_json(f"{ESPN_WEB}/athletes/{athlete_id}/gamelog")
    labels = d.get("labels", [])
    regular = next((s for s in d.get("seasonTypes", []) if "Regular" in s.get("displayName", "")), None)
    if not regular:
        return None
    lines = {}
    for cat in regular.get("categories", []):
        for g in cat.get("events", []):
            lines[g["eventId"]] = dict(zip(labels, g["stats"]))
    if not lines:
        return None
    events = d.get("events", {})
    last_id = max(lines, key=lambda i: events.get(i, {}).get("gameDate", ""))
    ev = events.get(last_id, {})
    home = str(ev.get("homeTeamId")) == str(team_id)
    own, opp = (ev.get("homeTeamScore"), ev.get("awayTeamScore")) if home else (ev.get("awayTeamScore"), ev.get("homeTeamScore"))
    avg = next((s["stats"] for s in (regular.get("summary") or {}).get("stats", []) if s.get("type") == "avg"), None)
    keep = ("MIN", "PTS", "REB", "AST", "STL", "BLK", "TO", "FG", "3PT", "FT")
    return {
        "gp": len(lines),
        "last": {
            "date": ev.get("gameDate"),
            "home": home,
            "opp": (ev.get("opponent") or {}).get("abbreviation"),
            "oppName": (ev.get("opponent") or {}).get("displayName"),
            "oppLogo": path((ev.get("opponent") or {}).get("logo")),
            "result": ev.get("gameResult"),
            "score": f"{own}–{opp}" if own and opp else ev.get("score"),
            "line": {k: lines[last_id].get(k) for k in keep},
        },
        "avg": {k: v for k, v in zip(labels, avg) if k in ("MIN", "PTS", "REB", "AST", "FG%", "3P%")} if avg else None,
    }


# --- Sportsbooks ------------------------------------------------------------

def american_to_decimal(a):
    a = int(str(a).replace("+", ""))
    return round(1 + a / 100, 2) if a > 0 else round(1 + 100 / -a, 2)


def draftkings():
    """DraftKings' MVP odds from ESPN's futures feed, as {ESPN athlete id: decimal odds}."""
    data = get_json(f"{ESPN_CORE}/seasons/{ESPN_SEASON}/futures", {"limit": 100})
    mvp = next((f for f in data.get("items", []) if f.get("name") == "NBA - Regular Season MVP"), None)
    if not mvp:
        raise RuntimeError("no 'NBA - Regular Season MVP' future")
    out = {}
    for prov in mvp.get("futures", []):
        if prov.get("provider", {}).get("name") != "DraftKings":
            continue
        for b in prov.get("books", []):
            m = re.search(r"/athletes/(\d+)", (b.get("athlete") or {}).get("$ref", ""))
            if m and b.get("value"):
                out[m.group(1)] = american_to_decimal(b["value"])
    if not out:
        raise RuntimeError("DraftKings has no MVP prices")
    return out


def unibet():
    """Unibet's MVP odds from Kambi's public feed, as {player key: decimal odds}."""
    listing = get_json(f"{KAMBI}/listView/basketball/nba/all/all/competitions.json", KAMBI_PARAMS)
    event = next((e["event"] for e in listing.get("events", [])
                  if "most valuable player" in e["event"].get("name", "").lower()), None)
    if not event:
        raise RuntimeError("no Unibet MVP market")
    data = get_json(f"{KAMBI}/betoffer/event/{event['id']}.json", KAMBI_PARAMS)
    out = {}
    for bo in data.get("betOffers", []):
        if "mvp" not in bo.get("criterion", {}).get("englishLabel", "").lower():
            continue
        for o in bo.get("outcomes", []):
            if o.get("status") == "OPEN" and o.get("odds"):
                out[key(o.get("participant") or o["label"])] = round(o["odds"] / 1000, 2)
    if not out:
        raise RuntimeError("Unibet has no open MVP prices")
    return out


# --- Build ------------------------------------------------------------------

def fill(series, dates):
    """Align a {date: price} series to the date axis, carrying the last price forward."""
    out, last = [], None
    for d in dates:
        last = series.get(d, last)
        out.append(None if last is None else round(last, 4))
    return out


def mean(values):
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def main():
    sources = {}
    current = {}
    for name, fn in (("kalshi", kalshi_current), ("polymarket", polymarket_current)):
        try:
            current[name] = fn()
            sources[name] = {"ok": True, "history": False, "note": None}
        except Exception as e:  # one market down must not take the page down
            current[name] = {}
            sources[name] = {"ok": False, "history": False, "note": f"{type(e).__name__}: {e}"}
            print(f"{name}: FAILED {e}", file=sys.stderr)
    if not current["kalshi"] and not current["polymarket"]:
        sys.exit("Both markets failed; data.json not updated.")

    players = {}
    for src, rows in current.items():
        for k, row in rows.items():
            pl = players.setdefault(k, {"key": k, "name": row["name"], "ids": {}, "now": {}})
            pl["ids"][src] = row["id"]
            pl["now"][src] = row["p"]
            if not row["name"].isascii():
                pl["name"] = row["name"]  # keep the spelling with diacritics
    for pl in players.values():
        pl["avg"] = mean(pl["now"].values())
    ranked = sorted(players.values(), key=lambda pl: -pl["avg"])
    tracked = [pl for pl in ranked if pl["avg"] >= HISTORY_MIN]

    # History
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    hist = {"kalshi": {}, "polymarket": {}}
    opens = [r["open"] for r in current["kalshi"].values() if r.get("open")]
    start = int(datetime.fromisoformat(min(opens).replace("Z", "+00:00")).timestamp()) if opens \
        else int((datetime.now(timezone.utc) - timedelta(days=365)).timestamp())
    tickers = [pl["ids"]["kalshi"] for pl in tracked if "kalshi" in pl["ids"]]
    if tickers:
        try:
            by_ticker = kalshi_history(tickers, start)
            for pl in tracked:
                if "kalshi" in pl["ids"]:
                    hist["kalshi"][id(pl)] = by_ticker.get(pl["ids"]["kalshi"], {})
            sources["kalshi"]["history"] = True
        except Exception as e:
            sources["kalshi"]["note"] = f"history: {type(e).__name__}: {e}"
            print(f"kalshi history: FAILED {e}", file=sys.stderr)
    for pl in tracked:
        if "polymarket" not in pl["ids"]:
            continue
        try:
            hist["polymarket"][id(pl)] = polymarket_history(pl["ids"]["polymarket"])
            sources["polymarket"]["history"] = True
        except Exception as e:  # e.g. clob.polymarket.com blocked: stop after the first failure
            sources["polymarket"]["note"] = f"history: {type(e).__name__}: {e}"
            print(f"polymarket history: FAILED {e}", file=sys.stderr)
            break

    # Today's point is the live price, so the chart ends where the table is.
    for src in hist:
        for pl in tracked:
            if id(pl) in hist[src] and src in pl["now"]:
                hist[src][id(pl)][today] = pl["now"][src]

    first = min((d for src in hist.values() for s in src.values() for d in s), default=today)
    dates, d = [], datetime.fromisoformat(first)
    while (ds := d.strftime("%Y-%m-%d")) <= today:
        dates.append(ds)
        d += timedelta(days=1)

    def optional(name, fn, default):
        try:
            value = fn()
            sources[name] = {"ok": True, "note": None}
            return value
        except Exception as e:  # extras are nice-to-have; prices still publish
            sources[name] = {"ok": False, "note": f"{type(e).__name__}: {e}"}
            print(f"{name}: FAILED {e}", file=sys.stderr)
            return default

    teams, roster = optional("espn", espn, ({}, {}))
    standings = optional("standings", espn_standings, {})
    injuries = optional("injuries", espn_injuries, {})
    dk = optional("draftkings", draftkings, {})
    ub = optional("unibet", unibet, {})

    # Game logs: one ESPN call per player, so only for players at HISTORY_MIN or more.
    def gamelog(k):
        try:
            return k, espn_gamelog(roster[k]["id"], roster[k]["teamId"])
        except Exception as e:
            print(f"gamelog {k}: FAILED {e}", file=sys.stderr)
            return k, None
    with ThreadPoolExecutor(8) as ex:
        logs = dict(ex.map(gamelog, [pl["key"] for pl in tracked if pl["key"] in roster]))
    sources["gamelogs"] = {"ok": any(logs.values()), "note": None}

    out_players = []
    for pl in ranked:
        row = {
            "name": pl["name"],
            "avg": pl["avg"],
            "kalshi": round(pl["now"]["kalshi"], 4) if "kalshi" in pl["now"] else None,
            "polymarket": round(pl["now"]["polymarket"], 4) if "polymarket" in pl["now"] else None,
        }
        info = roster.get(pl["key"])
        row["books"] = {
            "draftkings": dk.get(info["id"]) if info else None,
            "unibet": ub.get(pl["key"]),
        }
        if info:
            row["team"] = info["team"]
            row["headshot"] = info["headshot"]
            if info["id"] in injuries:
                row["status"] = injuries[info["id"]]  # absent = not on the injury report
            if logs.get(pl["key"]):
                row["games"] = logs[pl["key"]]
        series = {src: fill(hist[src][id(pl)], dates) for src in hist if id(pl) in hist[src]}
        if series:
            avg = [mean(vals) for vals in zip(*series.values())]
            avg[-1] = pl["avg"]  # matches the table even when one market has no history
            row["history"] = {
                "avg": avg,
                "kalshi": series.get("kalshi"),
                "polymarket": series.get("polymarket"),
            }
        out_players.append(row)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "season": SEASON,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": sources,
        "teams": {p["team"]: {**teams[p["team"]], **standings.get(p["team"], {})}
                  for p in out_players if p.get("team")},
        "dates": dates,
        "players": out_players,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    top = ", ".join(f"{p['name']} {p['avg']:.0%}" for p in out_players[:3])
    print(f"Wrote {OUT} - {len(out_players)} players, {len(dates)} days. Top: {top}")


if __name__ == "__main__":
    main()
