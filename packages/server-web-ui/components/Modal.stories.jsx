import { useState } from 'react';
import Modal from './Modal';

const meta = {
  title: 'Primitives/Modal',
  component: Modal,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Shared modal scaffolding. Provides backdrop, Esc/backdrop dismiss, mount-during-exit pattern. Title/body/actions come from children.',
      },
    },
  },
};

export default meta;

function ModalDemo({ size = 'md', initialOpen = true }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div>
      <button
        type="button"
        className="wp-btn wp-btn-primary"
        onClick={() => setOpen(true)}
      >
        Re-open modal
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        titleId="demo-modal-title"
        size={size}
      >
        <h2 id="demo-modal-title" className="wp-modal-title">
          Modal scaffold
        </h2>
        <div className="wp-modal-body">
          <p style={{ margin: 0 }}>
            This is the shared <code>&lt;Modal /&gt;</code> base. Press Esc or
            click the backdrop to dismiss — the exit keyframe will play.
          </p>
        </div>
        <div className="wp-modal-actions">
          <button
            type="button"
            className="wp-btn"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="wp-btn wp-btn-primary"
            onClick={() => setOpen(false)}
          >
            Continue
          </button>
        </div>
      </Modal>
    </div>
  );
}

export const Default = {
  render: () => <ModalDemo />,
};

export const Large = {
  render: () => <ModalDemo size="lg" />,
};

export const InitiallyClosed = {
  render: () => <ModalDemo initialOpen={false} />,
};
