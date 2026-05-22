import { useState } from 'react';
import Toggle from './Toggle';

const meta = {
  title: 'Primitives/Toggle',
  component: Toggle,
  argTypes: {
    label: { control: 'text' },
    disabled: { control: 'boolean' },
    title: { control: 'text' },
    ariaLabel: { control: 'text' },
  },
  parameters: {
    docs: {
      description: {
        component:
          'Monochrome switch. Off — transparent track with hairline border. On — fills with --wp-fg (value-only, no accent hue).',
      },
    },
  },
};

export default meta;

function ControlledToggle(props) {
  const [checked, setChecked] = useState(!!props.checked);
  return <Toggle {...props} checked={checked} onChange={setChecked} />;
}

export const Off = {
  render: (args) => <ControlledToggle {...args} />,
  args: { label: 'Include API key', checked: false },
};

export const On = {
  render: (args) => <ControlledToggle {...args} />,
  args: { label: 'Include API key', checked: true },
};

export const Disabled = {
  render: (args) => <ControlledToggle {...args} />,
  args: { label: 'Locked', checked: true, disabled: true },
};

export const NoLabel = {
  render: (args) => <ControlledToggle {...args} />,
  args: { checked: false },
};

// AriaLabel-only — the consolidated "Switch" callsite shape used inside
// settings' wp-inset-rows. The row title supplies the visible label, so
// the toggle itself takes only an aria-label for screen readers.
export const AriaLabelOnly = {
  render: (args) => <ControlledToggle {...args} />,
  args: { checked: true, ariaLabel: 'System notifications' },
};
