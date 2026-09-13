# Office Document Suite Architecture

## 1. Capabilities

The system supports bidirectional parsing and export across five core document types:

- **Word** (`docx`/`html`/`markdown`)
- **Sheets** (`xlsx`/`csv`/`formula evaluator`)
- **Decks** (`pptx`/`markdown`)
- **Calendar** (`ics`/`grid`/`zoned-time`)
- **Mail** (`eml`)

## 2. Format-Agnostic Invariants

All supported documents are parsed into **pure in-memory ASTs**. This decouples the document structure from the file format, allowing safe, unified processing prior to bidirectional export.

## 3. Memory/DoS Limits (Defensive Normalization)

We use strict clamping normalizers (e.g., `clampText`, `clampStringArray` up to `OFFICE_MODEL_LIMITS` found in `src/shared/office/officeModels.ts` and `graphMappers.ts`).

> [!IMPORTANT]
> **Invariant:** Corrupt, malformed, or malicious document structures must degrade safely to empty segments instead of crashing the host or renderer, preventing out-of-memory (OOM) or Denial of Service (DoS) attacks.

## 4. Excel Math Semantics (`src/shared/office/sheetFormula.ts`)

The internal sheet formula evaluator strictly adheres to Excel math semantics.
Specific behaviors:

- Unary minus binds tighter than exponentiation (e.g., `-2^2 = 4`).
- Range aggregation functions (like `SUM`) skip text cells.
- Calculation errors surface as standard Excel-style strings (e.g., `#DIV/0!`, `#VALUE!`).

## 5. Auto-Route Formats (`src/shared/office/officeFormats.ts`)

The routing mechanism (`shouldAutoRouteToOffice`) automatically routes binary and structured formats (`docx`, `xlsx`, `pptx`, `ics`, `eml`) to the Office Document UI.

> [!NOTE]
> Plain text or loosely structured formats like `md` and `csv` are explicitly excluded from this auto-routing and remain in the standard code editor.
