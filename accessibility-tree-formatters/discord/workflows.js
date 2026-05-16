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
 *   line of the form `[eN] Message textbox` in the formatted tree string.
 *   We locate it by exact-match against `name === 'Message textbox'`. If
 *   the formatter shape ever changes (e.g. to surface the channel name in
 *   the composer label), update the selector here in lockstep. The
 *   underlying raw a11y node is a textbox whose accessible name starts
 *   with "Message #" (server channel) or "Message @" (DM), but the
 *   formatter normalizes that down to "Message textbox".
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
      // as the line "[eN] Message textbox" — see discord.js extractTextbox.
      const tree = await browser.getAccessibilityTree({ tab_id: tabId });

      const composer =
        findInTree(tree, { name: 'Message textbox' }) ||
        // Defensive fallback: some Discord page types (e.g. DM with empty
        // state) may render the composer with a slightly different label.
        // Match any line that contains "Message textbox" as a substring.
        findInTree(tree, { name_contains: 'Message textbox' });

      if (!composer) {
        throw new Error(
          'Composer textbox not found — is a Discord channel or DM selected? ' +
          'Expected a "[eN] Message textbox" line in the formatted tree.'
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
