PDF KEYWORD SCANNER
===================

What it does
------------
Upload electrical / project PDFs, enter keywords, and get a structured report
where each keyword is an underlined heading followed ONLY by information actually
found in the PDFs — every line linked to its file name and page number.

It NEVER invents values. Voltages, ratings, cable sizes, IP ratings, fault levels,
ATS timings, manufacturers, standards, etc. are only shown if they appear in the
uploaded documents. If a keyword isn't found, it says:
  "No project-specific information found in uploaded documents."

How to run
----------
Double-click  "Start PDF Scanner.cmd".
It starts a small local server and opens http://localhost:8131 in your browser.
Everything runs on your PC — no files are uploaded anywhere. Close the black
window to stop it. (Requires Node.js, which is already installed on this PC.)

How to use
----------
1. LEFT pane  — drop PDFs in, or click "browse". Text is extracted automatically.
2. KEYWORDS   — one per line. A default "Electrical Distribution" group is loaded.
                FALLBACK CHAINS: use ">" to search a preferred term first and only
                fall back to a looser term if the preferred one isn't found, e.g.:
                    Automatic Transfer Switch > ATS
                    LV Distribution Equipment > Low Voltage Distribution
                (so the noisy "ATS" is only used when the full term is absent.)
                Add aliases below, one per line, e.g.:
                    LV = Low Voltage
                    Surge Arrestor = Surge Protection Device / SPD
                "Save group" stores your own keyword sets for next time.
3. SCAN PDFs  — searches every PDF for each keyword, its aliases, and (optional)
                built-in electrical synonyms. Findings are GROUPED PER KEYWORD and
                DE-DUPLICATED: repeated/near-identical mentions merge into one
                finding, with all the pages it appears on combined. Each shows
                match type (exact / alias / synonym), table-row detection and any
                equipment tags (e.g. ATS-01) seen nearby.
4. Click any blue page link — the PDF opens at that page with the match highlighted.
5. GENERATE REPORT — two modes:
       Summary  — a clean, organised bullet-point summary per keyword, written
                  by Claude (AI) using ONLY the extracted evidence. Each bullet
                  links to the source page so you can verify it. Needs an
                  Anthropic API key (entered once, stored only in this browser;
                  get one at console.anthropic.com -> API keys). The AI is given
                  only the quotes found in your PDFs and is forbidden from
                  inventing any value - so it cannot hallucinate ratings,
                  voltages, etc.
       Evidence — the raw de-duplicated quotes with page links and a
                  "Not found in uploaded documents" honesty note. NO key needed;
                  fully offline. Use this if you don't want to use AI at all.
   Export to Word (.doc), PDF (Print / Save-as-PDF), or Excel (.csv).

Notes
-----
- Works on text-based PDFs (specs, O&M manuals, schedules, datasheets, reports).
  Scanned image-only PDFs have no embedded text, so OCR would be needed (not built).
- A console handle `__scanner` is exposed for debugging (open DevTools).
