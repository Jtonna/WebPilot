const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(
  path.join(__dirname, '..', '..', 'chrome-extension-unpacked', 'utils', 'click-geometry.js')
).href;
const vp = { width: 1000, height: 800 };

test('quadBounds returns axis-aligned bounds', async () => {
  const { quadBounds } = await import(modUrl);
  assert.deepStrictEqual(quadBounds([10, 20, 50, 20, 50, 60, 10, 60]), { left: 10, top: 20, right: 50, bottom: 60 });
});

test('visibleCenter clicks the visible part of a node clipped at the top edge', async () => {
  const { visibleCenter } = await import(modUrl);
  // Folder box y -24..24: raw center is y=0, visible part 0..24 -> y=12.
  const c = visibleCenter({ left: 0, top: -24, right: 72, bottom: 24 }, { left: 0, top: 0, right: 72, bottom: 700 }, vp);
  assert.deepStrictEqual(c, { x: 36, y: 12 });
});

test('visibleCenter honours the scroll container clip below the viewport top', async () => {
  const { visibleCenter } = await import(modUrl);
  const c = visibleCenter({ left: 0, top: 80, right: 72, bottom: 128 }, { left: 0, top: 100, right: 72, bottom: 700 }, vp);
  assert.strictEqual(c.y, 114);
});

test('visibleCenter returns null when fully hidden and accepts 0 coordinates', async () => {
  const { visibleCenter } = await import(modUrl);
  assert.strictEqual(visibleCenter({ left: 0, top: -50, right: 10, bottom: -10 }, null, vp), null);
  assert.deepStrictEqual(visibleCenter({ left: 0, top: 0, right: 0.5, bottom: 1 }, null, vp), { x: 0, y: 1 });
});
