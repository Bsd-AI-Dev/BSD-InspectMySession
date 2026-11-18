function sourceItems(model) {
  const items = new Map();
  const source = entry => ({
    row: entry,
    files: [{
      ...entry,
      rawText: entry.text || '',
      lineNumbers: String(entry.text || '').split('\n').map((_, index) => index + 1)
    }]
  });
  for (const part of model.startLoad.parts) {
    items.set(part.ref, source(part));
    for (const item of part.items || []) items.set(item.ref, source(item));
  }
  for (const read of model.reads) {
    items.set(read.ref, { row: read, files: read.files || [] });
    for (const file of read.files || []) items.set(file.ref, { row: read, files: [file] });
  }
  return items;
}

function parseResult(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```json\s*([\s\S]*?)\s*```$/i);
  try { return JSON.parse(fenced ? fenced[1] : text); }
  catch { throw new Error('The fork returned invalid answer JSON.'); }
}

function normalizedMatch(source, quote) {
  const normalize = value => value.replaceAll(/\s+/g, ' ').trim();
  const wanted = normalize(quote);
  if (!wanted) return null;
  let normalized = '';
  const map = [];
  let inSpace = false;
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/.test(source[index])) {
      if (!inSpace && normalized) { normalized += ' '; map.push(index); }
      inSpace = true;
    } else {
      normalized += source[index];
      map.push(index);
      inSpace = false;
    }
  }
  const at = normalized.indexOf(wanted);
  if (at < 0) return null;
  const start = map[at];
  const end = (map[at + wanted.length - 1] ?? start) + 1;
  return { start, end, quote: source.slice(start, end) };
}

export function validateAskAnswer(raw, model, meta = {}) {
  const value = parseResult(raw);
  if (!value || typeof value.summary !== 'string' || !Array.isArray(value.citations)) {
    throw new Error('The fork answer has an invalid shape.');
  }
  const items = sourceItems(model);
  const order = new Map([...items.keys()].map((ref, index) => [ref, index]));
  const citations = [];
  for (const citation of value.citations.slice(0, 5)) {
    if (!citation || !items.has(citation.ref) || typeof citation.quote !== 'string') continue;
    if (!['copied', 'inferred'].includes(citation.kind) || typeof citation.explanation !== 'string') continue;
    const item = items.get(citation.ref);
    let file;
    let match;
    let matchedSource = '';
    for (const candidate of item.files) {
      const stripped = String(candidate.text || '');
      const raw = String(candidate.rawText ?? candidate.text ?? '');
      const exact = stripped.indexOf(citation.quote);
      match = exact >= 0
        ? { start: exact, end: exact + citation.quote.length, quote: citation.quote }
        : normalizedMatch(stripped, citation.quote);
      matchedSource = stripped;
      if (!match) {
        const rawExact = raw.indexOf(citation.quote);
        match = rawExact >= 0
          ? { start: rawExact, end: rawExact + citation.quote.length, quote: citation.quote }
          : normalizedMatch(raw, citation.quote);
        matchedSource = raw;
      }
      if (match) {
        file = candidate;
        break;
      }
    }
    const before = match ? matchedSource.slice(0, match.start) : '';
    const through = match ? matchedSource.slice(0, match.end) : '';
    const startIndex = before.split('\n').length - 1;
    const endIndex = through.split('\n').length - 1;
    const lineNumbers = file?.lineNumbers || [];
    citations.push({
      ref: citation.ref,
      rowRef: item.row.ref,
      fileRef: file?.ref || '',
      quote: citation.quote,
      kind: citation.kind,
      explanation: citation.explanation,
      quoteFound: Boolean(match),
      matchedQuote: match?.quote || '',
      matchStart: match?.start ?? -1,
      matchEnd: match?.end ?? -1,
      lineStart: match ? lineNumbers[startIndex] ?? startIndex + 1 : -1,
      lineEnd: match ? lineNumbers[endIndex] ?? endIndex + 1 : -1
    });
  }
  citations.sort((a, b) => {
    if (!a.quoteFound || !b.quoteFound) return Number(b.quoteFound) - Number(a.quoteFound);
    return order.get(a.rowRef) - order.get(b.rowRef)
      || order.get(a.fileRef) - order.get(b.fileRef)
      || a.lineStart - b.lineStart
      || a.matchStart - b.matchStart;
  });
  return {
    summary: value.summary,
    citations,
    costUsd: Number(meta.costUsd) || 0,
    durationMs: Number(meta.durationMs) || 0
  };
}
