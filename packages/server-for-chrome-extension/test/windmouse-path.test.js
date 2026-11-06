const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(
  path.join(__dirname, '..', '..', 'chrome-extension-unpacked', 'utils', 'windmouse.js')
).href;

test('shouldAbandonPath keeps following the path while moves ack quickly', async () => {
  const { shouldAbandonPath } = await import(modUrl);
  assert.strictEqual(shouldAbandonPath({ moveMs: 5, elapsedMs: 400, plannedMs: 600 }), false);
});

test('shouldAbandonPath gives up when a move acks slowly (renderer not producing frames)', async () => {
  const { shouldAbandonPath } = await import(modUrl);
  // Frame-starved Discord tab: each mouseMoved acked after ~1 s, so a 53-point
  // path took 53 s and the click landed after the 30 s command timeout.
  assert.strictEqual(shouldAbandonPath({ moveMs: 1000, elapsedMs: 1000, plannedMs: 600 }), true);
});

test('shouldAbandonPath gives up when many moderately slow moves overrun the plan', async () => {
  const { shouldAbandonPath, PATH_OVERRUN_MS } = await import(modUrl);
  assert.strictEqual(shouldAbandonPath({ moveMs: 100, elapsedMs: 600 + PATH_OVERRUN_MS + 1, plannedMs: 600 }), true);
});

test('a long path stays far longer than the command timeout at one move per second', async () => {
  const { generateWindMousePath } = await import(modUrl);
  // Same geometry as the live failure: channel header -> member-list row.
  const pts = generateWindMousePath(700, 24, 1404, 230);
  assert.ok(pts.length > 30, `expected > 30 points, got ${pts.length}`);
});
