import { describe, it, expect } from 'vitest';
import { html, raw, escapeHtml } from './html.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
  it('stringifies non-strings', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('html tagged template', () => {
  it('escapes every interpolated value by default', () => {
    expect(String(html`<p title="${'"x"'}">${'<svg onload=alert(1)>'}</p>`))
      .toBe('<p title="&quot;x&quot;">&lt;svg onload=alert(1)&gt;</p>');
  });

  it('does not re-escape a nested html`` fragment', () => {
    const inner = html`<b>${'a&b'}</b>`;
    expect(String(html`<p>${inner}</p>`)).toBe('<p><b>a&amp;b</b></p>');
  });

  it('renders arrays item by item, with no separator', () => {
    expect(String(html`<ul>${['<1>', html`<li>2</li>`]}</ul>`)).toBe('<ul>&lt;1&gt;<li>2</li></ul>');
  });

  it('renders null, undefined and false as nothing', () => {
    expect(String(html`[${null}${undefined}${false}]`)).toBe('[]');
  });

  it('renders numbers and true as text', () => {
    expect(String(html`${0}|${1.5}|${true}`)).toBe('0|1.5|true');
  });

  it('passes raw() markup through untouched', () => {
    expect(String(html`${raw('<svg/>')}`)).toBe('<svg/>');
  });

  it('leaves the static parts of the template alone (entities included)', () => {
    expect(String(html`a &mdash; <i>b</i>`)).toBe('a &mdash; <i>b</i>');
  });
});
