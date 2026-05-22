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
      options: ['active', 'ready', 'needs_setup', 'warn', 'danger', 'info', 'unknown', 'shadowed'],
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
      <Pill state="shadowed" label="Shadowed by local override" />
    </div>
  ),
};

export const LongLabel = {
  args: {
    state: 'info',
    label: 'A reasonably long pill label that still sits on one line',
  },
};

/**
 * "shadowed" — used on the Formatters tab to mark a remote formatter
 * whose routing has been usurped by a same-named custom override.
 * Muted dot + muted label so it stays visually below the active row.
 */
export const Shadowed = {
  args: { state: 'shadowed', label: 'Shadowed by local override' },
};
