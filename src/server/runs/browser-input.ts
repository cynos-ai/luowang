import type { RunEvidenceStore } from './evidence.js';

/** Register the entire batch before MCP can execute even its first field. */
export function registerBrowserInput(
  tool: string,
  args: Record<string, unknown> | undefined,
  store: RunEvidenceStore,
): Record<string, unknown> {
  if (!args || !store.identifySensitiveValue || !store.redactText)
    throw new Error('Filling protection unavailable');
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid filling field');
    return value as Record<string, unknown>;
  };
  const target = (field: Record<string, unknown>) => {
    if (typeof field.target !== 'string' || !field.target)
      throw new Error('Invalid filling target');
    if (field.element !== undefined && typeof field.element !== 'string')
      throw new Error('Invalid filling element description');
  };
  const fields = tool === 'browser_fill_form' ? args.fields : [args];
  if (!Array.isArray(fields)) throw new Error('Invalid filling fields');
  const checked = fields.map((value) => {
    const field = object(value);
    target(field);
    if (tool === 'browser_fill_form') {
      if (
        typeof field.name !== 'string' ||
        !['textbox', 'checkbox', 'radio', 'combobox', 'slider'].includes(String(field.type)) ||
        typeof field.value !== 'string' ||
        (['checkbox', 'radio'].includes(String(field.type)) &&
          !['true', 'false'].includes(field.value))
      )
        throw new Error('Invalid filling field');
    } else if (
      typeof field.text !== 'string' ||
      (field.submit !== undefined && typeof field.submit !== 'boolean') ||
      (field.slowly !== undefined && typeof field.slowly !== 'boolean')
    )
      throw new Error('Invalid typing input');
    return field;
  });
  const references = checked.map((field) => {
    const value = tool === 'browser_type' ? field.text : field.value;
    const isBooleanControl =
      tool === 'browser_fill_form' && ['checkbox', 'radio'].includes(String(field.type));
    return value && !isBooleanControl ? store.identifySensitiveValue!(String(value)) : null;
  });
  const safe = checked.map((field, index) => ({
    target: store.redactText!(String(field.target)),
    ...(field.element !== undefined ? { element: store.redactText!(String(field.element)) } : {}),
    ...(tool === 'browser_fill_form'
      ? {
          name: store.redactText!(String(field.name)),
          type: field.type,
          value: references[index] ? '[REDACTED]' : field.value,
        }
      : {
          text: references[index] ? '[REDACTED]' : field.text,
          submit: field.submit ?? false,
          slowly: field.slowly ?? false,
        }),
    valueReference: references[index],
  }));
  return tool === 'browser_fill_form' ? { fields: safe } : safe[0];
}
