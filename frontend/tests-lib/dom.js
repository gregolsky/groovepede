// DOM probes shared by the smoke suite (tests-smoke/) and the mobile suite
// (tests-mobile/). Pure page.evaluate helpers — no app imports, so they are
// safe under plain Node.

/**
 * Reports horizontal overflow at the current viewport. `wide` names the
 * offending elements (tag.class@rightEdge) so a failure points at the
 * culprit instead of just a number mismatch.
 */
export async function overflowReport(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const limit = doc.clientWidth + 1;
    const wide = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > limit)
      .slice(0, 15)
      .map((el) => {
        const cls = typeof el.className === 'string' ? el.className : el.className?.baseVal || '';
        return `${el.tagName.toLowerCase()}.${cls.trim().replace(/\s+/g, '.')}@${Math.round(el.getBoundingClientRect().right)}`;
      });
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, wide };
  });
}
