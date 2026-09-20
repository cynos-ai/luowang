import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('playwright-core/package.json'));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (version !== '1.63.0-alpha-2026-08-05')
  throw new Error('Unexpected Playwright screenshot version');
const path = join(root, 'lib/coreBundle.js');
const source = await readFile(path, 'utf8');
const before =
  '        const data = target ? await target.locator.screenshot(options) : await tab2.page.screenshot(options);';
const guard = `        // LUOWANG_SCREENSHOT_FORM_GUARD_V1: no value leaves the browser check.
        for (const frame of tab2.page.frames()) {
          let containsFilledField;
          try {
            containsFilledField = await frame.locator('input, textarea, [contenteditable]').evaluateAll(elements => elements.some(element => {
              if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
              if (element instanceof HTMLInputElement && !['text', 'email', 'password', 'search', 'url', 'tel', 'number'].includes(element.type)) return false;
              if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value.length > 0;
              return element.isContentEditable && (element.textContent || '').length > 0;
            }));
          } catch {
            throw new Error('Screenshot privacy check unavailable; no image captured. Use other controlled evidence or retry after the page is stable.');
          }
          if (containsFilledField) throw new Error('Screenshot blocked: visible text fields contain values. Preserve required evidence first, then clear fields if this does not change the assertion, or use other controlled evidence. No image captured.');
        }
`;
const after = guard + before;
if (source.split(after).length - 1 === 1) {
  // Repeated build/test invocations are idempotent.
} else {
  if (source.includes('LUOWANG_SCREENSHOT_FORM_GUARD_V1') || source.split(before).length - 1 !== 1)
    throw new Error('Pinned screenshot implementation changed; guard not applied');
  await writeFile(path, source.replace(before, after));
  console.log('Applied pinned MCP screenshot form guard');
}
