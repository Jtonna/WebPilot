import RevealSection from './RevealSection';

const meta = {
  title: 'Primitives/RevealSection',
  component: RevealSection,
  parameters: {
    docs: {
      description: {
        component:
          'Wraps a <section> so it stays hidden until it scrolls into view, then fades and rises into place. Reduced-motion users get the static end-state instantly.',
      },
    },
  },
};

export default meta;

export const Default = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-7)' }}>
      <div style={{ height: '60vh', display: 'flex', alignItems: 'center' }}>
        <span className="wp-secondary">
          Scroll down — the section below reveals on intersect.
        </span>
      </div>
      <RevealSection className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Revealed section</h2>
        </div>
        <div className="wp-card">
          <p style={{ margin: 0 }}>
            This block was hidden (opacity 0, translated 8px) until it crossed
            the viewport threshold.
          </p>
        </div>
      </RevealSection>
    </div>
  ),
};

export const StaticContent = {
  render: () => (
    <RevealSection className="wp-section">
      <div className="wp-section-head">
        <h2 className="wp-section-title">Already in view</h2>
      </div>
      <div className="wp-card">
        <p style={{ margin: 0 }}>
          Reveal triggers on intersect — if a section is in the initial viewport,
          it shows immediately on first paint.
        </p>
      </div>
    </RevealSection>
  ),
};
