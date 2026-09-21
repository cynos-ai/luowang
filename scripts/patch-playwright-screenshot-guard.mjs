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
const guard = `        // LUOWANG_SCREENSHOT_CAPTURE_V2: detect fields without altering the page.
        let luowangFieldStatus = "not_detected";
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
            luowangFieldStatus = 'unknown';
            break;
          }
          if (containsFilledField) luowangFieldStatus = 'detected';
        }
`;
const receiptBefore =
  '        await response2.addFileResult(resolvedFile, data);\n        if (!params2.filename)';
const receiptAfter = `        await response2.addFileResult(resolvedFile, data);
        response2.addTextResult("LUOWANG_SCREENSHOT_CAPTURE " + JSON.stringify({ filename: resolvedFile.relativeName, status: luowangFieldStatus, sha256: require("node:crypto").createHash("sha256").update(data).digest("hex"), scope: "page" }));
        response2.addTextResult("Screenshot retains original page state. Field detection is not an image safety review. Do not clear or alter the page for evidence.");
        if (!params2.filename)`;
const after = guard + before;
if (source.split(after).length - 1 === 1 && source.split(receiptAfter).length - 1 === 1) {
  // Repeated build/test invocations are idempotent.
} else {
  if (
    source.includes('LUOWANG_SCREENSHOT_') ||
    source.split(before).length - 1 !== 1 ||
    source.split(receiptBefore).length - 1 !== 1
  )
    throw new Error('Pinned screenshot implementation changed; guard not applied');
  await writeFile(path, source.replace(before, after).replace(receiptBefore, receiptAfter));
  console.log('Applied pinned MCP screenshot capture labels');
}
