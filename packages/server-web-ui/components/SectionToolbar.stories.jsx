import SectionToolbar from './SectionToolbar';

const meta = {
  title: 'Primitives/SectionToolbar',
  component: SectionToolbar,
  parameters: {
    docs: {
      description: {
        component:
          '"Label on the left, primary action on the right" strip that sits between a section head and its body. Used on the sites + agents pages. The "card" variant wraps in .wp-card with thicker padding for standalone CTAs (the agents pair-bar).',
      },
    },
  },
  argTypes: {
    variant: {
      control: { type: 'inline-radio' },
      options: ['plain', 'card'],
    },
  },
};

export default meta;

const Tablist = () => (
  <div role="tablist" aria-label="Filter rules by source" style={{ display: 'inline-flex', gap: 'var(--s-2)' }}>
    <button type="button" role="tab" aria-selected="true" className="wp-btn wp-btn-compact wp-btn-primary">All</button>
    <button type="button" role="tab" aria-selected="false" className="wp-btn wp-btn-compact">User</button>
    <button type="button" role="tab" aria-selected="false" className="wp-btn wp-btn-compact">Baseline</button>
  </div>
);

export const Default = {
  render: () => (
    <SectionToolbar
      left={<Tablist />}
      right={<button type="button" className="wp-btn wp-btn-primary">+ Add rule</button>}
    />
  ),
};

export const NoRightSlot = {
  render: () => (
    <SectionToolbar
      left={<span className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>Filter rules by source</span>}
      right={null}
    />
  ),
};

export const WithFilter = {
  render: () => (
    <SectionToolbar
      left={(
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
          <span className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>Agent</span>
          <select className="wp-input" defaultValue="alpha">
            <option value="alpha">Alpha · default</option>
            <option value="beta">Beta · sandbox</option>
          </select>
        </label>
      )}
      right={<button type="button" className="wp-btn wp-btn-primary">+ Add override</button>}
    />
  ),
};

export const CardVariant = {
  render: () => (
    <SectionToolbar
      variant="card"
      left={<span style={{ fontWeight: 500, color: 'var(--wp-fg)' }}>Pair a new agent</span>}
      right={<button type="button" className="wp-btn wp-btn-primary">Pair a new agent</button>}
    />
  ),
};
