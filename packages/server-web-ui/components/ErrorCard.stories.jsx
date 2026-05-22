import ErrorCard from './ErrorCard';

const meta = {
  title: 'Primitives/ErrorCard',
  component: ErrorCard,
  argTypes: {
    title: { control: 'text' },
    error: { control: 'text' },
    onRetry: { action: 'retry' },
  },
};

export default meta;

export const ServerUnreachable = {
  args: {
    error: 'Network request failed (ECONNREFUSED)',
  },
};

export const CustomTitleWithRetry = {
  args: {
    title: "Couldn't load formatter history.",
    error: 'HTTP 500 — internal server error',
    onRetry: () => {},
  },
};

export const StringOnly = {
  args: {
    error: 'Something went wrong.',
  },
};

export const NoMessage = {
  args: {
    title: 'Connection lost.',
  },
};
