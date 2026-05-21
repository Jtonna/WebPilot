import EmptyState from './EmptyState';

const meta = {
  title: 'Primitives/EmptyState',
  component: EmptyState,
  parameters: {
    docs: {
      description: {
        component:
          'Canonical "this list/section is empty" block used across the dashboard, formatters, pairings, profiles, agents and sites pages. Two variants — "card" (default) for standalone empty sections, "bare" for use inside wp-inset-groups where the parent already supplies the card surface.',
      },
    },
  },
  argTypes: {
    title: { control: 'text' },
    body: { control: 'text' },
    variant: {
      control: { type: 'inline-radio' },
      options: ['card', 'bare'],
    },
  },
};

export default meta;

export const Default = {
  args: {
    body: 'No pairings yet. They’ll appear here after you approve or deny your first request.',
  },
};

export const WithAction = {
  args: {
    title: 'No paired agents yet',
    body: 'Pair an agent first to give it per-site overrides.',
    action: (
      <button type="button" className="wp-btn wp-btn-primary">
        Pair a new agent
      </button>
    ),
  },
};

export const BareVariant = {
  render: (args) => (
    <div className="wp-inset-group">
      <EmptyState {...args} />
    </div>
  ),
  args: {
    body: 'Nothing pending right now.',
    variant: 'bare',
  },
};
