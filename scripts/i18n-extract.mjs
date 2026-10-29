// Collects every message the UI translates — the literal first argument of t(), tx() and tRich() in
// src/ and app/ — into src/lib/i18n/messages.json (key -> the files that use it), and reports, per
// locale catalog, which keys are missing and which are no longer used.
//
//   npm run i18n:extract            write messages.json, report
//   npm run i18n:extract -- --prune also drop unused keys from the locale catalogs
//
// A t() call whose first argument is not a literal is not collectable; the script lists those so the
// string can be marked with tx() where it is defined.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const DIR = path.join(ROOT, "src/lib/i18n");
const LOCALES = ["zh", "ja", "pt-br", "de", "es", "fr", "vi"];
const FNS = new Set(["t", "tx", "tRich"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

export function extract() {
  const keys = new Map();
  const dynamic = [];
  for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "app"))]) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && FNS.has(node.expression.text)) {
        const a = node.arguments[0];
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
          if (!keys.has(a.text)) keys.set(a.text, new Set());
          keys.get(a.text).add(rel);
        } else if (a && node.expression.text !== "tx") {
          const { line } = src.getLineAndCharacterOfPosition(node.getStart());
          dynamic.push(`${rel}:${line + 1}  ${node.getText().slice(0, 90)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
  return { keys, dynamic };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  const prune = process.argv.includes("--prune");
  const { keys, dynamic } = extract();
  const sorted = [...keys.keys()].sort();
  const messages = Object.fromEntries(sorted.map((k) => [k, [...keys.get(k)].sort()]));
  fs.writeFileSync(path.join(DIR, "messages.json"), JSON.stringify(messages, null, 2) + "\n");
  console.log(`${sorted.length} messages`);
  for (const l of LOCALES) {
    const f = path.join(DIR, `${l}.json`);
    const cat = JSON.parse(fs.readFileSync(f, "utf8"));
    const missing = sorted.filter((k) => !(k in cat));
    const unused = Object.keys(cat).filter((k) => !keys.has(k));
    console.log(`${l}: ${missing.length} missing, ${unused.length} unused`);
    if (prune && unused.length) {
      for (const k of unused) delete cat[k];
      fs.writeFileSync(f, JSON.stringify(cat, null, 2) + "\n");
    }
  }
  if (dynamic.length) {
    console.log(`\n${dynamic.length} t() calls with a non-literal key (make sure the string is marked with tx()):`);
    for (const d of dynamic) console.log("  " + d);
  }
}
