# Plan: Developer Mode Sideloading for Chrome Extension

## Summary

Bundle the unpacked extension with the installer, deploy it to a known location, and add an onboarding step that guides users through sideloading and validates the setup by reading Chrome's preferences.

## Flow

```
[Build Time]
unpacked-extension/ --> electron-builder extraResources --> bundled in installer

[Install Time - Windows]
NSIS extracts extension to: %LOCALAPPDATA%\WebPilot\extension\

[First Launch - Onboarding Step 3]
1. Check if extension files deployed ✓
2. Check if Chrome Developer Mode enabled (read Secure Preferences)
3. Check if extension loaded in Chrome (read Secure Preferences)
4. Guide user through any missing steps
5. Verify all checks pass before proceeding
```

## Part 1: Build & Install Changes

### 1. `electron/package.json`

Add extension to `extraResources`:

```json
{
  "from": "../webpilot/unpacked-extension",
  "to": "extension",
  "filter": ["**/*"]
}
```

### 2. `electron/build/installer.nsh`

Replace registry-based approach with folder extraction:

**Remove:**
- `VF_EXTENSION_ID` and `VF_EXTENSION_UPDATE_URL` defines
- `WriteRegStr` for ExtensionInstallForcelist in `customInstall`
- `DeleteRegValue` in `customUnInstall`

**Add to `customInstall`:**
```nsis
; Copy extension to user's local app data for sideloading
CreateDirectory "$LOCALAPPDATA\WebPilot\extension"
CopyFiles /SILENT "$INSTDIR\resources\extension\*.*" "$LOCALAPPDATA\WebPilot\extension"
```

**Add to `customUnInstall`:**
```nsis
; Remove extension folder
RMDir /r "$LOCALAPPDATA\WebPilot\extension"
RMDir "$LOCALAPPDATA\WebPilot"  ; Remove parent if empty
```

## Part 2: Backend Extension Status API

### 3. `backend/app/routes/setup.py`

Add new endpoints for extension status:

**`GET /api/setup/extension/status`** - Returns extension setup state:
```json
{
  "deployed": true,
  "deployedVersion": "0.2.0",
  "developerMode": true,
  "loaded": true,
  "loadedVersion": "0.2.0",
  "extensionPath": "C:\\Users\\...\\WebPilot\\extension"
}
```

**Detection logic:**
1. **deployed** - Check `%LOCALAPPDATA%\WebPilot\extension\manifest.json` exists
2. **deployedVersion** - Read version from that manifest.json
3. **developerMode** - Read Chrome's `Secure Preferences` file:
   - Path: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Secure Preferences`
   - Key: `extensions.ui.developer_mode` (value is `true` or `false`)
4. **loaded** - Check `extensions.settings` in Secure Preferences for entry with path matching our extension folder
5. **loadedVersion** - Read manifest version from the loaded extension's settings

### 4. `backend/app/services/setup_extension.py` (new file)

Create `ExtensionSetup` class with methods:
- `get_extension_path()` - Returns platform-specific extension deploy path
- `is_deployed()` - Checks if extension files exist
- `get_deployed_version()` - Reads version from deployed manifest.json
- `get_chrome_prefs_path()` - Returns path to Chrome's Secure Preferences
- `is_developer_mode_enabled()` - Reads developer_mode from Chrome prefs
- `is_extension_loaded()` - Checks if extension path is in Chrome's extension settings
- `get_loaded_version()` - Gets version of loaded extension
- `get_status()` - Returns full status dict

## Part 3: Frontend Onboarding Step

### 5. `frontend/src/app/onboarding/steps/extension-step.tsx` (new file)

New onboarding step component:
- Polls `/api/setup/extension/status` every 2 seconds
- Shows checklist with status indicators:
  - ✓ Extension files installed
  - ⏳ Enable Developer Mode in Chrome (with instructions)
  - ⏳ Load extension in Chrome (with instructions + path copy button)
- "Open Chrome Extensions" button (instructions to paste `chrome://extensions` in browser)
- "Copy Extension Path" button for easy folder selection
- Auto-advances when all checks pass

### 6. `frontend/src/app/onboarding/page.tsx`

Add extension step to onboarding flow:
- Current: Step 1 (AI CLI) → Step 2 (Supabase)
- New: Step 1 (AI CLI) → Step 2 (Supabase) → **Step 3 (Chrome Extension)**

### 7. `frontend/src/lib/api/onboarding.ts`

Add API function:
```typescript
export async function checkExtensionStatus() {
  return apiClient.get('/api/setup/extension/status');
}
```

## Implementation Order

1. **Build/Install** (Part 1)
   - Update `electron/package.json` with extraResources
   - Update `electron/build/installer.nsh` with folder copy

2. **Backend** (Part 2)
   - Create `backend/app/services/setup_extension.py`
   - Add endpoints to `backend/app/routes/setup.py`

3. **Frontend** (Part 3)
   - Create `extension-step.tsx` component
   - Update `onboarding/page.tsx` to include step 3
   - Add API function to `onboarding.ts`

4. **Test end-to-end**

## Verification

1. Run `build-windows.bat`
2. Run the installer
3. Launch WebPilot app
4. Onboarding should show 3 steps, with step 3 being Chrome Extension
5. Step 3 should detect:
   - Extension deployed ✓
   - Developer Mode ✗ (initially)
   - Extension loaded ✗ (initially)
6. Enable Developer Mode in Chrome
7. Step 3 should update to show Developer Mode ✓
8. Load unpacked extension using provided path
9. Step 3 should show all checks ✓ and allow proceeding

## Chrome Preferences File Details

**Location (Windows):**
```
%LOCALAPPDATA%\Google\Chrome\User Data\Default\Secure Preferences
```

**Verified JSON structure (tested on real Chrome install):**
```json
{
  "extensions": {
    "settings": {
      "cohbniildehaagapenmhebelodcmpjbp": {
        "location": 4,
        "path": "C:\\Users\\J\\...\\webpilot\\unpacked-extension",
        "service_worker_registration_info": {
          "version": "0.2.0"
        },
        "manifest": {
          "version": "0.2.0"
        }
      }
    },
    "ui": {
      "developer_mode": true
    }
  }
}
```

**Key findings:**
- `location: 4` = unpacked extension (sideloaded via Developer Mode)
- Extension ID is auto-generated by Chrome based on the path
- Version available in both `manifest.version` and `service_worker_registration_info.version`
- To find our extension: search `extensions.settings` for entry where `path` contains `WebPilot`

## Notes

- Extension folder path: `%LOCALAPPDATA%\WebPilot\extension\` (Windows)
- Chrome prefs file may be locked while Chrome is running - handle gracefully
- Users see "Developer mode extensions" warning on Chrome launch - this is expected
- Polling interval: 2 seconds for responsive feedback during setup
