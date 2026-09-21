import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { redactCommandText, type RunEvidenceStore } from './evidence.js';
import { readInlineBrowserSnapshot } from './browser-snapshot.js';

const RECORDED_TOOLS = new Set([
  'browser_cookie_list',
  'browser_cookie_get',
  'browser_cookie_set',
  'browser_network_requests',
  'browser_network_request',
]);

/** Observe the installed MCP proxy; never execute an additional browser operation. */
export function createBrowserObservationExtension(options: {
  store: RunEvidenceStore;
  targetCommit: string;
  now: () => Date;
  operationContext: () => Record<string, unknown>;
  onFailure: () => void;
}): InlineExtension {
  const credentials = new Map<string, string>();
  const identify = (value: string) => {
    if (!value) return null;
    if (!options.store.identifySensitiveValue) throw new Error('Credential identity unavailable');
    if (!credentials.has(value))
      credentials.set(value, options.store.identifySensitiveValue(value));
    return credentials.get(value)!;
  };
  const starts = new Map<string, { startedAt: string; execution: Record<string, unknown> }>();
  return {
    name: 'luowang-browser-observation',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', (event) => {
        // The pinned adapter exposes both gateways even with directTools disabled.
        if (event.toolName !== 'mcp' && event.toolName !== 'mcp__playwright') return;
        if (typeof event.input.tool !== 'string') return;
        // The application installs only the playwright server, with a fixed server prefix.
        const tool = event.input.tool.replace(/^playwright_/, '');
        if (!tool.startsWith('browser_'))
          return {
            block: true,
            reason:
              '请使用 MCP 工具清单中的完整 browser_* 名称（可带 playwright_ 前缀），以便保存受控执行记录。',
          };
        if (event.input.server !== undefined && event.input.server !== 'playwright') return;
        const args = parseArguments(event.input.args);
        if (
          (RECORDED_TOOLS.has(tool) || tool === 'browser_snapshot') &&
          args?.filename !== undefined
        ) {
          return {
            block: true,
            reason:
              '重放/网络/快照证据请省略 filename，返回文本由 Harness 脱敏捕获；不要把原始内容另存文件。',
          };
        }
        starts.set(event.toolCallId, {
          startedAt: options.now().toISOString(),
          execution: options.operationContext(),
        });
      });
      pi.on('tool_result', async (event) => {
        if (event.toolName !== 'mcp' && event.toolName !== 'mcp__playwright') return;
        const start = starts.get(event.toolCallId);
        starts.delete(event.toolCallId);
        const details = asObject(event.details);
        // Identity comes from the adapter's actual resolved tool, not the model's name.
        if (!start || details?.mode !== 'call' || details.server !== 'playwright') return;
        const tool = details.tool;
        if (typeof tool !== 'string' || !tool.startsWith('browser_')) return;
        try {
          const args = RECORDED_TOOLS.has(tool) ? (parseArguments(event.input.args) ?? {}) : {};
          const raw = event.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          const snapshot = readInlineBrowserSnapshot(raw);
          if (snapshot) {
            if (!options.store.registerSensitiveValue || !options.store.redactText)
              throw new Error('Snapshot privacy unavailable');
            for (const value of snapshot.fieldValues) options.store.registerSensitiveValue(value);
          }
          if (tool === 'browser_snapshot' && !snapshot && !event.isError && !details.error)
            throw new Error('Snapshot content unavailable');
          const references: Array<{
            source: string;
            name: string;
            reference: string | null;
            attributes?: string;
          }> = [];
          if (tool === 'browser_cookie_set' && typeof args.value === 'string') {
            references.push({
              source: 'restore-input',
              name: String(args.name ?? ''),
              reference: identify(args.value),
            });
          }
          if (tool === 'browser_cookie_get' || tool === 'browser_cookie_list') {
            // Fixed Playwright 1.63 text format. Unknown output is omitted, never copied raw.
            for (const match of raw.matchAll(/^([^\s=]+)=([^\r\n]*?) \((domain: [^\r\n]*)\)$/gm)) {
              references.push({
                source: 'observed-browser',
                name: match[1],
                reference: identify(match[2]),
                attributes: match[3],
              });
            }
          }
          if (
            tool === 'browser_network_request' &&
            (args.part === undefined || args.part === 'request-headers')
          ) {
            const headers =
              args.part === 'request-headers'
                ? raw
                : (raw.match(/\n {2}Request headers\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/)?.[1] ?? '');
            for (const match of headers.matchAll(/^\s*cookie:\s*([^\r\n]*)/gim)) {
              for (const pair of match[1].split(';')) {
                const separator = pair.indexOf('=');
                if (separator > 0)
                  references.push({
                    source: 'observed-request-header',
                    name: pair.slice(0, separator).trim(),
                    reference: identify(pair.slice(separator + 1).trim()),
                  });
              }
            }
          }
          const clean = (value: string) => redactCommandText(value, [...credentials.keys()]);
          const safeArguments = Object.fromEntries(
            Object.entries(args).map(([key, value]) => [
              key,
              key === 'value' ? '[REDACTED]' : clean(JSON.stringify(value)),
            ]),
          );
          const observation = {
            source: 'playwright-mcp-tool-result',
            tool,
            ...start,
            finishedAt: options.now().toISOString(),
            isError: event.isError || Boolean(details.error),
            arguments: safeArguments,
            credentialReferences: references.map((ref) => ({ ...ref, name: clean(ref.name) })),
            output: snapshot
              ? options.store.redactText!(snapshot.text)
              : tool.startsWith('browser_cookie_') || !RECORDED_TOOLS.has(tool)
                ? '[Output omitted; this receipt records operation timing, not a business verdict]'
                : clean(raw),
            limitation:
              'References compare exact values within this Run only. An input is not proof of a sent request; omitted/truncated output cannot prove absence.',
          };
          if (!options.store.captureObservation) throw new Error('Observation capture unavailable');
          const id = await options.store.captureObservation(options.targetCommit, observation);
          return {
            content: [
              ...event.content.map((part) =>
                snapshot && part.type === 'text'
                  ? { ...part, text: options.store.redactText!(part.text) }
                  : part,
              ),
              {
                type: 'text' as const,
                text: `Harness 已捕获脱敏证据 ${id}；Reviewer 通过 read_command_evidence 读取。${snapshot ? '该记录包含脱敏后的内联快照正文。' : !RECORDED_TOOLS.has(tool) ? '该记录仅含操作时序，不含页面正文，不能引用为页面内容证据。' : ''}`,
              },
            ],
          };
        } catch {
          options.onFailure();
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Harness 捕获重放证据失败，不能确认相关审核证据已保存。',
              },
            ],
          };
        }
      });
    },
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  try {
    return asObject(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {
    return undefined;
  }
}
