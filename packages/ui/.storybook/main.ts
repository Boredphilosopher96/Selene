import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  staticDirs: [{ from: './fixtures', to: '/fixtures' }],
  addons: ['@storybook/addon-a11y'],
  framework: '@storybook/react-vite',
  viteFinal: async (viteConfig) => ({
    ...viteConfig,
    base: process.env.STORYBOOK_BASE_PATH ?? viteConfig.base
  })
};

export default config;
