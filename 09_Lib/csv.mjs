// Edge case 13 is the whole reason this exists: one corrupted row in an otherwise
// valid batch must not take the batch down with it. So parsing is per-record and
// every record carries its own verdict rather than throwing.

function splitRecords(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let sawQuote = false;
  let malformed = false;
  let raw = '';

  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => {
    if (record.length || field.length) pushField();
    if (record.length) records.push({ values: record, raw: raw.replace(/\r?\n$/, ''), malformed });
    record = []; raw = ''; malformed = false; sawQuote = false;
  };

  const src = String(text ?? '').replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    raw += ch;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; raw += src[++i]; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') {
      // A quote that opens mid-field is not valid CSV. Take the text literally and
      // flag the record rather than letting the quote swallow everything after it.
      if (field.length > 0) { malformed = true; field += ch; }
      else { inQuotes = true; sawQuote = true; }
    } else if (ch === ',') pushField();
    else if (ch === '\n') pushRecord();
    else if (ch !== '\r') field += ch;
  }

  // Unterminated quote at end of input: the record is broken, and saying so beats
  // silently returning a field containing the rest of the file.
  if (inQuotes) malformed = true;
  if (field.length || record.length) pushRecord();

  void sawQuote;
  return records;
}

export function parseCsv(text) {
  const records = splitRecords(text);
  if (!records.length) return { header: [], rows: [], error: 'empty input' };

  const header = records[0].values.map((h) => h.trim());
  const rows = records.slice(1).map((rec, i) => {
    const line = i + 2;   // 1-based, and the header occupies line 1

    if (rec.malformed) {
      return { line, ok: false, error: 'malformed_quoting', raw: rec.raw, values: null };
    }
    if (rec.values.length !== header.length) {
      return {
        line, ok: false, error: 'column_count_mismatch', raw: rec.raw, values: null,
        detail: `expected ${header.length} columns, found ${rec.values.length}`,
      };
    }

    const obj = {};
    header.forEach((h, idx) => { obj[h] = rec.values[idx].trim(); });
    return { line, ok: true, values: obj, raw: rec.raw };
  });

  return { header, rows };
}
