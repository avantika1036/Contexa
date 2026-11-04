import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'webex-uia-snapshot.ps1');
const script = await readFile(scriptPath, 'utf8');

test('Webex UIA helper uses Windows PowerShell 5.1-compatible PropertyCondition construction', () => {
  assert.match(script, /New-Object\s+System\.Windows\.Automation\.PropertyCondition\s*\(/);
  assert.doesNotMatch(script, /PropertyCondition\]::new\s*\(/);
});

test('Webex UIA helper catches expected probe errors and always emits a JSON result', () => {
  assert.match(script, /catch\s*\{[\s\S]*?\$result\.inspected\s*=\s*\$false/);
  assert.match(script, /\[Console\]::Out\.WriteLine\(\(ConvertTo-Json/);
  assert.match(script, /exit\s+0\s*$/);
});

test('Webex UIA helper only inspects meeting-control names and does not serialize private process metadata', () => {
  assert.match(script, /@\('End meeting', 'Leave meeting', 'End call', 'Leave call'\)/i);
  assert.doesNotMatch(script, /ConvertTo-Json[^\n]*(?:commandLine|ExecutablePath)/i);
  assert.match(script, /webexExecutablePathVerified|executablePathVerified/);
});


test('Webex UIA helper resolves the top-level host window before scanning its controls', () => {
  assert.match(script, /TreeScope\]::Children/);
  assert.match(script, /\$hostWindow\.FindFirst\(/);
  assert.doesNotMatch(script, /RootElement\.FindAll\([\s\S]{0,180}TreeScope\]::Descendants/);
});

test('Webex UIA helper searches control names in one combined tree traversal', () => {
  assert.match(script, /System\.Windows\.Automation\.OrCondition/);
  assert.match(script, /combinedNameCondition/);
  assert.equal((script.match(/\.FindFirst\(/g) || []).length, 1);
});

test('Webex UIA helper reports bounded probe duration for diagnostics', () => {
  assert.match(script, /Stopwatch/);
  assert.match(script, /elapsedMs/);
});
