import { useState } from 'react';
import ProfileSetupModal from './ProfileSetupModal';

const meta = {
  title: 'Primitives/ProfileSetupModal',
  component: ProfileSetupModal,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Four-step walkthrough for loading the WebPilot unpacked extension into a Chrome profile. Step 3 renders the real extension path (or a fallback hint if the server can\'t resolve one).',
      },
    },
  },
};

export default meta;

function ProfileSetupDemo({ extensionPath, profileName }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        className="wp-btn wp-btn-primary"
        onClick={() => setOpen(true)}
      >
        Re-open
      </button>
      <ProfileSetupModal
        open={open}
        profileName={profileName}
        extensionPath={extensionPath}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

export const WithKnownPath = {
  render: () => (
    <ProfileSetupDemo
      profileName="Work"
      extensionPath="C:\\Program Files\\WebPilot\\resources\\chrome-extension"
    />
  ),
};

export const FallbackHint = {
  render: () => (
    <ProfileSetupDemo profileName="Default" extensionPath={null} />
  ),
};

export const NoProfileName = {
  render: () => (
    <ProfileSetupDemo
      profileName={null}
      extensionPath="/Applications/WebPilot.app/Contents/Resources/chrome-extension"
    />
  ),
};
