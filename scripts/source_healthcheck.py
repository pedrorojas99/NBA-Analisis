#!/usr/bin/env python3
"""Non-destructive NBA source probe.

This first ingestion milestone checks source availability and captures raw
payloads for inspection. It does not claim permanent database storage.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

TIMEOUT_SECONDS = 20
USER_AGENT = "NBA-Analytics-DataProbe/0.1 (+https://github.com/pedrorojas99/NBA-Analisis)"
SOURCES = {
    "espn_scoreboard": "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
    "nba_com_live_scoreboard": "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json",
}


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        body = response.read()
        return {
            "http_status": response.status,
            "content_type": response.headers.get("Content-Type", ""),
            "body": json.loads(body.decode("utf-8")),
        }


def summarize_espn(payload: dict) -> list[dict]:
    games = []
    for event in payload.get("events", []):
        competition = (event.get("competitions") or [{}])[0]
        competitors = competition.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), {})
        away = next((c for c in competitors if c.get("homeAway") == "away"), {})
        status = competition.get("status") or event.get("status") or {}
        status_type = status.get("type") or {}
        games.append({
            "source": "espn",
            "source_game_id": event.get("id"),
            "start_time_utc": event.get("date"),
            "status": status_type.get("state"),
            "status_detail": status_type.get("detail"),
            "completed": status_type.get("completed", False),
            "home_team": (home.get("team") or {}).get("abbreviation"),
            "away_team": (away.get("team") or {}).get("abbreviation"),
            "home_score": home.get("score"),
            "away_score": away.get("score"),
        })
    return games


def main() -> int:
    captured_at = datetime.now(timezone.utc).isoformat()
    result = {
        "schema_version": 1,
        "captured_at_utc": captured_at,
        "purpose": "source_health_probe_not_production_database",
        "sources": {},
        "games": [],
    }

    for name, url in SOURCES.items():
        try:
            data = fetch_json(url)
            result["sources"][name] = {
                "ok": True,
                "http_status": data["http_status"],
                "content_type": data["content_type"],
            }
            if name == "espn_scoreboard":
                result["games"] = summarize_espn(data["body"])
                result["sources"][name]["event_count"] = len(result["games"])
            # Preserve the complete payload as a dated raw capture for schema review.
            raw_dir = Path("data/raw")
            raw_dir.mkdir(parents=True, exist_ok=True)
            (raw_dir / f"{name}.json").write_text(
                json.dumps(data["body"], ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except urllib.error.HTTPError as exc:
            result["sources"][name] = {
                "ok": False,
                "http_status": exc.code,
                "error": "HTTP error from upstream; no bypass attempted",
            }
        except Exception as exc:  # noqa: BLE001 - report source failures in probe
            result["sources"][name] = {
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }

    Path("data").mkdir(exist_ok=True)
    Path("data/source_health.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({
        "captured_at_utc": captured_at,
        "sources": result["sources"],
        "games_detected": len(result["games"]),
        "output": "data/source_health.json",
    }, ensure_ascii=False, indent=2))

    # ESPN is the currently selected operational source. NBA.com may be
    # temporarily unavailable; its failure is recorded rather than hidden.
    return 0 if result["sources"].get("espn_scoreboard", {}).get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
