/**
 * CSV export (RFC 4180) with two protections that matter for a spreadsheet:
 *  - a UTF-8 BOM so Excel renders Arabic instead of mojibake
 *  - formula-injection neutralisation (=, +, -, @ leading cells)
 */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(columns, rows) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return [header, ...body].join('\r\n');
}

export function csvBuffer(columns, rows) {
  return Buffer.from('\uFEFF' + toCsv(columns, rows), 'utf8');
}
