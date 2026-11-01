import { expect, test } from '@playwright/test';
import { expectNoA11yViolations, gotoAndSettle } from './helpers';
import { REFLOW_ROUTES } from './routes';

/**
 * WCAG 1.4.10 Reflow (AA) at 320 CSS px.
 *
 * The criterion: content must not require horizontal scrolling of the *page*. A wide
 * data table is allowed to scroll inside its own container — which is exactly why that
 * container was made keyboard-focusable — but the document itself must not.
 */
for (const path of REFLOW_ROUTES) {
  test(`reflow at 320px: ${path}`, async ({ page }) => {
    await gotoAndSettle(page, path);

    const overflow = await page.evaluate(() => {
      const clientWidth = document.documentElement.clientWidth;
      // Name the actual culprits. "The page is 29px too wide" is not actionable on a
      // page with a thousand nodes; the offending selectors are.
      const describe = (el: HTMLElement) => {
        const id = el.id ? `#${el.id}` : '';
        const cls =
          el.className && typeof el.className === 'string'
            ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
            : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
      };

      const rows: { label: string; right: number }[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) continue;
        // Skip nodes *inside* a deliberate horizontal scroller (our table wrappers):
        // content scrolling within a container is explicitly allowed by 1.4.10.
        // Note `parentElement`, not `closest` on the node itself — the scroll container
        // is still a suspect if it is the thing overflowing the page.
        if (el.parentElement?.closest('.overflow-x-auto')) continue;
        // Also report elements whose own content overflows them, which can push the
        // document wider without the element's own box exceeding the viewport.
        const selfOverflow = el.scrollWidth > el.clientWidth + 1 && !el.closest('.overflow-x-auto');
        // Only an element that reaches PAST the viewport is an offender. An element
        // that merely comes close to the right edge is not overflowing anything, and
        // naming it would bury the one element that is.
        if (rect.right > clientWidth + 1 || selfOverflow) {
          rows.push({
            label: `${describe(el)} → right ${Math.round(rect.right)}px, scrollW ${el.scrollWidth}, clientW ${el.clientWidth}`,
            right: Math.max(rect.right, el.scrollWidth),
          });
        }
      }
      rows.sort((a, b) => b.right - a.right);
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth,
        offenders: Array.from(new Set(rows.map((r) => r.label))).slice(0, 12),
      };
    });

    // 1px of slack for sub-pixel rounding in the layout engine.
    expect(
      overflow.scrollWidth,
      `${path} scrolls horizontally at 320px (${overflow.scrollWidth} > ${overflow.clientWidth}).\n` +
        `Widest offenders outside a scroll container:\n  ${overflow.offenders.join('\n  ') || '(none — check an .overflow-x-auto ancestor)'}`,
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);

    await expectNoA11yViolations(page, `${path} @320px`);
  });
}
