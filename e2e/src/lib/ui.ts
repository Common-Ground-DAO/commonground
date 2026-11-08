// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { ElementHandle, Page } from 'puppeteer';

/**
 * Small DOM helpers. The app has few test ids, so flows find controls the way
 * a person does: by their visible text, label or input name. Everything waits
 * (polling) instead of sleeping.
 */

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type TextMatch = string | RegExp;

type FindOptions = {
  /** CSS selector of the candidate elements */
  selector?: string;
  timeout?: number;
  /** match the whole trimmed text (default) or a substring */
  exact?: boolean;
  /** restrict to this element (CSS selector of a container) */
  within?: string;
};

const CLICKABLE = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], label, summary';

function serializeMatch(match: TextMatch) {
  return match instanceof RegExp ? { re: match.source, flags: match.flags } : { str: match };
}

/** turns puppeteer's generic "Waiting failed" into a message naming what was awaited */
export function describe(what: string, timeout: number) {
  return (e: unknown): never => {
    if (e instanceof Error && /Waiting failed|exceeded|Timeout/i.test(e.message)) {
      throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    }
    throw e;
  };
}

/** the first visible element under `selector` whose text matches */
export async function findByText(page: Page, match: TextMatch, options: FindOptions = {}): Promise<ElementHandle<Element>> {
  const { selector = CLICKABLE, timeout = 20_000, exact = true, within } = options;
  const handle = await page.waitForFunction((sel: string, m: { re?: string; flags?: string; str?: string }, exactMatch: boolean, container: string | undefined, fallbackFrom: string) => {
    const roots: ParentNode[] = container ? Array.from(document.querySelectorAll(container)) : [document];
    const test = (text: string) => {
      const t = text.replace(/\s+/g, ' ').trim();
      if (m.re !== undefined) {
        return new RegExp(m.re, m.flags).test(t);
      }
      return exactMatch ? t === m.str : t.includes(m.str!);
    };
    const visible = (html: HTMLElement) => {
      const rect = html.getBoundingClientRect();
      const style = getComputedStyle(html);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const label = (html: HTMLElement) => html.innerText || html.getAttribute('aria-label') || html.getAttribute('title') || (html as HTMLInputElement).value || '';
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        if (visible(el as HTMLElement) && test(label(el as HTMLElement))) {
          return el;
        }
      }
    }
    if (sel === fallbackFrom) {
      // many controls are plain elements with a click handler: the deepest
      // visible element with the text (none of its children has it)
      for (const root of roots) {
        const matches = Array.from(root.querySelectorAll('div, span, li, p, h1, h2, h3, h4, svg')).filter(el => visible(el as HTMLElement) && test(label(el as HTMLElement)));
        const deepest = matches.filter(el => !matches.some(other => other !== el && el.contains(other)));
        if (deepest.length) {
          return deepest[0];
        }
      }
    }
    return null;
  }, { timeout, polling: 200 }, selector, serializeMatch(match), exact, within, CLICKABLE)
    .catch(describe(`a visible element with text ${String(match)}${within ? ` within ${within}` : ''}`, timeout));
  return handle as ElementHandle<Element>;
}

/**
 * Clicks like a person: waits until nothing (a toast, an animating modal)
 * covers the element's centre, then clicks there. If it stays covered, the
 * element is clicked directly so the flow can go on.
 */
export async function clickElement(el: ElementHandle<Element>, timeout = 8_000) {
  await el.scrollIntoView().catch(() => undefined);
  const started = Date.now();
  for (;;) {
    const free = await el.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!top && (top === node || node.contains(top));
    }).catch(() => true);
    if (free) {
      await el.click();
      return;
    }
    if (Date.now() - started > timeout) {
      await el.evaluate(node => (node as HTMLElement).click());
      return;
    }
    await sleep(200);
  }
}

export async function clickText(page: Page, match: TextMatch, options: FindOptions = {}) {
  const el = await findByText(page, match, options);
  await clickElement(el);
  return el;
}

/** waits until the page shows the text (anywhere in the body) */
export async function waitText(page: Page, match: TextMatch, timeout = 20_000) {
  await page.waitForFunction((m: { re?: string; flags?: string; str?: string }) => {
    const text = document.body?.innerText ?? '';
    return m.re !== undefined ? new RegExp(m.re, m.flags).test(text) : text.includes(m.str!);
  }, { timeout, polling: 250 }, serializeMatch(match)).catch(describe(`the text ${String(match)}`, timeout));
}

/** waits until the text is gone from the page */
export async function waitNoText(page: Page, match: TextMatch, timeout = 20_000) {
  await page.waitForFunction((m: { re?: string; flags?: string; str?: string }) => {
    const text = document.body?.innerText ?? '';
    return !(m.re !== undefined ? new RegExp(m.re, m.flags).test(text) : text.includes(m.str!));
  }, { timeout, polling: 250 }, serializeMatch(match)).catch(describe(`the text ${String(match)} to disappear`, timeout));
}

export async function hasText(page: Page, match: TextMatch) {
  return page.evaluate((m: { re?: string; flags?: string; str?: string }) => {
    const text = document.body?.innerText ?? '';
    return m.re !== undefined ? new RegExp(m.re, m.flags).test(text) : text.includes(m.str!);
  }, serializeMatch(match));
}

/** replaces the value of a (visible) input/textarea */
export async function fill(page: Page, selector: string, value: string, timeout = 20_000) {
  const el = await page.waitForSelector(selector, { visible: true, timeout }).catch(describe(`the input ${selector}`, timeout));
  if (!el) {
    throw new Error(`no ${selector}`);
  }
  await el.click({ count: 3 });
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await el.type(value, { delay: 5 });
  return el;
}

/** types into a contenteditable (Slate) editor */
export async function typeIntoEditor(page: Page, selector: string, text: string) {
  const el = await page.waitForSelector(selector, { visible: true });
  if (!el) {
    throw new Error(`no ${selector}`);
  }
  await el.click();
  await page.keyboard.type(text, { delay: 5 });
  return el;
}

/** retries `fn` until it returns a truthy value */
export async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeout = 20_000, interval = 250): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    }
    catch (e) {
      lastError = e;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`timed out after ${timeout} ms waiting for ${what}${lastError ? ` (last error: ${(lastError as Error).message})` : ''}`);
    }
    await sleep(interval);
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
