import { extname } from "node:path";
import ts from "typescript";
import YAML from "yaml";
import type { FileDiagnosticsResult, SyntaxDiagnostic } from "./types.js";

/**
 * Check file content for syntax errors and return immediate diagnostic feedback
 */
export function checkSyntaxDiagnostics(
  filePath: string,
  content: string,
): FileDiagnosticsResult {
  const ext = extname(filePath).toLowerCase();

  // 1. TypeScript & JavaScript
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const isJsx = ext === ".tsx" || ext === ".jsx";
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true, // setParentNodes
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics;

    if (parseDiagnostics && parseDiagnostics.length > 0) {
      const diagnostics: SyntaxDiagnostic[] = parseDiagnostics.map((diag) => {
        let line = 1;
        let character = 1;
        if (diag.start !== undefined) {
          const pos = sourceFile.getLineAndCharacterOfPosition(diag.start);
          line = pos.line + 1;
          character = pos.character + 1;
        }
        const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        return {
          line,
          character,
          message: `TS${diag.code}: ${message}`,
        };
      });

      const formattedSummary = diagnostics
        .slice(0, 5)
        .map((d) => `Line ${d.line}, Col ${d.character}: ${d.message}`)
        .join("\n");

      return {
        valid: false,
        diagnostics,
        formattedSummary: `Syntax errors detected in ${filePath} after modification:\n${formattedSummary}${diagnostics.length > 5 ? `\n...and ${diagnostics.length - 5} more error(s)` : ""}`,
      };
    }

    return { valid: true, diagnostics: [] };
  }

  // 2. JSON
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { valid: true, diagnostics: [] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const match = /line (\d+) column (\d+)/i.exec(msg);
      const line = match ? parseInt(match[1], 10) : 1;
      const character = match ? parseInt(match[2], 10) : 1;
      return {
        valid: false,
        diagnostics: [{ line, character, message: msg }],
        formattedSummary: `JSON Syntax error in ${filePath}: ${msg}`,
      };
    }
  }

  // 3. YAML
  if (ext === ".yaml" || ext === ".yml") {
    try {
      YAML.parse(content);
      return { valid: true, diagnostics: [] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        diagnostics: [{ line: 1, character: 1, message: msg }],
        formattedSummary: `YAML Syntax error in ${filePath}: ${msg}`,
      };
    }
  }

  // Other languages: passed by default
  return { valid: true, diagnostics: [] };
}
