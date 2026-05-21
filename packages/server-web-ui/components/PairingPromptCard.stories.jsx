import PairingPromptCard from './PairingPromptCard';

const meta = {
  title: 'Primitives/PairingPromptCard',
  component: PairingPromptCard,
  parameters: {
    docs: {
      description: {
        component:
          'Inline approve/deny row for a single pending pairing. Lives in the Dashboard Action Items list and the Pairings page.',
      },
    },
  },
  argTypes: {
    onApprove: { action: 'approve' },
    onDeny: { action: 'deny' },
    disabled: { control: 'boolean' },
  },
};

export default meta;

const FRESH_PAIRING = {
  pairingId: '8f2a-d31c-b71e-9088',
  agentName: 'Claude Code — my-project',
  createdAt: new Date(Date.now() - 1000 * 45).toISOString(),
};

const ANONYMOUS_PAIRING = {
  pairingId: '7c4f-a82b-3320-1109',
  agentName: '',
  createdAt: new Date(Date.now() - 1000 * 60 * 6).toISOString(),
};

export const Default = {
  args: { pairing: FRESH_PAIRING },
};

export const Unnamed = {
  args: { pairing: ANONYMOUS_PAIRING },
};

export const Submitting = {
  args: { pairing: FRESH_PAIRING, disabled: true },
};

export const InsideCard = {
  parameters: {
    docs: {
      description: {
        story: 'How the card looks inside a wp-card list, mirroring the Dashboard layout.',
      },
    },
  },
  render: (args) => (
    <div className="wp-card" style={{ padding: 0 }}>
      <PairingPromptCard {...args} pairing={FRESH_PAIRING} />
      <PairingPromptCard {...args} pairing={ANONYMOUS_PAIRING} />
    </div>
  ),
};
