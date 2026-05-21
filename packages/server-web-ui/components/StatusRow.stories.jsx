import {
  GlobeAltIcon,
  CpuChipIcon,
  CommandLineIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import StatusRow from './StatusRow';

const meta = {
  title: 'Primitives/StatusRow',
  component: StatusRow,
  parameters: {
    docs: {
      description: {
        component:
          'Row inside the Dashboard "System status" card. Dot color carries the state; value text sits to the right.',
      },
    },
  },
  argTypes: {
    state: {
      control: { type: 'inline-radio' },
      options: ['ok', 'warn', 'danger', 'unknown'],
    },
    label: { control: 'text' },
    value: { control: 'text' },
    actionLabel: { control: 'text' },
    onAction: { action: 'action-clicked' },
  },
};

export default meta;

export const Ok = {
  args: {
    label: 'Chrome',
    icon: GlobeAltIcon,
    state: 'ok',
    value: 'Connected',
  },
};

export const Warning = {
  args: {
    label: 'Formatter: github.com',
    icon: CommandLineIcon,
    state: 'warn',
    value: '2 errors',
    actionLabel: 'View logs',
  },
};

export const Danger = {
  args: {
    label: 'Native messaging host',
    icon: ShieldCheckIcon,
    state: 'danger',
    value: 'Not installed',
    actionLabel: 'Reinstall',
  },
};

export const Stack = {
  render: () => (
    <div className="wp-card" style={{ padding: 0 }}>
      <StatusRow label="Chrome" icon={GlobeAltIcon} state="ok" value="Connected" />
      <StatusRow label="MCP server" icon={CpuChipIcon} state="ok" value="Listening on :3100" />
      <StatusRow
        label="Formatter: github.com"
        icon={CommandLineIcon}
        state="warn"
        value="2 errors"
        actionLabel="View logs"
        onAction={() => {}}
      />
    </div>
  ),
};
