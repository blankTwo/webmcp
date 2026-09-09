import { readFile, writeFile } from "node:fs/promises";
import * as Diff from "diff";
import { detectLineEnding } from "./engine.js";

export interface EditOperation {
  oldText: string;
  newText: string;
}

export interface SmartEditResult {
  success: boolean;
  content: string;
  diff?: string;
  patch?: string;
  additions: number;
  removals: number;
  error?: string;
}

/**
 * Escape regex special characters except when .*? or .* is used as a wildcard
 */
function toRegexPattern(pattern: string): string {
  // Replace .*? and .* with placeholders first
  const nonGreedyPlaceholder = "___NON_GREEDY_WILDCARD___";
  const greedyPlaceholder = "___GREEDY_WILDCARD___";

  let protectedPattern = pattern
    .split(".*?")
    .join(nonGreedyPlaceholder)
    .split(".*")
    .join(greedyPlaceholder);

  // Escape special characters
  protectedPattern = protectedPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Restore wildcards as multiline matchers
  protectedPattern = protectedPattern
    .split(nonGreedyPlaceholder)
    .join("[\\s\\S]*?")
    .split(greedyPlaceholder)
    .join("[\\s\\S]*");

  return protectedPattern;
}

/**
 * Apply fault-tolerant regex or whitespace-flexible edits to a file
 */
export async function applySmartEdit(
  filePath: string,
  edits: EditOperation[],
): Promise<SmartEditResult> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      content: "",
      additions: 0,
      removals: 0,
      error: `Could not read file ${filePath}: ${msg}`,
    };
  }

  const originalContent = content;
  const lineEnding = detectLineEnding(content);
  let currentContent = content;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const rawOld = edit.oldText;
    const rawNew = edit.newText;

    // Try exact literal match first
    const exactIndex = currentContent.indexOf(rawOld);
    if (exactIndex !== -1 && currentContent.indexOf(rawOld, exactIndex + 1) === -1) {
      currentContent =
        currentContent.slice(0, exactIndex) + rawNew + currentContent.slice(exactIndex + rawOld.length);
      continue;
    }

    // Try LF-normalized literal match (resolves CRLF mismatch)
    const normalizedContent = currentContent.replace(/\r\n/g, "\n");
    const normalizedOld = rawOld.replace(/\r\n/g, "\n");
    const normIndex = normalizedContent.indexOf(normalizedOld);
    if (normIndex !== -1 && normalizedContent.indexOf(normalizedOld, normIndex + 1) === -1) {
      const normalizedNew = rawNew.replace(/\r\n/g, "\n");
      currentContent =
        normalizedContent.slice(0, normIndex) +
        normalizedNew +
        normalizedContent.slice(normIndex + normalizedOld.length);
      if (lineEnding === "\r\n") {
        currentContent = currentContent.replace(/\n/g, "\r\n");
      }
      continue;
    }

    // Try Regex non-greedy matching (supports .*?)
    try {
      const patternStr = toRegexPattern(normalizedOld);
      const regex = new RegExp(patternStr, "g");
      const matches = [...normalizedContent.matchAll(regex)];

      if (matches.length === 1) {
        const match = matches[0];
        const matchIndex = match.index!;
        const matchLength = match[0].length;
        const normalizedNew = rawNew.replace(/\r\n/g, "\n");

        currentContent =
          normalizedContent.slice(0, matchIndex) +
          normalizedNew +
          normalizedContent.slice(matchIndex + matchLength);

        if (lineEnding === "\r\n") {
          currentContent = currentContent.replace(/\n/g, "\r\n");
        }
        continue;
      } else if (matches.length > 1) {
        return {
          success: false,
          content: originalContent,
          additions: 0,
          removals: 0,
          error: `Ambiguous pattern in edits[${i}]: matched ${matches.length} times in ${filePath}. Please provide more surrounding context to disambiguate.`,
        };
      }
    } catch {
      // Ignore regex compile errors and continue
    }

    // Failed to match this edit
    return {
      success: false,
      content: originalContent,
      additions: 0,
      removals: 0,
      error: `Could not find edits[${i}] in ${filePath}. Text must match uniquely (or use '.*?' wildcard for non-greedy block replacement).`,
    };
  }

  // Calculate additions & removals
  const patchStr = Diff.createPatch(filePath, originalContent, currentContent, "", "");
  const parsedPatch = Diff.parsePatch(patchStr)[0];
  let additions = 0;
  let removals = 0;

  if (parsedPatch) {
    for (const hunk of parsedPatch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) removals += 1;
      }
    }
  }

  // Write updated content back to disk
  await writeFile(filePath, currentContent, "utf8");

  return {
    success: true,
    content: currentContent,
    diff: patchStr,
    patch: patchStr,
    additions,
    removals,
  };
}
