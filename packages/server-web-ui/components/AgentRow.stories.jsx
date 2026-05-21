import AgentRow from './AgentRow';

const meta = {
  title: 'Primitives/AgentRow',
  component: AgentRow,
  parameters: {
    docs: {
      description: {
        component:
          'Single agent row on the /ui/agents page. Includes inline rename, profile rebind, copy-config, and revoke.',
      },
    },
  },
  argTypes: {
    onRename: { action: 'rename' },
    onRevoke: { action: 'revoke' },
    onRebind: { action: 'rebind' },
  },
};

export default meta;

const PROFILES = [
  { directoryName: 'Default', displayName: 'Default' },
  { directoryName: 'Profile 2', displayName: 'Work' },
  { directoryName: 'Profile 3', displayName: 'Personal' },
];

const AGENT_NAMED = {
  name: 'Claude Code — webpilot-marketing',
  key: 'wp_live_abcdef0123456789xyz',
  lastActive: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
  profileId: 'Default',
};

const AGENT_FRESH = {
  name: 'Cursor — local',
  key: 'wp_live_qweqweqweqweqweqweqwe',
  lastActive: new Date().toISOString(),
  profileId: 'Profile 2',
};

const AGENT_UNNAMED = {
  name: '',
  key: 'wp_live_zzzyyyxxx000111222',
  lastActive: null,
  profileId: null,
};

const AGENT_STALE = {
  name: 'Dropped agent',
  key: 'wp_live_aaa111bbb222ccc333',
  lastActive: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
  profileId: 'Profile 2',
};

export const Active = {
  args: { agent: AGENT_NAMED, profiles: PROFILES, port: 3100 },
};

export const JustNow = {
  args: { agent: AGENT_FRESH, profiles: PROFILES, port: 3100 },
};

export const Unnamed = {
  args: { agent: AGENT_UNNAMED, profiles: PROFILES, port: 3100 },
};

export const StaleAndUnboundProfile = {
  args: {
    agent: { ...AGENT_STALE, profileId: 'Removed Profile' },
    profiles: PROFILES,
    port: 3100,
  },
};

export const NoPortKnown = {
  args: {
    agent: AGENT_NAMED,
    profiles: PROFILES,
    port: undefined,
  },
  parameters: {
    docs: {
      description: {
        story: 'Copy-config disables when port is unknown — surfaces the refresh hint.',
      },
    },
  },
};

export const ListExample = {
  render: (args) => (
    <div className="wp-card" style={{ padding: 0 }}>
      <AgentRow {...args} agent={AGENT_NAMED} profiles={PROFILES} port={3100} />
      <AgentRow {...args} agent={AGENT_FRESH} profiles={PROFILES} port={3100} />
      <AgentRow {...args} agent={AGENT_UNNAMED} profiles={PROFILES} port={3100} />
    </div>
  ),
};
