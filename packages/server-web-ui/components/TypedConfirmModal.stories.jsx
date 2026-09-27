import { useState } from 'react';
import TypedConfirmModal from './TypedConfirmModal';

const meta = {
  title: 'Primitives/TypedConfirmModal',
  component: TypedConfirmModal,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'ConfirmModal variant that requires typing a confirmation phrase before Confirm enables. Backdrop / Esc cancels; Enter does not auto-confirm.',
      },
    },
  },
};

export default meta;

function TypedConfirmDemo({ confirmDanger = true, title, body, phrase, confirmLabel }) {
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
      <TypedConfirmModal
        open={open}
        title={title}
        body={body}
        phrase={phrase}
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
    <TypedConfirmDemo
      title="Allow example.com for Agent A?"
      body="Other agents paired to this profile are unaffected — this only changes what Agent A can reach."
      confirmLabel="Allow for this agent"
    />
  ),
};

export const NonDanger = {
  render: () => (
    <TypedConfirmDemo
      title="Migrate profile settings?"
      body="Copies the current profile's allow/block lists to the new format. Existing settings aren't removed."
      confirmLabel="Migrate"
      confirmDanger={false}
    />
  ),
};
