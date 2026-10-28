import type { StorybookConfig } from '@storybook/react-vite';
import { fileURLToPath } from 'node:url';

const config: StorybookConfig = {
  stories: ['../src/stories/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: '@storybook/react-vite',
  core: { disableTelemetry: true },
  async viteFinal(config) {
    const { mergeConfig } = await import('vite');
    return mergeConfig(config, {
      // These aliases exist only in the workshop. The shipped app continues to
      // use its real backend; stories cannot invoke capture or change recordings.
      resolve: { alias: [
        { find: './backend', replacement: fileURLToPath(new URL('../src/stories/backend.fixture.ts', import.meta.url)) },
        { find: '@tauri-apps/api/core', replacement: fileURLToPath(new URL('../src/stories/tauri.fixture.ts', import.meta.url)) },
      ] },
    });
  },
};
export default config;
