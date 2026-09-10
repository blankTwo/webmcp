import { extname } from "node:path";
import ts from "typescript";
import type {
  InsertSymbolResult,
  ReplaceSymbolResult,
  SymbolKind,
  SymbolMatch,
  SymbolNode,
  SymbolOverview,
  SymbolReference,
} from "./types.js";

/**
 * Determine TypeScript ScriptKind from file extension
 */
function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".json":
      return ts.ScriptKind.JSON;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * Clean multi-line signature into a single-line summary
 */
function cleanSignature(rawSignature: string): string {
  return rawSignature
    .replace(/\r?\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect line ending used in content
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  if (crlfIndex === -1) return "\n";
  const lfIndex = content.indexOf("\n");
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

/**
 * Parse TypeScript / JavaScript code into AST Symbol Nodes
 */
function parseTypeScriptSymbols(filePath: string, content: string): SymbolNode[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath),
  );

  const symbols: SymbolNode[] = [];

  function getLine(pos: number): number {
    return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  }

  function visit(node: ts.Node, parentPath = ""): void {
    // 1. Function Declaration
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const namePath = parentPath ? `${parentPath}/${name}` : name;
      const startChar = node.getStart(sourceFile);
      const endChar = node.getEnd();
      const startLine = getLine(startChar);
      const endLine = getLine(endChar);

      let bodyRange: [number, number] | undefined;
      if (node.body) {
        bodyRange = [node.body.getStart(sourceFile), node.body.getEnd()];
      }

      const sigEnd = node.body ? node.body.getStart(sourceFile) : endChar;
      const signature = cleanSignature(content.slice(startChar, sigEnd));

      symbols.push({
        name,
        namePath,
        kind: "function",
        startLine,
        endLine,
        startChar,
        endChar,
        bodyRange,
        signature,
      });
      return;
    }

    // 2. Class Declaration
    if (ts.isClassDeclaration(node)) {
      const name = node.name ? node.name.text : "AnonymousClass";
      const namePath = parentPath ? `${parentPath}/${name}` : name;
      const startChar = node.getStart(sourceFile);
      const endChar = node.getEnd();
      const startLine = getLine(startChar);
      const endLine = getLine(endChar);

      const children: SymbolNode[] = [];

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          const methodName = member.name.getText(sourceFile);
          const mStart = member.getStart(sourceFile);
          const mEnd = member.getEnd();
          let mBody: [number, number] | undefined;
          if (member.body) {
            mBody = [member.body.getStart(sourceFile), member.body.getEnd()];
          }
          const sigEnd = member.body ? member.body.getStart(sourceFile) : mEnd;
          children.push({
            name: methodName,
            namePath: `${namePath}/${methodName}`,
            kind: "method",
            startLine: getLine(mStart),
            endLine: getLine(mEnd),
            startChar: mStart,
            endChar: mEnd,
            bodyRange: mBody,
            signature: cleanSignature(content.slice(mStart, sigEnd)),
          });
        } else if (ts.isConstructorDeclaration(member)) {
          const mStart = member.getStart(sourceFile);
          const mEnd = member.getEnd();
          let mBody: [number, number] | undefined;
          if (member.body) {
            mBody = [member.body.getStart(sourceFile), member.body.getEnd()];
          }
          const sigEnd = member.body ? member.body.getStart(sourceFile) : mEnd;
          children.push({
            name: "constructor",
            namePath: `${namePath}/constructor`,
            kind: "constructor",
            startLine: getLine(mStart),
            endLine: getLine(mEnd),
            startChar: mStart,
            endChar: mEnd,
            bodyRange: mBody,
            signature: cleanSignature(content.slice(mStart, sigEnd)),
          });
        } else if (ts.isPropertyDeclaration(member) && member.name) {
          const propName = member.name.getText(sourceFile);
          const mStart = member.getStart(sourceFile);
          const mEnd = member.getEnd();
          children.push({
            name: propName,
            namePath: `${namePath}/${propName}`,
            kind: "property",
            startLine: getLine(mStart),
            endLine: getLine(mEnd),
            startChar: mStart,
            endChar: mEnd,
            signature: cleanSignature(content.slice(mStart, mEnd)),
          });
        }
      }

      symbols.push({
        name,
        namePath,
        kind: "class",
        startLine,
        endLine,
        startChar,
        endChar,
        children,
        signature: `class ${name}`,
      });
      return;
    }

    // 3. Interface Declaration
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const namePath = parentPath ? `${parentPath}/${name}` : name;
      const startChar = node.getStart(sourceFile);
      const endChar = node.getEnd();
      symbols.push({
        name,
        namePath,
        kind: "interface",
        startLine: getLine(startChar),
        endLine: getLine(endChar),
        startChar,
        endChar,
        signature: cleanSignature(content.slice(startChar, Math.min(startChar + 100, endChar))),
      });
      return;
    }

    // 4. Type Alias Declaration
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const namePath = parentPath ? `${parentPath}/${name}` : name;
      const startChar = node.getStart(sourceFile);
      const endChar = node.getEnd();
      symbols.push({
        name,
        namePath,
        kind: "type",
        startLine: getLine(startChar),
        endLine: getLine(endChar),
        startChar,
        endChar,
        signature: cleanSignature(content.slice(startChar, Math.min(startChar + 80, endChar))),
      });
      return;
    }

    // 5. Enum Declaration
    if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      const namePath = parentPath ? `${parentPath}/${name}` : name;
      const startChar = node.getStart(sourceFile);
      const endChar = node.getEnd();
      symbols.push({
        name,
        namePath,
        kind: "enum",
        startLine: getLine(startChar),
        endLine: getLine(endChar),
        startChar,
        endChar,
        signature: `enum ${name}`,
      });
      return;
    }

    // 6. Variable statement (arrow functions, function expressions, or top-level constants)
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.text;
          const namePath = parentPath ? `${parentPath}/${name}` : name;
          const startChar = node.getStart(sourceFile);
          const endChar = node.getEnd();

          if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            const fn = decl.initializer;
            let bodyRange: [number, number] | undefined;
            if (fn.body) {
              bodyRange = [fn.body.getStart(sourceFile), fn.body.getEnd()];
            }
            const sigEnd = fn.body ? fn.body.getStart(sourceFile) : endChar;
            symbols.push({
              name,
              namePath,
              kind: "function",
              startLine: getLine(startChar),
              endLine: getLine(endChar),
              startChar,
              endChar,
              bodyRange,
              signature: cleanSignature(content.slice(startChar, sigEnd)),
            });
          }
        }
      }
      return;
    }

    ts.forEachChild(node, (child) => visit(child, parentPath));
  }

  visit(sourceFile);
  return symbols;
}

/**
 * Generic symbol scanner for Python, Go, Rust, Java, PHP, C/C++
 */
function parseGenericSymbols(filePath: string, content: string): SymbolNode[] {
  const ext = extname(filePath).toLowerCase();
  const lines = content.split(/\r?\n/);
  const symbols: SymbolNode[] = [];

  let offset = 0;
  const lineOffsets: number[] = [];
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1; // approx + newline
  }

  // Language regex definitions
  const pyDefRegex = /^[ \t]*(async\s+def|def)\s+([A-Za-z0-9_]+)\s*\(/;
  const pyClassRegex = /^[ \t]*class\s+([A-Za-z0-9_]+)\b/;

  const cLikeFnRegex = /^[ \t]*(?:(?:pub|public|protected|private|static|async|fn|func)\s+)*([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?:[^{]*)\{/;
  const cLikeClassRegex = /^[ \t]*(?:(?:pub|public|abstract|final)\s+)*(class|struct|interface|enum)\s+([A-Za-z0-9_]+)\b/;

  if (ext === ".py") {
    let currentClass: { name: string; indent: number; node: SymbolNode } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const indent = line.length - trimmed.length;

      if (currentClass && indent <= currentClass.indent) {
        currentClass = null;
      }

      const classMatch = pyClassRegex.exec(line);
      if (classMatch) {
        const name = classMatch[1];
        const startLine = i + 1;
        const startChar = lineOffsets[i];
        const node: SymbolNode = {
          name,
          namePath: name,
          kind: "class",
          startLine,
          endLine: startLine,
          startChar,
          endChar: startChar + line.length,
          signature: line.trim(),
          children: [],
        };
        symbols.push(node);
        currentClass = { name, indent, node };
        continue;
      }

      const defMatch = pyDefRegex.exec(line);
      if (defMatch) {
        const name = defMatch[2];
        const isMethod = currentClass !== null && indent > currentClass.indent;
        const namePath = isMethod ? `${currentClass!.name}/${name}` : name;
        const startLine = i + 1;
        const startChar = lineOffsets[i];

        // Find end of block by checking subsequent lines indentation
        let endLine = startLine;
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrimmed = lines[j].trimStart();
          if (!nextTrimmed || nextTrimmed.startsWith("#")) continue;
          const nextIndent = lines[j].length - nextTrimmed.length;
          if (nextIndent <= indent) break;
          endLine = j + 1;
        }

        const endChar = lineOffsets[endLine - 1] + (lines[endLine - 1]?.length ?? 0);
        const colonIdx = content.indexOf(":", startChar);
        const bodyRange: [number, number] | undefined =
          colonIdx !== -1 && colonIdx < endChar ? [colonIdx + 1, endChar] : undefined;

        const node: SymbolNode = {
          name,
          namePath,
          kind: isMethod ? "method" : "function",
          startLine,
          endLine,
          startChar,
          endChar,
          bodyRange,
          signature: line.trim(),
        };

        if (isMethod && currentClass?.node.children) {
          currentClass.node.children.push(node);
        } else {
          symbols.push(node);
        }
      }
    }

    return symbols;
  }

  // Generic C/C++/Java/Go/Rust matcher
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const classMatch = cLikeClassRegex.exec(line);
    if (classMatch) {
      const kind = classMatch[1] === "interface" ? "interface" : classMatch[1] === "enum" ? "enum" : "class";
      const name = classMatch[2];
      const startLine = i + 1;
      const startChar = lineOffsets[i];
      symbols.push({
        name,
        namePath: name,
        kind: kind as SymbolKind,
        startLine,
        endLine: startLine,
        startChar,
        endChar: startChar + line.length,
        signature: line.trim(),
      });
      continue;
    }

    const fnMatch = cLikeFnRegex.exec(line);
    if (fnMatch) {
      const name = fnMatch[1];
      if (name === "if" || name === "for" || name === "while" || name === "switch") continue;
      const startLine = i + 1;
      const startChar = lineOffsets[i];
      symbols.push({
        name,
        namePath: name,
        kind: "function",
        startLine,
        endLine: startLine,
        startChar,
        endChar: startChar + line.length,
        signature: line.trim(),
      });
    }
  }

  return symbols;
}

/**
 * Extract symbol hierarchy from any supported file
 */
export function extractSymbols(filePath: string, content: string): SymbolNode[] {
  const ext = extname(filePath).toLowerCase();
  const isJsTs = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);

  if (isJsTs) {
    try {
      return parseTypeScriptSymbols(filePath, content);
    } catch {
      return parseGenericSymbols(filePath, content);
    }
  }

  return parseGenericSymbols(filePath, content);
}

/**
 * Get symbol overview for a file
 */
export function getSymbolsOverview(
  filePath: string,
  content: string,
  maxDepth = 3,
): SymbolOverview {
  const rawSymbols = extractSymbols(filePath, content);

  function filterDepth(nodes: SymbolNode[], depth: number): SymbolNode[] {
    if (depth >= maxDepth) {
      return nodes.map((n) => ({ ...n, children: undefined }));
    }
    return nodes.map((n) => ({
      ...n,
      children: n.children ? filterDepth(n.children, depth + 1) : undefined,
    }));
  }

  const filtered = filterDepth(rawSymbols, 1);

  let totalCount = 0;
  function count(nodes: SymbolNode[]): void {
    for (const node of nodes) {
      totalCount += 1;
      if (node.children) count(node.children);
    }
  }
  count(rawSymbols);

  return {
    filePath,
    symbols: filtered,
    totalSymbols: totalCount,
  };
}

/**
 * Format symbols overview into a compact, token-efficient text outline
 */
export function formatSymbolsOverview(overview: SymbolOverview, lineCount: number): string {
  const lines: string[] = [
    `${overview.filePath} (${lineCount} lines, ${overview.totalSymbols} symbols):`,
  ];

  function renderNodes(nodes: SymbolNode[], indent = "  "): void {
    for (const node of nodes) {
      const lineRange = `[L${node.startLine}-L${node.endLine}]`;
      const sig = node.signature ? ` - ${node.signature}` : "";
      lines.push(`${indent}- [${node.kind}] ${node.namePath} ${lineRange}${sig}`);
      if (node.children && node.children.length > 0) {
        renderNodes(node.children, `${indent}  `);
      }
    }
  }

  if (overview.symbols.length === 0) {
    lines.push("  (No high-level functions or classes detected)");
  } else {
    renderNodes(overview.symbols);
  }

  return lines.join("\n");
}

/**
 * Find matching symbols by name or path pattern
 */
export function findSymbol(
  overview: SymbolOverview,
  content: string,
  namePattern: string,
  includeBody = false,
  substringMatching = true,
): SymbolMatch[] {
  const pattern = namePattern.toLowerCase().trim();
  const matches: SymbolMatch[] = [];

  function search(nodes: SymbolNode[]): void {
    for (const node of nodes) {
      const nodeName = node.name.toLowerCase();
      const nodePath = node.namePath.toLowerCase();

      let nameMatches = nodeName === pattern || nodePath === pattern;
      if (!nameMatches && substringMatching) {
        nameMatches = nodePath.includes(pattern) || nodeName.includes(pattern);
      }

      if (nameMatches) {
        let body: string | undefined;
        if (includeBody) {
          if (node.bodyRange) {
            body = content.slice(node.bodyRange[0], node.bodyRange[1]);
          } else {
            body = content.slice(node.startChar, node.endChar);
          }
        }

        matches.push({
          name: node.name,
          namePath: node.namePath,
          kind: node.kind,
          startLine: node.startLine,
          endLine: node.endLine,
          signature: node.signature,
          body,
          filePath: overview.filePath,
        });
      }

      if (node.children) {
        search(node.children);
      }
    }
  }

  search(overview.symbols);
  return matches;
}

/**
 * Find references / usages of a symbol within a file and associate each reference
 * with its enclosing symbol (function, method, class) and a 1-line context snippet.
 */
export function findReferencesInFile(
  filePath: string,
  content: string,
  symbolName: string,
): SymbolReference[] {
  const trimmedName = symbolName.trim();
  if (!trimmedName) return [];

  // Match identifier token with word boundaries
  // Escape regex special chars in case symbolName has any
  const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const identifierRegex = new RegExp(`\\b${escaped}\\b`, "g");

  // Get symbol overview of this file to find enclosing symbols
  const overview = getSymbolsOverview(filePath, content, 10);
  const flatSymbols = flattenSymbols(overview.symbols);

  const lines = content.split(/\r?\n/);
  const lineOffsets: number[] = [];
  let currentOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(currentOffset);
    // Find newline in original content
    currentOffset += lines[i].length;
    if (content[currentOffset] === "\r") currentOffset++;
    if (content[currentOffset] === "\n") currentOffset++;
  }

  const references: SymbolReference[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineText = lines[lineIdx];
    let match: RegExpExecArray | null;
    identifierRegex.lastIndex = 0;

    while ((match = identifierRegex.exec(lineText)) !== null) {
      const col = match.index + 1;
      const charOffset = lineOffsets[lineIdx] + match.index;
      const lineNum = lineIdx + 1;

      // Find enclosing symbol (the tightest symbol whose [startChar, endChar] contains this offset)
      let enclosing: SymbolNode | undefined;
      for (const s of flatSymbols) {
        // Exclude the symbol's own declaration name position
        if (s.name === trimmedName && s.startLine === lineNum) {
          continue;
        }
        if (charOffset >= s.startChar && charOffset <= s.endChar) {
          if (!enclosing || (s.endChar - s.startChar < enclosing.endChar - enclosing.startChar)) {
            enclosing = s;
          }
        }
      }

      references.push({
        filePath,
        referencingSymbol: enclosing?.namePath,
        kind: enclosing?.kind,
        line: lineNum,
        column: col,
        context: lineText.trim(),
      });
    }
  }

  return references;
}

/**
 * Flatten all symbols and their children into a flat list
 */
function flattenSymbols(nodes: SymbolNode[]): SymbolNode[] {
  const list: SymbolNode[] = [];
  function collect(items: SymbolNode[]): void {
    for (const item of items) {
      list.push(item);
      if (item.children) collect(item.children);
    }
  }
  collect(nodes);
  return list;
}

/**
 * Replace the body of a symbol by name or path
 */
export function replaceSymbolBody(
  filePath: string,
  content: string,
  symbolName: string,
  newBody: string,
): ReplaceSymbolResult {
  const overview = getSymbolsOverview(filePath, content, 10);
  const flat = flattenSymbols(overview.symbols);

  const trimmedTarget = symbolName.trim();
  const exactMatches = flat.filter(
    (s) => s.namePath === trimmedTarget || s.name === trimmedTarget,
  );

  if (exactMatches.length === 0) {
    const fuzzyMatches = flat.filter(
      (s) =>
        s.name.toLowerCase().includes(trimmedTarget.toLowerCase()) ||
        s.namePath.toLowerCase().includes(trimmedTarget.toLowerCase()),
    );
    if (fuzzyMatches.length === 1) {
      exactMatches.push(fuzzyMatches[0]);
    } else if (fuzzyMatches.length > 1) {
      return {
        success: false,
        newContent: content,
        error: `Symbol '${symbolName}' is ambiguous. Found ${fuzzyMatches.length} candidates: ${fuzzyMatches.map((s) => s.namePath).join(", ")}. Please specify the exact namePath.`,
      };
    } else {
      return {
        success: false,
        newContent: content,
        error: `Symbol '${symbolName}' was not found in ${filePath}. Available symbols: ${flat.map((s) => s.namePath).slice(0, 15).join(", ")}${flat.length > 15 ? "..." : ""}`,
      };
    }
  }

  if (exactMatches.length > 1) {
    return {
      success: false,
      newContent: content,
      error: `Multiple symbols matched '${symbolName}': ${exactMatches.map((s) => `${s.namePath} (line ${s.startLine})`).join(", ")}. Use full namePath to disambiguate.`,
    };
  }

  const target = exactMatches[0];
  if (!target.bodyRange) {
    return {
      success: false,
      newContent: content,
      error: `Symbol '${target.namePath}' has no replaceable body block (kind: ${target.kind}).`,
    };
  }

  const [bodyStart, bodyEnd] = target.bodyRange;
  const lineEnding = detectLineEnding(content);

  // Determine if newBody is wrapped in { ... } or bare statements
  let formattedBody = newBody.trim();
  if (formattedBody.startsWith("{") && formattedBody.endsWith("}")) {
    // Keep as provided
  } else {
    // Wrap in braces with appropriate formatting
    formattedBody = `{\n  ${formattedBody.split("\n").join("\n  ")}\n}`;
  }

  if (lineEnding === "\r\n") {
    formattedBody = formattedBody.replace(/\r?\n/g, "\r\n");
  }

  const newContent = content.slice(0, bodyStart) + formattedBody + content.slice(bodyEnd);

  return {
    success: true,
    newContent,
    replacedSymbol: target,
  };
}

/**
 * Insert a new symbol before or after an existing symbol
 */
export function insertSymbol(
  filePath: string,
  content: string,
  targetSymbolName: string,
  position: "before" | "after",
  code: string,
): InsertSymbolResult {
  const overview = getSymbolsOverview(filePath, content, 10);
  const flat = flattenSymbols(overview.symbols);

  const trimmed = targetSymbolName.trim();
  const matches = flat.filter((s) => s.namePath === trimmed || s.name === trimmed);

  if (matches.length === 0) {
    return {
      success: false,
      newContent: content,
      error: `Target symbol '${targetSymbolName}' not found in ${filePath}.`,
    };
  }

  if (matches.length > 1) {
    return {
      success: false,
      newContent: content,
      error: `Target symbol '${targetSymbolName}' is ambiguous: ${matches.map((s) => s.namePath).join(", ")}.`,
    };
  }

  const target = matches[0];
  const lineEnding = detectLineEnding(content);
  let insertPos: number;

  if (position === "before") {
    insertPos = target.startChar;
  } else {
    insertPos = target.endChar;
  }

  let codeBlock = code.trim();
  if (lineEnding === "\r\n") {
    codeBlock = codeBlock.replace(/\r?\n/g, "\r\n");
  }

  const separator = `${lineEnding}${lineEnding}`;
  const prefix = position === "before" ? `${codeBlock}${separator}` : `${separator}${codeBlock}`;
  const newContent = content.slice(0, insertPos) + prefix + content.slice(insertPos);

  return {
    success: true,
    newContent,
    insertedAtLine: position === "before" ? target.startLine : target.endLine + 1,
  };
}
