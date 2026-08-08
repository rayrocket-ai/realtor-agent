#!/usr/bin/env python3
"""
tidy_notes.py — file, clean, merge and summarise loose notes in an OpenJarvis vault.

Runs entirely on your own machine. Note content is sent only to your local
Ollama daemon (http://localhost:11434) and never leaves the computer.

Usage
-----
    python3 tidy_notes.py inspect                 # read-only: what did I find?
    python3 tidy_notes.py run                     # dry run: what would change?
    python3 tidy_notes.py run --apply             # actually write

Nothing is deleted, ever. Originals are archived, and a full tarball backup is
taken before the first write.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tarfile
import textwrap
import unicodedata
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

NOTE_SUFFIXES = {".md", ".markdown", ".txt", ".text"}
DB_SUFFIXES = {".db", ".sqlite", ".sqlite3"}
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "models",
    ".cache", "logs", "_archive", "_tidy_backup",
}
REPORT_NAME = "TIDY-REPORT.md"
SKIP_FILES = {REPORT_NAME, "README.md"}
OLLAMA = "http://localhost:11434"
FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


# ─────────────────────────────── data ────────────────────────────────────────

@dataclass
class Note:
    path: Path
    raw: str
    body: str
    frontmatter: str
    # filled in by the enrich pass
    title: str = ""
    category: str = "unsorted"
    tags: list[str] = field(default_factory=list)
    summary: str = ""
    cleaned: str = ""
    enriched: bool = False

    @property
    def is_loose(self) -> bool:
        """A note is 'filed' if it carries frontmatter with a category or tags."""
        fm = self.frontmatter.lower()
        return not ("category:" in fm or "tags:" in fm)

    @property
    def norm(self) -> str:
        """Normalised text used for near-duplicate comparison."""
        t = unicodedata.normalize("NFKD", self.body.lower())
        return re.sub(r"[^a-z0-9\s]", " ", re.sub(r"\s+", " ", t)).strip()


# ────────────────────────────── discovery ────────────────────────────────────

def vault_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("OPENJARVIS_HOME")
    return Path(env).expanduser().resolve() if env else Path.home() / ".openjarvis"


def split_frontmatter(raw: str) -> tuple[str, str]:
    m = FRONTMATTER.match(raw)
    return (m.group(1), raw[m.end():]) if m else ("", raw)


def scan(root: Path, limit: int | None = None) -> tuple[list[Note], list[Path]]:
    """Walk the vault collecting note files and any sqlite databases."""
    notes: list[Note] = []
    dbs: list[Path] = []
    if not root.exists():
        return notes, dbs

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            p = Path(dirpath) / name
            suffix = p.suffix.lower()
            if suffix in DB_SUFFIXES:
                dbs.append(p)
                continue
            if suffix not in NOTE_SUFFIXES or name in SKIP_FILES:
                continue
            try:
                raw = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if not raw.strip():
                continue
            fm, body = split_frontmatter(raw)
            notes.append(Note(path=p, raw=raw, body=body.strip(), frontmatter=fm))
            if limit and len(notes) >= limit:
                return notes, dbs
    return notes, dbs


def probe_databases(dbs: list[Path]) -> list[str]:
    """Report note-ish tables so a DB-backed vault is not silently missed."""
    out: list[str] = []
    for db in dbs:
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            names = [r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")]
            con.close()
        except sqlite3.Error as exc:
            out.append(f"{db.name}: unreadable ({exc})")
            continue
        hits = [n for n in names if re.search(r"note|memor|vault|doc|chunk", n, re.I)]
        if hits:
            out.append(f"{db}: {', '.join(hits)}")
    return out


# ─────────────────────────────── ollama ──────────────────────────────────────

def ollama_models() -> list[str]:
    try:
        with urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=5) as r:
            return [m["name"] for m in json.load(r).get("models", [])]
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return []


def pick_model(preferred: str | None) -> str | None:
    available = ollama_models()
    if not available:
        return None
    if preferred:
        # allow bare names to match a tagged model, e.g. "qwen3.5" -> "qwen3.5:2b"
        for m in available:
            if m == preferred or m.split(":")[0] == preferred.split(":")[0]:
                return m
        return None
    for want in ("qwen", "llama", "mistral", "phi", "gemma"):
        for m in available:
            if want in m.lower():
                return m
    return available[0]


def generate(model: str, prompt: str, timeout: int) -> str | None:
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2},
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate", data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r).get("response", "")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"    ! model call failed: {exc}", file=sys.stderr)
        return None


def parse_json(text: str) -> dict | None:
    """Small models wrap JSON in prose or fences; dig it out."""
    if not text:
        return None
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


ENRICH_PROMPT = """You are tidying a personal note. Return ONLY a JSON object.

Rules:
- Do NOT invent facts. Only use what the note says.
- "cleaned" must preserve every fact, name, number and link from the original.
  Fix spelling, punctuation, casing and line breaks. Keep it the same language.
- If the note is a fragment, keep it a fragment. Do not pad it out.
- "category" is one or two lowercase words, e.g. "work", "ideas", "shopping".

JSON shape:
{"title": "short title, max 8 words",
 "category": "lowercase category",
 "tags": ["two", "to", "four", "lowercase", "tags"],
 "summary": "one sentence, max 20 words",
 "cleaned": "the corrected note text"}

NOTE:
---
%s
---
JSON:"""

MERGE_PROMPT = """Merge these near-duplicate notes into one. Return ONLY a JSON object.

Rules:
- Keep every unique fact from every version. Lose nothing.
- Remove only repetition.
- Do NOT invent anything not present in the inputs.

JSON shape:
{"title": "short title", "merged": "the combined note text"}

NOTES:
%s
JSON:"""


# ──────────────────────────────── passes ─────────────────────────────────────

def slugify(text: str, fallback: str) -> str:
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    s = re.sub(r"[^\w\s-]", "", s).strip().lower()
    s = re.sub(r"[\s_-]+", "-", s)[:60].strip("-")
    return s or fallback


def heuristic_enrich(note: Note) -> None:
    """Used when no model is reachable: title from first line, no rewriting."""
    first = next((l.strip() for l in note.body.splitlines() if l.strip()), "note")
    note.title = re.sub(r"^#+\s*", "", first)[:60]
    note.summary = textwrap.shorten(note.body.replace("\n", " "), 100, placeholder="…")
    note.cleaned = note.body
    note.category = "unsorted"
    note.tags = []


def enrich(notes: list[Note], model: str | None, timeout: int) -> None:
    for i, note in enumerate(notes, 1):
        label = note.path.name
        if not model:
            heuristic_enrich(note)
            continue
        print(f"  [{i}/{len(notes)}] {label}")
        data = parse_json(generate(model, ENRICH_PROMPT % note.body[:6000], timeout) or "")
        if not data or not str(data.get("cleaned", "")).strip():
            print(f"    · model gave nothing usable, keeping original")
            heuristic_enrich(note)
            continue
        note.title = str(data.get("title") or "").strip()[:80]
        note.category = slugify(str(data.get("category") or "unsorted"), "unsorted")
        raw_tags = data.get("tags") or []
        note.tags = [slugify(str(t), "") for t in raw_tags if str(t).strip()][:5]
        note.summary = str(data.get("summary") or "").strip()
        note.cleaned = str(data["cleaned"]).strip()
        note.enriched = True
        if not note.title:
            note.title = note.path.stem.replace("-", " ").replace("_", " ")[:80]


def cluster_duplicates(notes: list[Note], threshold: float) -> list[list[Note]]:
    """Greedy single-link clustering on normalised text similarity."""
    groups: list[list[Note]] = []
    for note in notes:
        if not note.norm:
            groups.append([note])
            continue
        for g in groups:
            if any(SequenceMatcher(None, note.norm, o.norm).ratio() >= threshold
                   for o in g if o.norm):
                g.append(note)
                break
        else:
            groups.append([note])
    return groups


def merge_group(group: list[Note], model: str | None, timeout: int) -> Note:
    lead = max(group, key=lambda n: len(n.cleaned))
    if len(group) == 1:
        return lead
    if model:
        blob = "\n".join(f"--- version {i} ---\n{n.cleaned[:3000]}"
                         for i, n in enumerate(group, 1))
        data = parse_json(generate(model, MERGE_PROMPT % blob, timeout) or "")
        if data and str(data.get("merged", "")).strip():
            lead.cleaned = str(data["merged"]).strip()
            lead.title = str(data.get("title") or lead.title).strip()[:80] or lead.title
    else:
        # no model: concatenate rather than risk losing a unique detail
        lead.cleaned = "\n\n---\n\n".join(n.cleaned for n in group)
    seen: list[str] = []
    for n in group:
        for t in n.tags:
            if t not in seen:
                seen.append(t)
    lead.tags = seen[:6]
    return lead


# ──────────────────────────────── output ─────────────────────────────────────

def render(note: Note, sources: list[Note]) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    tags = "[" + ", ".join(note.tags) + "]" if note.tags else "[]"
    lines = [
        "---",
        f"title: {json.dumps(note.title or note.path.stem)}",
        f"category: {note.category}",
        f"tags: {tags}",
        f"filed: {stamp}",
        "filed_by: tidy_notes.py",
    ]
    if note.summary:
        lines.append(f"summary: {json.dumps(note.summary)}")
    for s in sources:
        lines.append(f"  - {s.path.name}")
    if sources:
        lines.insert(len(lines) - len(sources), "merged_from:")
    lines += ["---", "", f"# {note.title or note.path.stem}", "", note.cleaned, ""]
    return "\n".join(lines)


def backup(root: Path, paths: list[Path]) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = root / "_tidy_backup" / f"notes-{stamp}.tar.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(dest, "w:gz") as tar:
        for p in paths:
            try:
                tar.add(p, arcname=str(p.relative_to(root)))
            except ValueError:
                tar.add(p, arcname=p.name)
    return dest


def write_report(root: Path, groups: list[list[Note]], leads: list[Note],
                 model: str | None, applied: bool) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    by_cat: dict[str, list[Note]] = {}
    for n in leads:
        by_cat.setdefault(n.category, []).append(n)

    out = [
        "# Loose notes — tidy report",
        "",
        f"Generated {stamp} by `tidy_notes.py`.",
        f"Model: {model or 'none (heuristics only — no rewriting was done)'}",
        f"Mode: {'APPLIED' if applied else 'DRY RUN (nothing written)'}",
        "",
        f"- Loose notes found: **{sum(len(g) for g in groups)}**",
        f"- After merging duplicates: **{len(leads)}**",
        f"- Categories: **{len(by_cat)}**",
        "",
        "## What's in them",
        "",
    ]
    for cat in sorted(by_cat):
        out.append(f"### {cat}")
        out.append("")
        for n in sorted(by_cat[cat], key=lambda x: x.title.lower()):
            out.append(f"- **{n.title or n.path.stem}** — {n.summary or '(no summary)'}")
        out.append("")

    dupes = [g for g in groups if len(g) > 1]
    if dupes:
        out += ["## Duplicates merged", ""]
        for g in dupes:
            names = ", ".join(f"`{n.path.name}`" for n in g)
            out.append(f"- {len(g)} notes merged: {names}")
        out.append("")
    return "\n".join(out)


# ───────────────────────────────── cli ───────────────────────────────────────

def cmd_inspect(args) -> int:
    root = vault_root(args.root)
    print(f"Vault root : {root}")
    if not root.exists():
        print("\n!! That directory does not exist.")
        print("   Pass the right one with --root /path/to/vault")
        return 1

    notes, dbs = scan(root)
    loose = [n for n in notes if n.is_loose]
    print(f"Note files : {len(notes)}  ({len(loose)} loose, {len(notes) - len(loose)} filed)")

    models = ollama_models()
    print(f"Ollama     : {', '.join(models) if models else 'not reachable on :11434'}")

    if dbs:
        print(f"\nDatabases  : {len(dbs)} found")
        for line in probe_databases(dbs):
            print(f"  · {line}")
        if not loose:
            print("\n  Your notes may live in a database rather than files.")
            print("  Send this output back and I'll adapt the script.")

    if loose:
        print(f"\nLoose notes (first 25 of {len(loose)}):")
        for n in loose[:25]:
            words = len(n.body.split())
            print(f"  {n.path.relative_to(root)}  ({words}w)")
    else:
        print("\nNo loose notes matched. Try --root, or send this output back.")
    return 0


def cmd_run(args) -> int:
    root = vault_root(args.root)
    if not root.exists():
        print(f"!! {root} does not exist. Pass --root /path/to/vault", file=sys.stderr)
        return 1

    notes, _ = scan(root, limit=args.limit)
    loose = [n for n in notes if n.is_loose]
    if not loose:
        print("No loose notes found. Run `inspect` to see what's there.")
        return 1

    model = pick_model(args.model)
    print(f"Vault : {root}")
    print(f"Loose : {len(loose)} notes")
    print(f"Model : {model or 'NONE — will file and merge, but not rewrite'}")
    if args.model and not model:
        print(f"        (requested '{args.model}' is not installed)")
    print()

    print("1/3 reading and cleaning…")
    enrich(loose, model, args.timeout)

    print("2/3 finding duplicates…")
    groups = cluster_duplicates(loose, args.similarity)
    leads = [merge_group(g, model, args.timeout) for g in groups]
    merged = sum(len(g) - 1 for g in groups)
    print(f"    {len(groups)} distinct notes ({merged} duplicates folded in)")

    print("3/3 filing…")
    plan: list[tuple[Note, Path, list[Note]]] = []
    used: set[Path] = set()
    for group, lead in zip(groups, leads):
        base = slugify(lead.title or lead.path.stem, lead.path.stem)
        dest = root / "vault" / lead.category / f"{base}.md"
        n = 2
        while dest in used or dest.exists():
            dest = dest.with_name(f"{base}-{n}.md")
            n += 1
        used.add(dest)
        plan.append((lead, dest, [x for x in group if x is not lead]))

    report = write_report(root, groups, leads, model, args.apply)

    if not args.apply:
        print("\n── DRY RUN — nothing written ──\n")
        for lead, dest, extra in plan:
            note = f"  {dest.relative_to(root)}"
            if extra:
                note += f"   (+{len(extra)} merged)"
            print(note)
        print(f"\n{len(plan)} files would be created.")
        print("Re-run with --apply to write them.")
        return 0

    tar = backup(root, [n.path for n in loose])
    print(f"    backup: {tar}")

    archive = root / "_archive" / datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    archive.mkdir(parents=True, exist_ok=True)

    for lead, dest, extra in plan:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(render(lead, extra), encoding="utf-8")
        for original in [lead] + extra:
            target = archive / original.path.name
            i = 2
            while target.exists():
                target = archive / f"{original.path.stem}-{i}{original.path.suffix}"
                i += 1
            shutil.move(str(original.path), str(target))

    report_path = root / "vault" / REPORT_NAME
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report, encoding="utf-8")

    print(f"\n  wrote   {len(plan)} notes under {root / 'vault'}")
    print(f"  archived originals to {archive}")
    print(f"  summary {report_path}")
    print("\nNothing was deleted. Undo: move files back from the archive above.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="File, clean, merge and summarise loose OpenJarvis notes.")
    ap.add_argument("--root", help="vault root (default: $OPENJARVIS_HOME or ~/.openjarvis)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("inspect", help="read-only report of what was found")

    run = sub.add_parser("run", help="tidy the notes (dry run unless --apply)")
    run.add_argument("--apply", action="store_true", help="actually write changes")
    run.add_argument("--model", help="ollama model (default: auto-detect)")
    run.add_argument("--similarity", type=float, default=0.75,
                     help="duplicate threshold 0-1 (default 0.75; raise to merge less)")
    run.add_argument("--timeout", type=int, default=180, help="per-model-call seconds")
    run.add_argument("--limit", type=int, help="only process the first N notes")

    args = ap.parse_args()
    return cmd_inspect(args) if args.cmd == "inspect" else cmd_run(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted — nothing further was written", file=sys.stderr)
        sys.exit(130)
