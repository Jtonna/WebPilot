import { ToastProvider, useToast } from './ToastRegion';

const meta = {
  title: 'Primitives/ToastRegion',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Toast region + context provider. Max 3 visible — older toasts are dropped. Wrap the app once via <ToastProvider>; call useToast() from any descendant.',
      },
    },
  },
};

export default meta;

function StackDemo() {
  const toast = useToast();
  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 className="wp-page-title">Toast region demo</h2>
      <p className="wp-secondary">
        Click the buttons. Errors stay until dismissed; success/info auto-dismiss after 4s.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="wp-btn"
          onClick={() => toast.success('Saved.')}
        >
          + success
        </button>
        <button
          type="button"
          className="wp-btn"
          onClick={() => toast.info('Polling…')}
        >
          + info
        </button>
        <button
          type="button"
          className="wp-btn wp-btn-danger"
          onClick={() => toast.error('Could not reach the server.')}
        >
          + error
        </button>
        <button
          type="button"
          className="wp-btn wp-btn-primary"
          onClick={() => {
            toast.success('One');
            toast.info('Two');
            toast.error('Three');
            toast.success('Four — should evict One');
          }}
        >
          Burst (4)
        </button>
      </div>
    </div>
  );
}

export const Default = {
  render: () => (
    <ToastProvider>
      <StackDemo />
    </ToastProvider>
  ),
};
