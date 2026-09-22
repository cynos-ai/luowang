import {
  screenshotInspectionLabel,
  type EvidenceReference,
  type ScreenshotInspection,
} from '../../shared/types.js';

export function readScreenshotReceipt(raw: string): {
  filename: string;
  inspection: ScreenshotInspection;
} {
  const lines = raw.split(/\r?\n/).filter((line) => line.startsWith('LUOWANG_SCREENSHOT_CAPTURE '));
  if (lines.length !== 1) throw new Error('截图采集标签缺失或重复');
  const value = JSON.parse(lines[0].slice('LUOWANG_SCREENSHOT_CAPTURE '.length));
  if (
    !value ||
    typeof value.filename !== 'string' ||
    !['detected', 'not_detected', 'unknown'].includes(value.status) ||
    value.scope !== 'page' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error('截图采集标签格式无效');
  return {
    filename: value.filename.replace(/^\.\//, ''),
    inspection: { status: value.status, scope: 'page', sha256: value.sha256 },
  };
}

/** System-owned report annotation, independent of model disclosure claims. */
export function appendScreenshotLabels(
  content: string,
  references: readonly EvidenceReference[],
): string {
  const images = references.filter((ref) => ref.contentType.startsWith('image/'));
  if (!images.length) return content;
  const lines = images.map(
    (ref, index) =>
      `- [截图 ${index + 1}](<${ref.url}>)：${screenshotInspectionLabel(ref.screenshotInspection ?? { status: 'unknown' })}；检测范围为页面，不代表图片整体安全或人工审核通过。`,
  );
  const section = `\n\n<!-- luowang-screenshot-inspection -->\n## 截图采集标签\n\n${lines.join('\n')}\n<!-- /luowang-screenshot-inspection -->\n`;
  return (
    content
      .replace(
        /\n*<!-- luowang-screenshot-inspection -->[\s\S]*?<!-- \/luowang-screenshot-inspection -->\n*/g,
        '',
      )
      .trimEnd() + section
  );
}
