# File: voice_eval.py → ~/Projects/podiumnotes/tools/voice_eval.py
#
# Supertonic voice audition rig — Mac only, no iOS work required.
#
# Renders the SAME speech through several Supertonic voice styles so you can
# put them all on the phone and judge them in the car, which is the only
# listening environment that actually matters for this app.
#
# Setup (once):
#     python3 -m venv ~/.venvs/supertonic
#     source ~/.venvs/supertonic/bin/activate
#     pip install supertonic soundfile numpy
#
# Usage:
#     python voice_eval.py speech.txt
#     python voice_eval.py speech.txt --voices F1 F2 M1 --speed 0.95
#     python voice_eval.py speech.txt --steps 12 --m4a
#
# Notes:
#   • First run downloads model assets from Hugging Face (auto_download).
#     If you've already mirrored them locally, that clone is your backup —
#     the upstream repo is being archived.
#   • Text is chunked by blank-line paragraph, exactly like SpeechPlayerModule
#     does today, so what you hear matches what the app would produce.
#   • --m4a uses macOS's built-in afconvert; handy for AirDropping to the
#     phone without a 44.1kHz WAV per voice eating your storage.

import argparse
import os
import re
import subprocess
import sys
import time

SAMPLE_RATE = 44100          # Supertonic outputs 44.1kHz
PARA_GAP_SEC = 0.35          # matches utterance.postUtteranceDelay in the app


MAX_CHUNK_CHARS = 900   # keep any single synthesize() call reasonable

# Supertonic validates its input charset and RAISES on anything outside it,
# rather than ignoring it — so one stray typographic character kills the whole
# render. Notes exported from Apple Notes / Word routinely carry these.
#
# Dashes become commas because that is what they mean out loud: a pause. A
# literal "-" tends to be read as the word "dash" or swallowed entirely.
CHAR_MAP = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",   # single quotes
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',   # double quotes
    "\u2032": "'", "\u2033": '"',                                  # prime marks
    "\u2026": "...",                                                # ellipsis
    "\u2014": ", ", "\u2015": ", ",                                 # em dash, horizontal bar
    "\u00A0": " ", "\u2007": " ", "\u202F": " ", "\u200B": "",     # exotic spaces
    "\u2022": "", "\u00B7": "", "\u25CF": "",                      # bullets
    "\u2E3B": "\n\n", "\u2E3A": "\n\n",                           # 3-em / 2-em dash dividers
    "\u00BD": " one half", "\u00BC": " one quarter", "\u00BE": " three quarters",
    "\u00B0": " degrees", "\u2122": "", "\u00AE": "", "\u00A9": "",
    "\u0301": "", "\u0300": "",                                    # stray combining accents
}


def sanitize(text):
    """Fold typographic characters down to what the model accepts.

    Returns (clean_text, dropped) where `dropped` counts any character that
    survived the map and had to be removed outright — those are worth seeing,
    since each one is a silent hole in the audio.
    """
    # En dash between digits is a range ("3-5" = "three to five"); elsewhere
    # it's just a pause, same as an em dash.
    text = re.sub(r"(?<=\d)\u2013(?=\d)", " to ", text)
    text = text.replace("\u2013", ", ")

    for src, dst in CHAR_MAP.items():
        if src in text:
            text = text.replace(src, dst)

    dropped = {}
    out = []
    for ch in text:
        if ord(ch) < 127 or ch in "\n\t":
            out.append(ch)
        else:
            dropped[ch] = dropped.get(ch, 0) + 1
    text = "".join(out)

    # Tidy the punctuation the dash substitutions can pile up.
    text = re.sub(r"[ \t]+,", ",", text)          # " — x" left " , x"
    text = re.sub(r",[ \t]*,+", ",", text)
    text = re.sub(r",\s*([.!?;:])", r"\1", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text, dropped


def load_paragraphs(path):
    """Split into synthesis chunks, tolerating either paragraph convention.

    Text pasted out of Notes often uses single newlines between paragraphs
    rather than blank lines. Splitting only on blank lines would then hand
    the entire speech to one synthesize() call — slow, memory-hungry, and
    nothing like what the app actually does per paragraph.
    """
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()

    raw, dropped = sanitize(raw)
    if dropped:
        detail = ", ".join(f"{repr(c)} x{n}" for c, n in dropped.items())
        print(f"  (removed {sum(dropped.values())} unsupported character(s): {detail})")

    # Preferred: blank-line paragraphs, same as the Swift module.
    parts = [p.strip() for p in re.split(r"\n\s*\n", raw) if p.strip()]

    # Fallback: the file uses single newlines, so blank-line splitting found
    # nothing to split on.
    if len(parts) <= 1 and raw.count("\n") > 2:
        parts = [ln.strip() for ln in raw.split("\n") if ln.strip()]
        print(f"  (no blank lines found — split on single newlines instead)")

    # Any remaining oversized chunk gets broken at sentence boundaries.
    chunks = []
    for p in parts:
        p = p.replace("\n", " ")
        if len(p) <= MAX_CHUNK_CHARS:
            chunks.append(p)
            continue
        buf = ""
        for sentence in re.split(r"(?<=[.!?])\s+", p):
            if buf and len(buf) + len(sentence) + 1 > MAX_CHUNK_CHARS:
                chunks.append(buf.strip())
                buf = sentence
            else:
                buf = f"{buf} {sentence}".strip()
        if buf.strip():
            chunks.append(buf.strip())
    return chunks


def render_voice(tts, np, voice_name, paragraphs, lang, steps, speed):
    """Render every paragraph with one voice, joined by a short gap."""
    style = tts.get_voice_style(voice_name=voice_name)
    gap = np.zeros(int(SAMPLE_RATE * PARA_GAP_SEC), dtype=np.float32)

    pieces = []
    started = time.time()
    for i, para in enumerate(paragraphs, 1):
        wav, _ = tts.synthesize(
            text=para,
            lang=lang,
            voice_style=style,
            total_steps=steps,
            speed=speed,
        )
        pieces.append(np.asarray(wav, dtype=np.float32).squeeze())
        if i < len(paragraphs):
            pieces.append(gap)
        print(f"    paragraph {i}/{len(paragraphs)}", end="\r", flush=True)

    audio = np.concatenate(pieces) if pieces else np.zeros(1, dtype=np.float32)
    return audio, time.time() - started


def to_m4a(wav_path):
    """macOS-native AAC conversion — much smaller for phone transfer."""
    m4a_path = os.path.splitext(wav_path)[0] + ".m4a"
    try:
        subprocess.run(
            ["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000",
             wav_path, m4a_path],
            check=True, capture_output=True,
        )
        return m4a_path
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"    (afconvert failed: {e})")
        return None


def main():
    ap = argparse.ArgumentParser(description="Audition Supertonic voices on real speech text.")
    ap.add_argument("text_file", help="Plain-text file — paragraphs separated by blank lines")
    ap.add_argument("--voices", nargs="+", default=["F1", "F2", "M1"],
                    help="Voice styles to render (presets are M1-M5, F1-F5)")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--speed", type=float, default=1.0,
                    help="0.7 (slow) to 2.0 (fast). 1.0 is natural pace.")
    ap.add_argument("--steps", type=int, default=8,
                    help="Quality: 5 (low) to 12 (high). Default 8.")
    ap.add_argument("--out", default="voice_eval_out")
    ap.add_argument("--m4a", action="store_true", help="Also write AAC copies for the phone")
    args = ap.parse_args()

    try:
        import numpy as np
        import soundfile as sf
        from supertonic import TTS
    except ImportError as e:
        sys.exit(f"Missing dependency: {e}\n"
                 f"Run: pip install supertonic soundfile numpy")

    paragraphs = load_paragraphs(args.text_file)
    if not paragraphs:
        sys.exit(f"No text found in {args.text_file}")

    words = sum(len(p.split()) for p in paragraphs)
    print(f"{args.text_file}: {len(paragraphs)} paragraphs, ~{words} words")
    print(f"Voices: {', '.join(args.voices)} | speed {args.speed} | steps {args.steps}\n")

    os.makedirs(args.out, exist_ok=True)

    print("Loading model (first run downloads from Hugging Face)…")
    tts = TTS(auto_download=True)

    results = []
    for voice in args.voices:
        print(f"  {voice}:")
        try:
            audio, elapsed = render_voice(tts, np, voice, paragraphs,
                                          args.lang, args.steps, args.speed)
        except Exception as e:
            print(f"    FAILED: {e}")
            continue

        stem = f"{os.path.splitext(os.path.basename(args.text_file))[0]}__{voice}"
        wav_path = os.path.join(args.out, stem + ".wav")
        sf.write(wav_path, audio, SAMPLE_RATE)

        dur = len(audio) / SAMPLE_RATE
        rtf = elapsed / dur if dur else 0
        print(f"    {dur/60:.1f} min audio in {elapsed:.1f}s  (RTF {rtf:.2f}x)   {wav_path}")

        if args.m4a:
            m4a = to_m4a(wav_path)
            if m4a:
                print(f"    → {m4a}")
        results.append((voice, dur))

    if results:
        print(f"\nDone. {len(results)} file(s) in {os.path.abspath(args.out)}/")
        print("AirDrop them to the phone and listen somewhere with road noise —")
        print("the differences that survive a car are the ones that matter.")


if __name__ == "__main__":
    main()
