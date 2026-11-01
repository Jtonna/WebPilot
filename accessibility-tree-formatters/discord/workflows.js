'use strict';

/**
 * Discord workflows for WebPilot's server-side workflow execution engine.
 *
 * Each workflow is registered with the formatter-manager when this file
 * lives alongside the formatter's `discord.js` entry. The manifest.json
 * MUST declare the workflow under `workflows[]` with matching metadata
 * (name, description, parameters); otherwise the manager logs a warning
 * and skips the implementation.
 *
 * Workflows run server-side and receive a `browser` primitive object that
 * wraps the same internal helpers used by the MCP tool dispatch — so
 * workflows benefit from auth, per-agent profile routing, the visual
 * cursor, etc., without any HTTP/SSE roundtrip overhead.
 *
 * Composer detection note:
 *   The Discord formatter (`discord.js`) emits the composer textbox as a
 *   line of the form `[eN] Message @<recipient> textbox` (DM) or
 *   `[eN] Message #<channel> textbox` (server channel) in the formatted
 *   tree string. Older formatter versions (pre-1.1.0) emitted just
 *   `[eN] Message textbox` without the discriminating prefix.
 *
 *   We match on `name_starts_with: 'Message ' + role: 'textbox'` which
 *   catches both shapes — `Message textbox` (legacy) and
 *   `Message @<x> textbox` / `Message #<x> textbox` (current) — without
 *   false-positiving on other Discord textboxes (search, profile note,
 *   etc.) because none of those have an accessible name beginning with
 *   the literal word "Message ".
 *
 * Sidebar workflows (check_sidebar, open_server, check_dm_list):
 *   Clicks on a background tab can take many seconds and may time out yet
 *   still apply late, so a click error is treated as ambiguous: the
 *   workflows swallow it and verify state by polling. Refs are scoped to the
 *   latest tree fetch, so a fresh tree is fetched before each click. Every
 *   wait honours a `timeoutMs` budget; on expiry a structured
 *   `{ pending: true }` result is returned instead of throwing.
 *
 * NOTE: the helpers below are intentionally NOT exported — the formatter
 * manager treats every export as a workflow.
 */

const HOME_SELECTOR = '[data-list-item-id="guildsnav___home"]';
const DEFAULT_TIMEOUT_MS = 42000;
const PENDING_MESSAGE =
  'Timed out waiting for Discord; a late click may still apply — re-read state ' +
  '(e.g. call check_sidebar or get the tree) before retrying.';
const TIMEOUT_PARAM = {
  type: 'number',
  description: 'Overall time budget in ms (default 42000, clamped to 1000..45000).'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Timing context shared by every poll/wait in a workflow run. */
function makeCtx(params, browser, tabId) {
  let t = params && params.timeoutMs;
  t = typeof t === 'number' && Number.isFinite(t) ? t : DEFAULT_TIMEOUT_MS;
  t = Math.min(45000, Math.max(1000, t));
  return {
    browser,
    tabId,
    deadline: Date.now() + t,
    interval: Math.min(750, t / 10)
  };
}

function remaining(ctx) {
  return ctx.deadline - Date.now();
}

/** Sleep one poll interval, never beyond the deadline. */
function pollWait(ctx) {
  return sleep(Math.min(ctx.interval, Math.max(0, remaining(ctx))));
}

function normalize(s) {
  const base = String(s == null ? '' : s).normalize('NFKC').toLowerCase();
  const stripped = base
    .replace(/[\p{Extended_Pictographic}\p{S}\p{P}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // All-emoji / all-symbol names would normalize to '' — keep them distinct.
  return stripped || base.replace(/\s+/g, ' ').trim();
}

/** Escape a value for use inside [data-dnd-name="..."]. */
function cssAttr(value) {
  return String(value)
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\u0000-\u001f\u007f]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Up to `limit` server names closest to the normalized query `q`. */
function closeMatches(servers, q, limit = 5) {
  return servers
    .map((s) => {
      const n = normalize(s.name);
      const sub = n.includes(q) || q.includes(n);
      return { name: s.name, score: levenshtein(n, q) - (sub ? 1000 : 0) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((m) => m.name);
}

/**
 * Resolve a server by name: exact normalized match first, then a unique
 * substring match. Returns { kind: 'ok'|'none'|'ambiguous', server, error }.
 * Never silently picks among several candidates.
 */
function resolveServer(servers, name) {
  const list = Array.isArray(servers) ? servers : [];
  const q = normalize(name);
  const exact = list.filter((s) => normalize(s.name) === q);
  if (exact.length === 1) return { kind: 'ok', server: exact[0] };
  let kind;
  let hits;
  if (exact.length > 1) {
    kind = 'ambiguous';
    hits = exact;
  } else {
    const subs = q ? list.filter((s) => normalize(s.name).includes(q)) : [];
    if (subs.length === 1) return { kind: 'ok', server: subs[0] };
    kind = subs.length > 1 ? 'ambiguous' : 'none';
    hits = subs;
  }
  const pool = hits.length ? hits : list;
  const candidates = pool.length ? closeMatches(pool, q) : [];
  const what = kind === 'ambiguous' ? 'matches several servers' : 'matches no server';
  return {
    kind,
    error: new Error(
      `Server name "${name}" ${what}.` +
      (candidates.length
        ? ` Close matches: ${candidates.map((c) => JSON.stringify(c)).join(', ')}.`
        : '')
    )
  };
}

async function safeClick(browser, args) {
  try {
    await browser.click(args);
    return { clicked: true, error: null };
  } catch (err) {
    return { clicked: false, error: err };
  }
}

function fetchTree(ctx) {
  return ctx.browser.getAccessibilityTree({ tab_id: ctx.tabId });
}

function foldersOf(tree) {
  return (tree && tree.folders) || [];
}

function serversOf(tree) {
  return (tree && tree.servers) || [];
}

/**
 * Expand every collapsed server folder (max 3 rounds). Re-fetches the tree
 * before each click so refs are fresh, and never re-clicks an expanded one.
 * Folders are not restored afterwards. Returns { tree, pending, warnings }.
 */
async function expandCollapsedFolders(ctx) {
  let tree = await fetchTree(ctx);
  for (let round = 0; round < 3; round++) {
    const collapsed = foldersOf(tree).filter((f) => f.expanded === false);
    if (collapsed.length === 0) break;
    for (const f of collapsed) {
      if (remaining(ctx) <= 0) return { tree, pending: true, warnings: [] };
      tree = await fetchTree(ctx);
      let cur = foldersOf(tree).find((x) => x.name === f.name);
      if (!cur || cur.expanded !== false || !cur.ref) continue;
      await safeClick(ctx.browser, { ref: cur.ref, tab_id: ctx.tabId });
      for (;;) {
        await pollWait(ctx);
        tree = await fetchTree(ctx);
        cur = foldersOf(tree).find((x) => x.name === f.name);
        if (!cur || cur.expanded !== false) break;
        if (remaining(ctx) <= 0) return { tree, pending: true, warnings: [] };
      }
    }
    tree = await fetchTree(ctx);
  }
  const warnings = foldersOf(tree)
    .filter((f) => f.expanded === false)
    .map((f) => `Folder "${f.name}" is still collapsed; its servers are not listed.`);
  return { tree, pending: false, warnings };
}

async function getTabUrl(ctx) {
  const tabs = await ctx.browser.getTabs();
  const list = Array.isArray(tabs) ? tabs : (tabs && tabs.tabs) || [];
  const tab = list.find((t) => t.id === ctx.tabId);
  return tab ? tab.url || '' : '';
}

module.exports = {
  send_message: {
    description: 'Compose a message in the active Discord channel and send it.',
    parameters: {
      text: {
        type: 'string',
        description: 'The message text to send.'
      }
    },
    async run({ params, browser, tabId, findInTree }) {
      if (!params || typeof params.text !== 'string' || params.text.length === 0) {
        throw new Error('send_message requires non-empty params.text (string).');
      }
      if (typeof tabId !== 'number') {
        throw new Error('send_message requires tab_id (number).');
      }

      // Fetch the formatted tree. The Discord formatter emits the composer
      // as `[eN] Message @<recipient> textbox` (DM) or
      // `[eN] Message #<channel> textbox` (server channel). See
      // discord.js formatComposerLine. Pre-1.1.0 formatters emitted just
      // `[eN] Message textbox`; the selector below matches both shapes.
      const tree = await browser.getAccessibilityTree({ tab_id: tabId });

      const composer = findInTree(tree, {
        name_starts_with: 'Message ',
        role: 'textbox'
      });

      if (!composer) {
        throw new Error(
          'Composer textbox not found — is a Discord channel or DM selected? ' +
          'Expected a line starting with "Message " and containing "textbox" ' +
          'in the formatted tree (e.g. "[eN] Message @user textbox" for DMs).'
        );
      }

      await browser.click({ ref: composer.ref, tab_id: tabId });
      await browser.type({
        ref: composer.ref,
        text: params.text,
        tab_id: tabId,
        pressEnter: true
      });

      return { sent: true, composerRef: composer.ref };
    }
  },

  check_sidebar: {
    description:
      'List Discord servers in the left sidebar (name, ref, mentions, unread, inFolder) and folders. ' +
      'Expands collapsed server folders by default so their servers are listed (folders are left expanded). ' +
      'Works on any Discord page. If it returns pending:true it timed out; a late click may still apply, ' +
      'so re-read state (call check_sidebar again or get the tree) before retrying.',
    parameters: {
      expandFolders: {
        type: 'boolean',
        description: 'Expand collapsed server folders so their servers are listed (default true).'
      },
      timeoutMs: TIMEOUT_PARAM
    },
    async run({ params, browser, tabId }) {
      if (typeof tabId !== 'number') {
        throw new Error('check_sidebar requires tab_id (number).');
      }
      const p = params || {};
      const ctx = makeCtx(p, browser, tabId);
      let tree;
      let warnings = [];
      let pending = false;
      if (p.expandFolders === false) {
        tree = await fetchTree(ctx);
      } else {
        const r = await expandCollapsedFolders(ctx);
        tree = r.tree;
        warnings = r.warnings;
        pending = r.pending;
      }
      const servers = serversOf(tree);
      const result = { servers, folders: foldersOf(tree), serverCount: servers.length };
      if (pending) return { pending: true, message: PENDING_MESSAGE, ...result };
      if (warnings.length) result.warnings = warnings;
      return result;
    }
  },

  open_server: {
    description:
      'Open a Discord server by name. Matching tolerates differences in case, emoji and punctuation, and ' +
      'accepts a unique partial name; ambiguous or unknown names return an error listing close matches. ' +
      'Expands collapsed folders if the server is not visible. Returns { serverId, channelId, name, url, verified }, ' +
      'or { alreadyOpen: true, ... } if that server is already showing. If it returns pending:true it timed out; ' +
      'a late click may still apply, so re-read state (call check_sidebar or get the tree) before retrying.',
    parameters: {
      name: {
        type: 'string',
        description: 'Server name (case, emoji and punctuation are ignored; unique partial names work).'
      },
      timeoutMs: TIMEOUT_PARAM
    },
    async run({ params, browser, tabId }) {
      const p = params || {};
      if (typeof p.name !== 'string' || p.name.trim().length === 0) {
        throw new Error('open_server requires non-empty params.name (string).');
      }
      if (typeof tabId !== 'number') {
        throw new Error('open_server requires tab_id (number).');
      }
      const ctx = makeCtx(p, browser, tabId);
      const target = p.name;

      let tree = await fetchTree(ctx);
      let res = resolveServer(serversOf(tree), target);
      if (res.kind === 'none' && foldersOf(tree).some((f) => f.expanded === false)) {
        const r = await expandCollapsedFolders(ctx);
        tree = r.tree;
        if (r.pending) {
          return { pending: true, message: PENDING_MESSAGE, name: target, lastUrl: null };
        }
        res = resolveServer(serversOf(tree), target);
      }
      if (res.kind !== 'ok') throw res.error;
      let matched = res.server;
      const matchedName = matched.name;

      const preUrl = await getTabUrl(ctx);
      const preMatch = /\/channels\/(\d+)\//.exec(preUrl);
      if (preMatch && tree.serverName && normalize(tree.serverName) === normalize(matchedName)) {
        const full = /\/channels\/(\d+)\/(\d+)/.exec(preUrl);
        return {
          alreadyOpen: true,
          serverId: preMatch[1],
          channelId: full ? full[2] : null,
          name: matchedName,
          url: preUrl,
          verified: true
        };
      }

      // Re-fetch so the ref we click belongs to the latest fetch.
      tree = await fetchTree(ctx);
      const fresh = resolveServer(serversOf(tree), target);
      if (fresh.kind === 'ok') matched = fresh.server;

      if (matched.ref) {
        await safeClick(browser, { ref: matched.ref, tab_id: tabId });
      } else {
        await safeClick(browser, {
          selector: `[data-dnd-name="${cssAttr(matched.name)}"]`,
          tab_id: tabId
        });
      }

      let lastUrl = preUrl;
      for (;;) {
        await pollWait(ctx);
        lastUrl = await getTabUrl(ctx);
        const m = /\/channels\/(\d+)\/(\d+)/.exec(lastUrl);
        if (m && lastUrl !== preUrl) {
          let verified = false;
          if (remaining(ctx) > 0) {
            const after = await fetchTree(ctx);
            verified = normalize(after && after.serverName) === normalize(matchedName);
          }
          return { serverId: m[1], channelId: m[2], name: matchedName, url: lastUrl, verified };
        }
        if (remaining(ctx) <= 0) {
          return { pending: true, message: PENDING_MESSAGE, name: matchedName, lastUrl };
        }
      }
    }
  },

  check_dm_list: {
    description:
      'List Discord direct messages and group DMs (name, ref, type, status, unread, members, muted) with ' +
      'dmCount and totalUnread. Navigates to Home first if a server is showing. Message previews are not ' +
      'available. If it returns pending:true it timed out; a late click may still apply, so re-read state ' +
      '(call check_sidebar or get the tree) before retrying.',
    parameters: {
      timeoutMs: TIMEOUT_PARAM
    },
    async run({ params, browser, tabId }) {
      if (typeof tabId !== 'number') {
        throw new Error('check_dm_list requires tab_id (number).');
      }
      const ctx = makeCtx(params, browser, tabId);
      const isDm = (t) => t && (t.pageType === 'dm_list' || t.pageType === 'dm_conversation');
      let tree = await fetchTree(ctx);
      if (!isDm(tree)) {
        await safeClick(browser, { selector: HOME_SELECTOR, tab_id: tabId });
        for (;;) {
          await pollWait(ctx);
          tree = await fetchTree(ctx);
          if (isDm(tree)) break;
          if (remaining(ctx) <= 0) {
            return { pending: true, message: PENDING_MESSAGE, pageType: tree && tree.pageType };
          }
        }
      }
      const dms = tree.dms || [];
      return {
        dms,
        dmCount: dms.length,
        totalUnread: tree.totalUnread == null ? null : tree.totalUnread
      };
    }
  }
};
