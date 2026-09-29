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
          'ConfirmModal variant that requires typing a random 4-character confirmation code before Confirm enables. The code is re-rolled every time the modal opens, so it will look different on each "Re-open" click below. Backdrop / Esc cancels; Enter only confirms once the typed value matches.',
      },
    },
  },
};

export default meta;

function TypedConfirmDemo({ confirmDanger = true, title, body, confirmLabel }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        type="button"
        className="wp-btn wp-btn-primary"
        onClick={() => setOpen(true)}
      >
        Re-open (rolls a new code)
      </button>
      <TypedConfirmModal
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
