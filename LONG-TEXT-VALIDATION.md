# Long-text validation — personal/parse-cache

Date: 2026-10-02. Baseline: upstream v1.4.0 and the existing personal timeout/defaults branch.

## Regression checks

Run `npm run test:parse-cache` (Node 24). All 20 tests pass. Coverage includes independent state refresh and targeted review invalidation, racing broadcasts, hashed account/server scopes, concurrent paragraph requests, failed responses, disk restoration under memory pressure, forced clearing during pending requests, cancellation of old page waits, bounded priority dispatch, and the real API-wrapper/Parser conversion chain.

Run ESLint on changed TypeScript files, and `npm run build chrome`. Both pass. Full `npm run typecheck` still reports upstream errors; comparing normalized diagnostic lines with `TYPECHECK-UPSTREAM.txt` shows no new diagnostics. Broadcast schema updates remove some existing errors.

## Browser checks

An isolated, headless installed Chrome profile runs a local Ttsu-style fixture. The Browser plugin was unavailable, so verification uses bundled Playwright. The fixture imports the real `TtsuParagraphReader`, `TtsuTextHighlighter`, `TtsuParseScheduler`, `ParseCache` and `IndexedDbContentStorage`. Vocabulary API responses and Registry event wiring are simulated; the user's browser profile, account and books are not accessed.

| Check | Observed result |
| --- | --- |
| Initial visible batch | 2 of 60 mounted paragraphs, 850 UTF-8 bytes |
| Idle prefetch | A small background batch follows visible rendering |
| Chapter 1 → 2 → 1 | No repeated parse request for chapter 1's cached visible paragraphs |
| Horizontal column navigation | Newly visible text renders with real highlighter |
| Vertical column scrolling | Newly visible paragraphs render |
| Normalized dictionary | 13 paragraphs share one dictionary record; reference counts match |
| Browser process restart | Persistent marker restores without parsing; one vocabulary-state lookup |
| Disk limit forced to 3500 bytes | LRU retains 6 paragraphs / 3241 estimated bytes, with correct dictionary references |
| Errors | No fixture page errors or scheduler errors |

Local harness, reports and screenshots are grouped in `../验证/`, outside the source tree. Screenshots are checked for visible content and unexpected overlays. Background prefetch does not apply highlighting until text becomes visible.

## User acceptance remaining

Reload the unpacked extension from `jiten.reader`, refresh Ttsu, then test first visible text, page turns, chapter return, a vocabulary review and a browser restart. Cached paragraphs should not invoke `reader/parse`; invalidated or stale account state may invoke `reader/lookup-vocabulary`. This local verification cannot establish live Jiten latency, account behavior or compatibility with every EPUB layout.

Paragraph boundaries are retained: a paragraph spanning several visible pages is submitted whole; a single oversized paragraph may exceed the batch target. In paginated Ttsu only the current chapter is mounted, so idle prefetch covers upcoming text in that chapter. Cache persistence is bounded by browser quota and LRU, rather than a promise to retain every book forever.
