# File: aso_check.py → ~/Projects/podiumnotes/tools/aso_check.py
#
# App Store token-competition checker. No dependencies, no account, no API key.
#
# WHAT THIS MEASURES — and what it does not.
#
# It queries Apple's public iTunes Search endpoint, which searches the same
# catalog as the App Store but ranks PURELY ON RELEVANCE. The live App Store
# weights popularity heavily on top of that. The practical consequence, proven
# against real data: Podium Notes is the #1 result here for "podium notes" and
# is buried several screens down in the actual store, because "notes" drags in
# Notability, GoodNotes and friends — apps that do not even appear in this
# endpoint's results.
#
# So: this tool answers "how many apps contain this token?" It cannot answer
# "where will I rank?" For that you need Apple Search Ads' popularity scores,
# or the live store after the version is indexed.
#
# The useful signal is a LOW count combined with a result list containing no
# household names. A low count full of apps with millions of installs is still
# a neighborhood you lose in.
#
# v2 fix: resultCount reports results RETURNED, not total matches. v1 passed
# limit=1 for token scoring, so every token reported "1 app — rare", including
# "notes". All lookups now request the API maximum.
#
# Usage:
#     python3 aso_check.py "podium pulpit"
#     python3 aso_check.py --tokens "podium pulpit" "lectern notes"
#     python3 aso_check.py --mine "Timothy Smith" "podium notes"

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://itunes.apple.com/search"
UA = "aso_check/2.0"
API_MAX = 200          # hard ceiling on this endpoint; counts saturate here


def search(term, country="us", limit=API_MAX):
    """Return (count, [(trackName, artistName), ...]) for one term.

    `count` saturates at `limit` — a value equal to it means "at least this
    many", not "exactly this many".
    """
    qs = urllib.parse.urlencode({
        "term": term,
        "entity": "software",
        "country": country,
        "limit": limit,
    })
    req = urllib.request.Request(f"{ENDPOINT}?{qs}", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            data = json.load(r)
    except Exception as e:
        return None, [("ERROR", str(e))]

    apps = [(a.get("trackName", "?"), a.get("artistName", "?"))
            for a in data.get("results", [])]
    return data.get("resultCount", 0), apps


def grade(count):
    if count is None:
        return "lookup failed"
    if count == 0:
        return "FREE — nothing in the store matches this token"
    if count >= API_MAX:
        return f"{API_MAX}+ (saturated) — heavily contested"
    if count <= 15:
        return "rare — a strong anchor"
    if count <= 60:
        return "uncommon — usable anchor"
    return "common — only safe when paired with a rare word"


def check_phrase(term, country, mine, show):
    count, apps = search(term, country)
    if count is None:
        print(f'\n"{term}"  LOOKUP FAILED: {apps[0][1]}')
        return

    cap = "+" if count >= API_MAX else ""
    print(f'\n"{term}"  →  {count}{cap} app(s) contain these tokens')
    print(f"  {grade(count)}")

    if count == 0:
        print("  once your app carries this, the phrase returns your app alone.")
        return

    for i, (name, artist) in enumerate(apps[:show], 1):
        flag = "  <- YOURS" if mine and mine.lower() in artist.lower() else ""
        print(f"  {i:2}. {name}  —  {artist}{flag}")

    if mine:
        hit = next((i for i, (_, a) in enumerate(apps, 1)
                    if mine.lower() in a.lower()), None)
        print(f"  your position here: "
              f"{hit if hit else 'not in ' + str(len(apps)) + ' results'}")
        print("  (relevance-only ranking — the live store will place you lower)")


def check_tokens(term, country):
    """Score each word on its own. This is where a spoken phrase lives or dies:
    one popular token is enough to bury you, however rare its partner is."""
    print(f'\n  token competition inside "{term}":')
    for word in term.split():
        count, _ = search(word, country)
        time.sleep(0.3)                      # be polite to a free endpoint
        shown = f"{count}+" if count and count >= API_MAX else str(count)
        print(f"    {word:<16} {shown:>5}   {grade(count)}")


def main():
    ap = argparse.ArgumentParser(
        description="Check how contested App Store search terms are.")
    ap.add_argument("terms", nargs="+", help="Phrases to test, each quoted")
    ap.add_argument("--tokens", action="store_true",
                    help="Also score each word of each phrase separately")
    ap.add_argument("--mine", default="",
                    help="Your developer name, to flag your own app in results")
    ap.add_argument("--country", default="us")
    ap.add_argument("--show", type=int, default=10,
                    help="How many matching apps to list (default 10)")
    args = ap.parse_args()

    for term in args.terms:
        check_phrase(term, args.country, args.mine, args.show)
        if args.tokens:
            check_tokens(term, args.country)
        time.sleep(0.4)

    print("\nCounts measure how many apps contain a token, never your rank.")
    print("A small count full of famous apps is still a fight you lose.")


if __name__ == "__main__":
    main()
