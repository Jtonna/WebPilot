# VantageFeed Extension Deployment

How the Chrome extension is packaged and installed for end users.

## Overview

Due to Chrome's security restrictions, the extension must be sideloaded via Developer Mode on Windows. The installer deploys the unpacked extension to a known location, and the app guides users through a one-time setup.

```
[Build Time]
unpacked-extension/ --> electron build --> bundled in installer

[Install Time - Windows]
NSIS extracts extension to: %LOCALAPPDATA%\VantageFeed\extension\

[Install Time - macOS]
DMG extracts extension to: ~/Library/Application Support/VantageFeed/extension/

[First Launch]
App detects extension not loaded --> shows onboarding screen
User enables Developer Mode --> clicks "Load unpacked" --> selects extension folder
```

## Why Sideloading?

Chrome restricts extension installation to protect users:

| Method | Windows | macOS | Limitation |
|--------|---------|-------|------------|
| Chrome Web Store | ✅ | ✅ | Extension rejected (uses CDT) |
| External CRX (local file) | ❌ | ❌ | Blocked since Chrome 33/44 |
| External CRX (self-hosted URL) | ❌ | ✅ | Windows requires Web Store |
| Registry/JSON + Web Store | ✅ | ✅ | Requires Web Store listing |
| Enterprise Policy (self-hosted) | ✅ | ✅ | Requires AD domain |
| Developer Mode sideload | ✅ | ✅ | Works everywhere |

Developer Mode sideloading is the only approach that works reliably without Chrome Web Store approval.

## Build Integration

The extension is bundled with the Electron app via `extraResources`:

```yaml
# electron-builder.yml
extraResources:
  - from: "../vantage-feed-extension/unpacked-extension"
    to: "extension"
    filter:
      - "**/*"
```

This copies `unpacked-extension/` into the app resources during build.

## Installation Paths

### Windows

The NSIS installer extracts the extension to:
```
%LOCALAPPDATA%\VantageFeed\extension\
```

This path is:
- User-specific (no admin required after initial install)
- Persistent across app updates
- Easy for users to locate

### macOS

The app extracts the extension on first run to:
```
~/Library/Application Support/VantageFeed/extension/
```

## User Onboarding Flow

On first launch (or if extension not detected), the app shows an onboarding screen:

1. **Check** - App attempts to communicate with extension via native messaging
2. **Guide** - If not found, show setup instructions:
   - "Open Chrome Extensions" button (opens `chrome://extensions`)
   - "Enable Developer Mode" with screenshot
   - "Click Load Unpacked" with screenshot
   - "Select this folder" with path pre-filled and "Copy Path" button
3. **Verify** - App re-checks and confirms extension is loaded
4. **Done** - Normal app flow continues

The extension folder path can be opened in Explorer/Finder directly from the app.

## Version Management

The extension version is in `unpacked-extension/manifest.json`:

```json
{
  "version": "0.2.0"
}
```

When updating:
1. Bump version in manifest.json
2. Rebuild the app
3. Users reinstall the app (new extension files deployed)
4. Chrome detects the updated unpacked extension on next launch

## Developer Mode Considerations

- **Warning banner**: Chrome shows "Developer mode extensions" warning on launch. This is expected and cannot be avoided for sideloaded extensions.
- **Persistence**: The extension stays loaded until the user removes it or the folder is deleted.
- **Updates**: Unlike Web Store extensions, sideloaded extensions don't auto-update. Users get updates when they reinstall the app.

## Testing

1. Run `build-windows.bat` (or `build-mac.sh`)
2. Run the installer
3. Launch VantageFeed app
4. Follow the onboarding flow to sideload the extension
5. Verify extension appears in `chrome://extensions`
6. Test extension functionality

To reset for re-testing:
1. Remove the extension from `chrome://extensions`
2. Delete `%LOCALAPPDATA%\VantageFeed\extension\` (Windows) or `~/Library/Application Support/VantageFeed/extension/` (macOS)
3. Uninstall and reinstall the app

## Key Files

| File | Purpose |
|------|---------|
| `unpacked-extension/` | The extension source (deployed to users) |
| `unpacked-extension/manifest.json` | Extension metadata and version |
| `electron-builder.yml` | Bundles extension via extraResources |
| `electron/build/installer.nsh` | NSIS script that extracts extension folder |

## Notes

- The extension folder must remain in place for Chrome to load it. If the user deletes it, they'll need to reinstall the app.
- Chrome may disable the extension after major Chrome updates. Users can re-enable it from `chrome://extensions`.
- The "Developer mode extensions" warning appears on every Chrome launch. This is a Chrome security feature and cannot be suppressed.
