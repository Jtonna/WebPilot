# Why Deploy via Sideloading?

Why the WebPilot Chrome extension must be sideloaded via Developer Mode rather than distributed through the Chrome Web Store.

## The Core Restriction

WebPilot's Chrome extension requires the `chrome.debugger` permission, which grants access to the Chrome DevTools Protocol (CDP). This is how the extension inspects and interacts with web pages on behalf of MCP clients.

The `chrome.debugger` permission is classified as a **restricted permission** by Google. Extensions that request it are not eligible for listing on the Chrome Web Store. There is no review process or exception workflow that would allow it -- the restriction is a hard policy gate.

This single constraint determines the entire distribution strategy.

## Distribution Method Comparison

Every standard Chrome extension installation method was evaluated:

| Method | Works? | Why / Why Not |
|--------|--------|---------------|
| Chrome Web Store | No | `chrome.debugger` is a restricted permission; listing is rejected |
| External CRX (local file) | No | Chrome blocks local `.crx` installs (since Chrome 33 on Windows, Chrome 44 on macOS) |
| External CRX (self-hosted URL) | No | Windows requires a Web Store listing; macOS blocks external CRX entirely |
| Registry/JSON preference + Web Store | No | Still requires a Web Store listing as the install source |
| Enterprise Policy (self-hosted) | No | Requires Active Directory domain enrollment; not viable for individual users |
| **Developer Mode sideload** | **Yes** | Works on all platforms without any external approval or infrastructure |

Developer Mode sideloading is the only method that works for individual users without Chrome Web Store approval.

## How Sideloading Works

The Electron installer deploys the unpacked extension directory to the app's resources folder. On first launch, the app displays the extension path and the user completes a one-time setup:

1. Open `chrome://extensions` in Chrome
2. Enable Developer Mode (toggle in the top-right corner)
3. Click "Load unpacked" and select the extension path shown in the WebPilot app

Once loaded, Chrome remembers the extension across restarts. The extension stays active as long as the folder remains on disk.

## Developer Mode Implications

Sideloading via Developer Mode has trade-offs that users should be aware of:

- **Startup warning banner**: Chrome displays a "Developer mode extensions" notification on every launch. This is a Chrome security feature and cannot be suppressed or dismissed permanently.
- **No auto-updates**: Unlike Web Store extensions, sideloaded extensions do not receive automatic updates. Users get extension updates when they update the WebPilot app (the new app version deploys updated extension files to the same path).
- **Persistence across Chrome updates**: Chrome may occasionally disable sideloaded extensions after major Chrome version updates. Users can re-enable the extension from `chrome://extensions`.
- **Folder dependency**: The extension directory must remain in place. If the user deletes or moves the WebPilot app, Chrome loses access to the extension.

## Chrome Web Store Policy Reference

Google's extension policy restricts several permissions from Web Store distribution. The `chrome.debugger` permission is restricted because it allows an extension to attach to any tab and read/modify all network traffic, DOM content, and JavaScript execution -- effectively granting full control over the browser session.

This is by design for WebPilot: CDP access is what enables MCP clients to interact with web pages. The permission is not optional, and no reduced-scope alternative exists that would satisfy both Chrome Web Store policy and WebPilot's functionality requirements.
