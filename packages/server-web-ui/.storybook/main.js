import { dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Resolve the absolute path of a package — needed inside the npm-workspaces
 * monorepo where peer deps may be hoisted to the repo root.
 */
function getAbsolutePath(value) {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`)));
}

/** @type { import('@storybook/nextjs-vite').StorybookConfig } */
const config = {
  stories: [
    // Component-level stories live next to their components.
    // JSX must use the .jsx extension — the Storybook Vite builder doesn't
    // strip JSX out of plain .js during its dep-scan pass.
    '../components/**/*.stories.@(js|jsx|mjs|ts|tsx)',
  ],
  addons: [
    getAbsolutePath('@chromatic-com/storybook'),
    getAbsolutePath('@storybook/addon-a11y'),
    getAbsolutePath('@storybook/addon-docs'),
  ],
  framework: getAbsolutePath('@storybook/nextjs-vite'),
};

export default config;
