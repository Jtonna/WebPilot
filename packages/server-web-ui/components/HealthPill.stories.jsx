import HealthPill from './HealthPill';

const meta = {
  title: 'Primitives/HealthPill',
  component: HealthPill,
  argTypes: {
    health: {
      control: { type: 'inline-radio' },
      options: ['healthy', 'unhealthy', 'unknown'],
    },
  },
  parameters: {
    docs: {
      description: {
        component:
          'Formatter health pill — reuses .wp-pill so visual styling stays in lockstep with ProfileStatusBadge.',
      },
    },
  },
};

export default meta;

export const Healthy = { args: { health: 'healthy' } };
export const Unhealthy = { args: { health: 'unhealthy' } };
export const Unknown = { args: { health: 'unknown' } };

export const AllStates = {
  render: () => (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <HealthPill health="healthy" />
      <HealthPill health="unhealthy" />
      <HealthPill health="unknown" />
    </div>
  ),
};
