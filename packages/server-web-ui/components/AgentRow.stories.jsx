import AgentRow from './AgentRow';

const meta = {
  title: 'Primitives/AgentRow',
  component: AgentRow,
  parameters: {
    docs: {
      description: {
        component:
          'Single agent row on the /ui/agents page. Includes inline rename, profile rebind, regenerate key, and revoke.',
      },
    },
  },
  argTypes: {
    onRename: { action: 'rename' },
    onRevoke: { action: 'revoke' },
    onRebind: { action: 'rebind' },
    onRegenerate: { action: 'regenerate' },
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
  id: 1,
  lastActive: new Date(Date.now() - 1000 * 60 * 4).toISOString(),
  profileId: 'Default',
};

const AGENT_FRESH = {
  name: 'Cursor — local',
  id: 2,
  lastActive: new Date().toISOString(),
  profileId: 'Profile 2',
};

const AGENT_UNNAMED = {
  name: '',
  id: 3,
  lastActive: null,
  profileId: null,
};

const AGENT_STALE = {
  name: 'Dropped agent',
  id: 4,
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

export const NoRebindHandler = {
  args: {
    agent: AGENT_NAMED,
    profiles: PROFILES,
    onRebind: undefined,
  },
  parameters: {
    docs: {
      description: {
        story: 'Profile rebind is disabled when no onRebind handler is supplied.',
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
