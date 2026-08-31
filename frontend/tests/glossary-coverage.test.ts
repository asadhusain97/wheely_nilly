import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');
const sourceFiles = [
  'frontend/assets/js/app.js',
  'frontend/assets/js/screener.js',
  'frontend/assets/js/settings.js',
];

const termArgumentByFunction = new Map([
  ['appendLabeledAmount', 3],
  ['createGlossaryTerm', 1],
  ['detailMetric', 2],
  ['detailRow', 2],
  ['glossaryLabel', 1],
  ['summaryMetric', 2],
  ['tickerKpi', 2],
  ['tradesGlossaryLabel', 1],
]);

function stringValue(node: ts.Node | undefined) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function glossaryTerms() {
  const terms = new Set<string>();
  for (const relativePath of sourceFiles) {
    const source = readFileSync(path.join(root, relativePath), 'utf8');
    const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const argumentIndex = termArgumentByFunction.get(node.expression.text);
        const term = argumentIndex == null ? null : stringValue(node.arguments[argumentIndex]);
        if (term) terms.add(term);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.name.text === 'GLOSSARY_TERM_BY_RULE_KEY' && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property)) {
            const term = stringValue(property.initializer);
            if (term) terms.add(term);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    if (relativePath.endsWith('/app.js')) {
      const initializer = source.slice(
        source.indexOf('function initializeHomeGlossaryTerms'),
        source.indexOf('\n}', source.indexOf('function initializeHomeGlossaryTerms')),
      );
      for (const match of initializer.matchAll(/\['#[^']+',\s*'([^']+)'\]/g)) terms.add(match[1]);
    }
  }
  return [...terms].sort();
}

function glossaryEntryText() {
  const html = readFileSync(path.join(root, 'frontend/app.html'), 'utf8');
  const glossary = html.slice(html.indexOf('id="glossary-dialog"'), html.indexOf('<nav class="bottom-nav"'));
  return [...glossary.matchAll(/<div class="glossary-entry">([\s\S]*?)<\/div>/g)]
    .map(([, entry]) => entry
      .replace(/<[^>]+>/g, ' ')
      .replaceAll('&amp;', '&')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase());
}

test('every glossary underline resolves to at least one definition', () => {
  const entries = glossaryEntryText();
  const missing = glossaryTerms().filter((term) =>
    !entries.some((entry) => entry.includes(term.toLocaleLowerCase())));

  assert.deepEqual(missing, [], `Glossary triggers without definitions: ${missing.join(', ')}`);
});
