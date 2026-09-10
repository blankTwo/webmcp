export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "constructor"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "property";

export interface SymbolNode {
  name: string;
  namePath: string; // e.g. "MyClass/myMethod" or "calculateSignature"
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  bodyRange?: [number, number]; // [startChar, endChar] of the function or class body
  signature?: string;
  docstring?: string;
  children?: SymbolNode[];
}

export interface SymbolOverview {
  filePath: string;
  symbols: SymbolNode[];
  totalSymbols: number;
}

export interface SymbolMatch {
  name: string;
  namePath: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  body?: string;
  filePath?: string;
}

export interface SymbolReference {
  filePath: string;
  referencingSymbol?: string;
  kind?: SymbolKind;
  line: number;
  column: number;
  context: string;
}

export interface ReplaceSymbolResult {
  success: boolean;
  newContent: string;
  replacedSymbol?: SymbolNode;
  error?: string;
}

export interface InsertSymbolResult {
  success: boolean;
  newContent: string;
  insertedAtLine?: number;
  error?: string;
}

export interface SyntaxDiagnostic {
  line: number;
  character: number;
  message: string;
}

export interface FileDiagnosticsResult {
  valid: boolean;
  diagnostics: SyntaxDiagnostic[];
  formattedSummary?: string;
}
