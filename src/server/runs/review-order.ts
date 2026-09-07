import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createTextResult } from './agent-session.js';

/** Session-local read order. A denied call never exposes the artifact body. */
export function createReviewReadOrder(
  read: (name: string) => Promise<string>,
  requiredImages: readonly string[],
  onImageFailure: () => void,
  requirePatch = false,
  onCommandFailure: () => void = onImageFailure,
) {
  let planRead = false;
  let patchRead = false;
  const attemptedImages = new Set<string>();
  const assertReady = () => {
    if (!planRead || (requirePatch && !patchRead))
      throw new Error(
        'Reviewer 必须先读取 plan.md 和存在的 scenario-changes.patch，再核对原始证据',
      );
    if (requiredImages.some((name) => !attemptedImages.has(name))) {
      throw new Error(
        'Reviewer 必须先通过 read_evidence_image 逐一核对本次原始图片，再读 execution.md/draft-report.md 或提交审核',
      );
    }
  };
  return {
    assertReady,
    async readArtifact(name: string): Promise<string> {
      if (name === 'execution.md' || name === 'draft-report.md') assertReady();
      const content = await read(name);
      if (name === 'plan.md') planRead = true;
      if (name === 'scenario-changes.patch') patchRead = true;
      return content;
    },
    wrap(tool: ToolDefinition): ToolDefinition {
      if (tool.name !== 'read_evidence_image' && tool.name !== 'read_command_evidence') return tool;
      return {
        ...tool,
        async execute(...args) {
          if (!planRead || (requirePatch && !patchRead))
            return createTextResult(
              'Reviewer 必须先读取 plan.md 和存在的 scenario-changes.patch，再核对原始证据',
              { error: true },
            );
          const filename = (args[1] as { filename: string }).filename;
          const result = await tool.execute(...args);
          if (tool.name === 'read_command_evidence') {
            if ((result.details as { error?: boolean } | undefined)?.error) onCommandFailure();
            return result;
          }
          attemptedImages.add(filename);
          // Failed evidence remains a blocking fact, but may be described in the review.
          if (
            (result.details as { error?: boolean } | undefined)?.error ||
            !result.content.some((part) => part.type === 'image')
          )
            onImageFailure();
          return result;
        },
      };
    },
  };
}
