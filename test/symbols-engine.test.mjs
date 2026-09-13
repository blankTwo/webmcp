import assert from "node:assert";
import {
  extractSymbols,
  getSymbolsOverview,
  formatSymbolsOverview,
  findSymbol,
  replaceSymbolBody,
  insertSymbol,
  checkSyntaxDiagnostics,
  applySmartEdit,
} from "../dist/symbols/index.js";
import { resolveAllowedPath, expandHomePath } from "../dist/roots.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

console.log("Starting WebMCP Semantic IDE & Symbol Engine tests...");

// Test 1: Path sanitization
console.log("\nTest 1: Windows Backslash Path Sanitization");
const allowed = resolveAllowedPath("dist\\index.js", process.cwd(), [process.cwd()]);
assert(allowed.includes("dist"), "Path should resolve correctly");
console.log("✓ resolveAllowedPath successfully normalizes backslashes: ", allowed);

// Test 2: Symbol Extraction from JS/TS
console.log("\nTest 2: AST Symbol Extraction");
const tsCode = `
export interface UserProfile {
  id: string;
  name: string;
}

export type Role = "admin" | "user";

export function createService(endpoint: string) {
  return { endpoint };
}

export class UserManager {
  private users: UserProfile[] = [];

  constructor(private adminRole: Role) {}

  public async registerUser(name: string): Promise<string> {
    const id = "usr_" + Date.now();
    this.users.push({ id, name });
    return id;
  }

  public getUser(id: string): UserProfile | undefined {
    return this.users.find(u => u.id === id);
  }
}
`;

const overview = getSymbolsOverview("test.ts", tsCode);
assert.strictEqual(overview.totalSymbols, 8, "Should find 8 symbols (4 top-level + 4 class members)");
const formatted = formatSymbolsOverview(overview, 24);
console.log(formatted);
assert(formatted.includes("[interface] UserProfile"));
assert(formatted.includes("[class] UserManager"));
assert(formatted.includes("[method] UserManager/registerUser"));
console.log("✓ AST Symbol Extraction passed!");

// Test 3: findSymbol with body extraction
console.log("\nTest 3: findSymbol");
const matches = findSymbol(overview, tsCode, "registerUser", true);
assert.strictEqual(matches.length, 1);
assert.strictEqual(matches[0].name, "registerUser");
assert(matches[0].body?.includes("this.users.push"), "Body must contain implementation");
console.log("✓ findSymbol found:", matches[0].namePath, "with body length:", matches[0].body?.length);

// Test 4: replaceSymbolBody
console.log("\nTest 4: replaceSymbolBody");
const replaceRes = replaceSymbolBody(
  "test.ts",
  tsCode,
  "UserManager/registerUser",
  "const id = 'mock_id_123';\nreturn id;"
);
assert.strictEqual(replaceRes.success, true);
assert(replaceRes.newContent.includes("const id = 'mock_id_123';"), "Replacement text present");
assert(!replaceRes.newContent.includes("this.users.push"), "Old body removed");
console.log("✓ replaceSymbolBody successfully replaced method body!");

// Test 5: insertSymbol
console.log("\nTest 5: insertSymbol");
const insertRes = insertSymbol(
  "test.ts",
  replaceRes.newContent,
  "UserManager",
  "after",
  "export function helper() {\n  return 42;\n}"
);
assert.strictEqual(insertRes.success, true);
assert(insertRes.newContent.includes("export function helper()"));
console.log("✓ insertSymbol successfully inserted symbol at line", insertRes.insertedAtLine);

// Test 6: Syntax Diagnostics on Edit
console.log("\nTest 6: Syntax Diagnostics on Edit");
const validDiag = checkSyntaxDiagnostics("test.ts", insertRes.newContent);
assert.strictEqual(validDiag.valid, true, "Modified code should be syntactically valid");

const brokenDiag = checkSyntaxDiagnostics("test.ts", insertRes.newContent + "\nfunction broken() { if (true) {");
assert.strictEqual(brokenDiag.valid, false, "Broken code should be caught by diagnostics");
assert(brokenDiag.formattedSummary?.includes("TS1005") || brokenDiag.formattedSummary?.includes("expected"));
console.log("✓ Syntax diagnostics successfully caught syntax error:", brokenDiag.formattedSummary?.split("\n")[1]);

// Test 7: applySmartEdit with CRLF and Regex wildcard
console.log("\nTest 7: Smart Edit with CRLF and Regex wildcard (.*?)");
const tmpFile = path.join(os.tmpdir(), "smart_edit_test_" + Date.now() + ".js");
const crlfFileContent = "function generateKey(seed) {\r\n  let salt = 'abc';\r\n  let hash = salt + seed;\r\n  return hash;\r\n}\r\n";
fs.writeFileSync(tmpFile, crlfFileContent, "utf8");

// Use .*? non-greedy wildcard matching
const smartResult = await applySmartEdit(tmpFile, [
  {
    oldText: "function generateKey(seed) {\n  let salt.*?return hash;\n}",
    newText: "function generateKey(seed) {\n  return 'super_key_' + seed;\n}",
  }
]);

assert.strictEqual(smartResult.success, true, "Smart edit should succeed via wildcard");
const updatedOnDisk = fs.readFileSync(tmpFile, "utf8");
assert(updatedOnDisk.includes("super_key_"), "Updated content must be on disk");
assert(updatedOnDisk.includes("\r\n"), "CRLF line endings must be preserved");
fs.unlinkSync(tmpFile);
console.log("✓ applySmartEdit with CRLF and non-greedy regex wildcard passed!");

// Test 8: applySmartEdit with fuzzy whitespace and indentation mismatch
console.log("\nTest 8: Smart Edit with fuzzy whitespace and indentation tolerance");
const tmpFile2 = path.join(os.tmpdir(), "smart_edit_fuzzy_" + Date.now() + ".html");
const htmlContent = `
<div class="card-container">
    <div class="user-info">
        <span class="username">Alice</span>
        <span class="role">Admin</span>
    </div>
</div>
`;
fs.writeFileSync(tmpFile2, htmlContent, "utf8");

// oldText has 2-space indentation instead of 4-space indentation
const fuzzyResult = await applySmartEdit(tmpFile2, [
  {
    oldText: '  <div class="user-info">\n    <span class="username">Alice</span>\n    <span class="role">Admin</span>\n  </div>',
    newText: '  <div class="user-info updated">\n    <span class="username">Alice V2</span>\n  </div>',
  }
]);

assert.strictEqual(fuzzyResult.success, true, "Fuzzy whitespace edit should succeed");
const updatedHtml = fs.readFileSync(tmpFile2, "utf8");
assert(updatedHtml.includes("Alice V2"), "Updated HTML content must be on disk");
fs.unlinkSync(tmpFile2);
console.log("✓ applySmartEdit with fuzzy whitespace and indentation passed!");

console.log("\n=================================================");
console.log("🎉 ALL SEMANTIC ENGINE TESTS PASSED SUCCESSFULLY!");
console.log("=================================================");
