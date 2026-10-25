// Regression guard for direct raw error rendering. This complements, not replaces,
// the manual producer -> state -> view audit and fault-injected browser tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = new URL('../src/', import.meta.url);
async function sources(dir) {
  return (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => {
    const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith('.tsx') ? [file] : [];
  }))).flat();
}

const safeCalls = new Set(['userErrorMessage', 'accountErrorMessage']);
// Reviewed sources: these values contain local validation / already sanitized text.
// Keep exemptions at the exact field + component, not at a directory or filename pattern.
const reviewed = new Set([
  'components/CanvasAssetDeleteDialog.tsx:error', // Each per-file failure is sanitized before joining.
  'components/CreationBoard.tsx:referenceError', // Local image-input validation + user asset names.
  'components/GenerationPanel.tsx:referenceError', // Same local validation helper.
  'components/OnboardingTour.tsx:error', // Fixed Chinese instructions only.
  'components/ProjectDeleteDialog.tsx:previewError', // Fixed scan failure instructions only.
  'components/ScreenshotSettings.tsx:error', // Every IPC failure sanitized on assignment.
  'components/SettingsDialog.tsx:migrateError', // Sanitized on assignment.
  'components/WorkflowAgentDetail.tsx:progressError', // Fixed Chinese status only.
]);
function rawFields(node, source) {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return [];
  if (ts.isCallExpression(node) && safeCalls.has(node.expression.getText(source))) return [];
  if (ts.isConditionalExpression(node)) return [...rawFields(node.whenTrue, source), ...rawFields(node.whenFalse, source)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return rawFields(node.right, source);
  if (ts.isArrowFunction(node) || ts.isPrefixUnaryExpression(node)) return [];
  if (ts.isPropertyAccessExpression(node) && /^(?:error|last_error|error_code|safe_message|stderr)$/.test(node.name.text)) return [node.getText(source)];
  if (ts.isIdentifier(node) && /^(?:error|\w+Error|failedNotice|failureMessage|errorText)$/.test(node.text)) return [node.text];
  return node.getChildren(source).flatMap(child => rawFields(child, source));
}

test('JSX error text and tooltip boundaries do not render raw errors', async () => {
  const findings = [];
  for (const url of await sources(root)) {
    const file = path.relative(new URL(root).pathname, url.pathname).replaceAll('\\', '/');
    const source = ts.createSourceFile(file, await readFile(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isJsxExpression(node) && node.expression) {
        const attr = node.parent;
        // Only rendered text and accessible descriptions are message sinks.
        if (!ts.isJsxAttribute(attr) || /^(?:title|aria-label|alt)$/.test(attr.name.getText(source))) {
          for (const field of rawFields(node.expression, source)) {
            if (!reviewed.has(`${file}:${field}`)) findings.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${field}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.deepEqual(findings, []);
});

test('boundary guard recognizes direct fields, fallback expressions and safe wrappers', () => {
  const source = ts.createSourceFile('example.tsx', '<p>{task.error || "失败"}{userErrorMessage(task.error, "任务失败")}{error && <b>{error}</b>}</p>', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  function visit(node) {
    if (ts.isJsxExpression(node) && node.expression) findings.push(...rawFields(node.expression, source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual(findings, ['task.error', 'error']);
});
