# tidy_notes.py

Files, cleans, merges and summarises loose notes in an OpenJarvis vault.

Runs locally. Note content goes only to your own Ollama daemon on
`localhost:11434` and never leaves the machine. Python 3.9+, no dependencies.

## Use

```bash
python3 tidy_notes.py inspect      # read-only: what did it find?
python3 tidy_notes.py run          # dry run: what would change?
python3 tidy_notes.py run --apply  # write
```

The vault defaults to `$OPENJARVIS_HOME` or `~/.openjarvis`. Override with
`--root /path/to/vault`.

## What it does

1. **Reads and cleans** — each loose note goes to the local model, which fixes
   typos, punctuation and line breaks, and returns a title, category, tags and a
   one-line summary. The prompt forbids inventing facts; a note that comes back
   empty or unparseable keeps its original text.
2. **Merges duplicates** — near-identical notes are grouped by text similarity
   (`--similarity`, default `0.75`; raise it to merge less) and combined so no
   unique detail is lost.
3. **Files** — writes `vault/<category>/<slug>.md` with YAML frontmatter.
4. **Summarises** — writes `vault/TIDY-REPORT.md` listing every note by category.

## Safety

- Dry run by default; `--apply` is required to write anything.
- A tarball of every note is written to `_tidy_backup/` before the first write.
- Originals are **moved to `_archive/<timestamp>/`, never deleted.** To undo, move
  them back and delete the new `vault/` files.
- If Ollama is unreachable the script still files and groups notes, but does no
  rewriting — it will not silently mangle text it could not process.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--root` | `~/.openjarvis` | Vault location |
| `--apply` | off | Actually write |
| `--model` | auto-detect | Ollama model to use |
| `--similarity` | `0.75` | Duplicate threshold, 0–1 |
| `--timeout` | `180` | Seconds per model call |
| `--limit` | all | Only process the first N notes |

## If it finds nothing

`inspect` reports any SQLite databases it sees. OpenJarvis builds vary, and if
yours stores notes in a database rather than as files, this script won't find
them — the `inspect` output will say so.
