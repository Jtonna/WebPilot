import Toast from './Toast';
import { ToastProvider, useToast } from './ToastRegion';

const meta = {
  title: 'Primitives/Toast',
  component: Toast,
  parameters: {
    docs: {
      description: {
        component:
          'Single toast notification (lower-right stack). Errors stay until dismissed; success/info auto-dismiss after 4s.',
      },
    },
  },
  argTypes: {
    flavor: {
      control: { type: 'inline-radio' },
      options: ['success', 'info', 'error'],
    },
    message: { control: 'text' },
  },
};

export default meta;

export const Success = {
  args: { id: 't1', flavor: 'success', message: 'Profile created.' },
};

export const Info = {
  args: { id: 't2', flavor: 'info', message: 'Polling for pairing approval…' },
};

export const Error = {
  args: { id: 't3', flavor: 'error', message: 'Could not reach the server.' },
};

function ToastTrigger() {
  const toast = useToast();
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button
        type="button"
        className="wp-btn"
        onClick={() => toast.success('Saved.')}
      >
        Push success
      </button>
      <button
        type="button"
        className="wp-btn"
        onClick={() => toast.info('Heads up — this might take a sec.')}
      >
        Push info
      </button>
      <button
        type="button"
        className="wp-btn wp-btn-danger"
        onClick={() => toast.error('Something went wrong.')}
      >
        Push error
      </button>
    </div>
  );
}

export const ViaProvider = {
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates the toast region via the ToastProvider context. Click a button to push.',
      },
    },
  },
  render: () => (
    <ToastProvider>
      <ToastTrigger />
    </ToastProvider>
  ),
};
