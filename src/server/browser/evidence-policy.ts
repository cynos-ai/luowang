type Capture = 'replay' | 'filling' | 'snapshot' | 'screenshot' | 'receipt';
interface BrowserEvidencePolicy {
  capture: Capture;
  readTool: 'read_command_evidence';
  artifactReader?: 'read_browser_evidence' | 'read_evidence_image';
}

const policy = (
  capture: Capture,
  artifactReader?: BrowserEvidencePolicy['artifactReader'],
): BrowserEvidencePolicy =>
  Object.freeze({
    capture,
    readTool: 'read_command_evidence',
    ...(artifactReader ? { artifactReader } : {}),
  });
const receipt = policy('receipt', 'read_browser_evidence');
const replay = policy('replay');
const filling = policy('filling', 'read_browser_evidence');

// Fixed installed MCP surface. A receipt deliberately omits tool output;
// automatic snapshots/logs, if produced, use their separate controlled reader.
const policies: Readonly<Record<string, BrowserEvidencePolicy>> = Object.freeze({
  browser_close: receipt,
  browser_resize: receipt,
  browser_console_messages: receipt,
  browser_handle_dialog: receipt,
  browser_file_upload: receipt,
  browser_drop: receipt,
  browser_find: receipt,
  browser_press_key: receipt,
  browser_navigate: receipt,
  browser_navigate_back: receipt,
  browser_click: receipt,
  browser_drag: receipt,
  browser_hover: receipt,
  browser_select_option: receipt,
  browser_tabs: receipt,
  browser_wait_for: receipt,
  browser_cookie_list: replay,
  browser_cookie_get: replay,
  browser_cookie_set: replay,
  browser_network_requests: replay,
  browser_network_request: replay,
  browser_fill_form: filling,
  browser_type: filling,
  browser_snapshot: policy('snapshot', 'read_browser_evidence'),
  browser_take_screenshot: policy('screenshot', 'read_evidence_image'),
});

export function browserEvidencePolicy(name: string): BrowserEvidencePolicy | undefined {
  return Object.hasOwn(policies, name) ? policies[name] : undefined;
}

export function assertBrowserEvidenceCoverage(names: readonly string[]): void {
  if (names.some((name) => !browserEvidencePolicy(name)))
    throw new Error('MCP_EVIDENCE_POLICY_MISSING');
}
