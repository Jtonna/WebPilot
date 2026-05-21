import BackLink from './BackLink';

const meta = {
  title: 'Primitives/BackLink',
  component: BackLink,
  parameters: {
    docs: {
      description: {
        component:
          'Contextual back-link rendered above a page head on filter / deep-link pages. Secondary-fg at rest, primary-fg on hover.',
      },
    },
  },
  argTypes: {
    href: { control: 'text' },
    label: { control: 'text' },
  },
};

export default meta;

export const Default = {
  args: {
    href: '/ui/agents/',
    label: 'Back to all agents',
  },
};

export const ShortLabel = {
  args: {
    href: '/ui/',
    label: 'Back',
  },
};
