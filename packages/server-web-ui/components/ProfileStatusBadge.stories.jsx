import ProfileStatusBadge from './ProfileStatusBadge';

const meta = {
  title: 'Primitives/ProfileStatusBadge',
  component: ProfileStatusBadge,
  argTypes: {
    status: {
      control: { type: 'inline-radio' },
      options: ['active', 'ready', 'needs_setup', 'unknown'],
    },
  },
};

export default meta;

export const Active = { args: { status: 'active' } };
export const Ready = { args: { status: 'ready' } };
export const NeedsSetup = { args: { status: 'needs_setup' } };
export const UnknownState = { args: { status: 'unknown' } };

export const AllStates = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <ProfileStatusBadge status="active" />
      <ProfileStatusBadge status="ready" />
      <ProfileStatusBadge status="needs_setup" />
      <ProfileStatusBadge status="unknown" />
    </div>
  ),
};
