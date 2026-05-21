import FormatterErrorCard from './FormatterErrorCard';

const meta = {
  title: 'Primitives/FormatterErrorCard',
  component: FormatterErrorCard,
  parameters: {
    docs: {
      description: {
        component:
          'Inline dashboard row for an unhealthy formatter. Lives alongside PairingPromptCard in the Action Items list. The Report button opens a pre-filled GitHub issue.',
      },
    },
  },
  argTypes: {
    onDismiss: { action: 'dismiss' },
  },
};

export default meta;

const BASIC_ERROR = {
  name: 'github.com',
  errorCount: 3,
  lastErrorAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  lastError: {
    id: 17,
    phase: 'format',
    workflow: null,
    message: 'TypeError: Cannot read properties of undefined (reading "title")',
    stack:
      'TypeError: Cannot read properties of undefined (reading "title")\n    at format (/formatters/github-pr.js:42:18)\n    at runFormatter (/lib/formatter-runtime.js:88:9)',
    timestamp: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  },
};

const WORKFLOW_ERROR = {
  name: 'linear.app',
  errorCount: 1,
  lastErrorAt: new Date().toISOString(),
  lastError: {
    id: 23,
    phase: 'detect',
    workflow: 'issue-detail',
    message: 'Selector ".IssueDetail" did not match — Linear redesigned the page.',
    stack: '',
    timestamp: new Date().toISOString(),
  },
};

const LONG_MESSAGE_ERROR = {
  name: 'docs.google.com',
  errorCount: 42,
  lastErrorAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  lastError: {
    id: 41,
    phase: 'format',
    workflow: 'doc-outline',
    message:
      'A really long message that should get truncated in the row sub-line. ' +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod ' +
      'tempor incididunt ut labore et dolore magna aliqua.',
    stack: '',
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
};

export const Default = {
  args: { formatter: BASIC_ERROR },
};

export const WithWorkflow = {
  args: { formatter: WORKFLOW_ERROR },
};

export const LongMessage = {
  args: { formatter: LONG_MESSAGE_ERROR },
};

export const InsideCard = {
  render: (args) => (
    <div className="wp-card" style={{ padding: 0 }}>
      <FormatterErrorCard {...args} formatter={BASIC_ERROR} />
      <FormatterErrorCard {...args} formatter={WORKFLOW_ERROR} />
    </div>
  ),
};
