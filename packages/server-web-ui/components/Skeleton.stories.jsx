import Skeleton, { SkeletonRow } from './Skeleton';

const meta = {
  title: 'Primitives/Skeleton',
  component: Skeleton,
  parameters: {
    docs: {
      description: {
        component:
          'Loading placeholder with the warm-monochrome shimmer. Animation suppressed under prefers-reduced-motion.',
      },
    },
  },
  argTypes: {
    width: { control: 'text' },
    height: { control: 'number' },
  },
};

export default meta;

export const Default = {
  args: { width: '60%', height: 16 },
};

export const Title = {
  args: { width: '40%', height: 24 },
};

export const Row = {
  render: () => (
    <div className="wp-card" style={{ padding: 0 }}>
      <SkeletonRow titleWidth="50%" subWidth="30%" />
      <SkeletonRow titleWidth="65%" subWidth="40%" showTrailing />
      <SkeletonRow titleWidth="45%" subWidth="35%" />
    </div>
  ),
};

export const StackedBlocks = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Skeleton width="100%" height={32} />
      <Skeleton width="80%" height={16} />
      <Skeleton width="60%" height={16} />
    </div>
  ),
};
