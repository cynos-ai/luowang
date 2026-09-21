import { parseDocument } from 'yaml';

/** Parse the pinned MCP inline YAML snapshot, never arbitrary tool text or filenames. */
export function readInlineBrowserSnapshot(
  raw: string,
): { text: string; fieldValues: string[] } | undefined {
  if (!raw.includes('### Snapshot')) return undefined;
  // Automatic navigation snapshots are file links, not inline content evidence.
  if (/^### Snapshot\r?\n- \[Snapshot\]\([^\r\n]+\)\s*$/m.test(raw)) return undefined;
  const matches = [
    ...raw.matchAll(/^### Snapshot\r?\n```yaml\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/gm),
  ];
  if (matches.length !== 1 || raw.split('### Snapshot').length !== 2)
    throw new Error('Unsupported snapshot envelope');
  const text = matches[0][1];
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Snapshot too large');
  const document = parseDocument(text, { uniqueKeys: true, schema: 'failsafe' });
  if (document.errors.length || document.warnings.length) throw new Error('Invalid snapshot YAML');
  const tree: unknown = document.toJS({ maxAliasCount: 0 });
  const values: string[] = [];
  const field = /^(?:textbox|searchbox|spinbutton|combobox)(?:\s|$)/;
  const visit = (node: unknown, depth: number) => {
    if (depth > 64) throw new Error('Snapshot too deep');
    if (typeof node === 'string') return;
    if (!Array.isArray(node)) throw new Error('Unsupported snapshot node');
    for (const entry of node) {
      if (typeof entry === 'string') continue;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error('Unsupported snapshot entry');
      for (const [key, value] of Object.entries(entry)) {
        if (field.test(key)) {
          if (typeof value !== 'string' && typeof value !== 'number')
            throw new Error('Unsupported field value');
          if (String(value)) values.push(String(value));
        } else if (Array.isArray(value)) visit(value, depth + 1);
        else if (typeof value !== 'string' && typeof value !== 'number' && value !== null)
          throw new Error('Unsupported snapshot value');
      }
    }
  };
  visit(tree, 0);
  return { text, fieldValues: [...new Set(values)] };
}
