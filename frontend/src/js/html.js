/**
 * Escape-by-default HTML templating for the string renderer (render.js,
 * landing.js).
 *
 *   html`<p title="${album.title}">${album.artist}</p>`
 *
 * escapes every interpolated value unless the value is itself the result of
 * html`` (or raw()). That removes the question "does this value need
 * escaping?" from every call site. Answering it call site by call site is how
 * unescaped fields once reached innerHTML (a crafted backup file became a
 * stored XSS).
 *
 * Arrays render item by item with no separator (so `.map()` needs no
 * `.join('')`, which would lose the safe type), null/undefined/false render as
 * nothing, and anything else — strings, numbers, true — is escaped as text.
 * Mind `${cond && html`…`}`: that's safe for a string/object/boolean cond,
 * but a numeric cond of 0 renders a literal "0" — test `count > 0` instead.
 * A result is a SafeHtml; String() it (or assign it to innerHTML) to get the
 * markup.
 */

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Mark a string as trusted markup. Static markup only (icons) — never data. */
export function raw(markup) {
  return new SafeHtml(String(markup));
}

function toHtml(value) {
  if (value == null || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(toHtml).join('');
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += toHtml(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}
