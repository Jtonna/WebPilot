import Pill from './Pill';

const meta = {
  title: 'Primitives/Pill',
  component: Pill,
  parameters: {
    docs: {
      description: {
        component:
          'Shared .wp-pill primitive — dot + label coloured by data-state. Domain wrappers (ProfileStatusBadge, HealthPill, the decision / source pills on /sites, the history pill on /pairings) all render through this component, so visual styling stays in lockstep.',
      },
    },
  },
  argTypes: {
    state: {
      control: { type: 'inline-radio' },
      options: ['active', 'ready', 'needs_setup', 'warn', 'danger', 'info', 'unknown'],
    },
    label: { control: 'text' },
  },
};

export default meta;

export const Default = {
  args: { state: 'active', label: 'Active' },
};

export const AllStates = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <Pill state="info" label="Info" />
      <Pill state="active" label="Active" />
      <Pill state="ready" label="Ready" />
      <Pill state="warn" label="Warning" />
      <Pill state="danger" label="Danger" />
      <Pill state="needs_setup" label="Needs setup" />
      <Pill state="unknown" label="Unknown" />
    </div>
  ),
};

export const LongLabel = {
  args: {
    state: 'info',
    label: 'A reasonably long pill label that still sits on one line',
  },
};
