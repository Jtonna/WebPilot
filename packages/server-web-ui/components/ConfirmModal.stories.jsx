import { useState } from 'react';
import ConfirmModal from './ConfirmModal';

const meta = {
  title: 'Primitives/ConfirmModal',
  component: ConfirmModal,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Apple-style confirmation modal. Replaces window.confirm() usage. Backdrop / Esc cancels; Enter confirms.',
      },
    },
  },
};

export default meta;

function ConfirmDemo({ confirmDanger = false, title, body, confirmLabel }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        className="wp-btn wp-btn-primary"
        onClick={() => setOpen(true)}
      >
        Re-open
      </button>
      <ConfirmModal
        open={open}
        title={title}
        body={body}
        confirmLabel={confirmLabel}
        confirmDanger={confirmDanger}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}

export const Default = {
  render: () => (
    <ConfirmDemo
      title="Apply this change?"
      body="Pairings tied to this profile will keep working."
    />
  ),
};

export const Danger = {
  render: () => (
    <ConfirmDemo
      title="Revoke agent “otter-4271”?"
      body="The agent will lose access on its next tool call. This cannot be undone."
      confirmLabel="Revoke"
      confirmDanger
    />
  ),
};

export const LongBody = {
  render: () => (
    <ConfirmDemo
      title="Clear formatter history?"
      body="This will delete the last 30 days of formatter invocations from the local SQLite store. Logs already downloaded won't be affected. You can keep history off in Settings → Privacy."
      confirmLabel="Clear"
      confirmDanger
    />
  ),
};
