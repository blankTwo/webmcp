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
 * Converts a pattern with optional `.*?` / `.*` wildcards and multiline text
 * into a regex that tolerates minor whitespace and indentation variations.
 */
function toSmartPattern(pattern: string): string {
  const nonGreedyPlaceholder = "___NON_GREEDY_WILDCARD___";
  const greedyPlaceholder = "___GREEDY_WILDCARD___";

  const protectedPattern = pattern
    .split(".*?")
    .join(nonGreedyPlaceholder)
    .split(".*")
    .join(greedyPlaceholder);

  // Split into chunks between wildcards
  const parts = protectedPattern.split(/(___NON_GREEDY_WILDCARD___|___GREEDY_WILDCARD___)/);

  const convertedParts = parts.map((part) => {
    if (part === nonGreedyPlaceholder) return "[\\s\\S]*?";
    if (part === greedyPlaceholder) return "[\\s\\S]*";

    // Split into lines for whitespace and indentation normalization
    const lines = part.replace(/\r\n/g, "\n").split("\n");
    const regexLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "[ \\t]*";
      const tokens = trimmed.split(/[ \t]+/);
      const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return "[ \\t]*" + escaped.join("[ \\t]+");
    });
    return regexLines.join("[ \\t]*\\r?\\n");
  });

  return convertedParts.join("");
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

    // Step 1: Try exact literal match first
    const exactIndex = currentContent.indexOf(rawOld);
    if (exactIndex !== -1 && currentContent.indexOf(rawOld, exactIndex + 1) === -1) {
      currentContent =
        currentContent.slice(0, exactIndex) + rawNew + currentContent.slice(exactIndex + rawOld.length);
      continue;
    }

    // Step 2: Try LF-normalized literal match (resolves CRLF / LF line endings)
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

    // Step 3: Try smart pattern match (handles .*? / .* wildcards + fuzzy whitespace/indentation)
    try {
      const patternStr = toSmartPattern(normalizedOld);
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
          error: `Ambiguous pattern in edits[${i}]: matched ${matches.length} different locations in ${filePath}. Each oldText must match a unique block. Please provide more surrounding lines/context to disambiguate, or use 'apply_patch'.`,
        };
      }
    } catch {
      // Ignore regex compile errors and fall through
    }

    // Step 4: If still not matched, construct actionable diagnosis
    const firstNonEmptyLine = rawOld.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
    const partialFound = firstNonEmptyLine && currentContent.includes(firstNonEmptyLine);
    let hint = "The specified text does not exist in the file.";
    if (partialFound) {
      hint = `Found partial line "${firstNonEmptyLine.slice(0, 50)}...", but surrounding lines or block content differed.`;
    }

    return {
      success: false,
      content: originalContent,
      additions: 0,
      removals: 0,
      error: `Could not find edits[${i}] in ${filePath}. ${hint} Tip: You can use '.*?' wildcards to bridge variable/dynamic text, or call 'read' on ${filePath} to check the latest content before editing. For complex multi-part changes, prefer 'apply_patch'.`,
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
