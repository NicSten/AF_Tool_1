// CSV cells opened in Excel/Sheets can be executed as formulas.
// Prefix formula-leading text (also after leading spaces/control characters)
// with an apostrophe, then apply ordinary RFC 4180 quoting.
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
