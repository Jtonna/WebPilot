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
 */

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
  }
};
