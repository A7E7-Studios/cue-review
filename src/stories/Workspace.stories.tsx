import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import App from '../App';
import { configureScenario } from './backend.fixture';
import type { Scenario } from './backend.fixture';

function Workspace({ scenario }: { scenario: Scenario }) {
  useState(() => { configureScenario(scenario); return true; });
  return <App/>;
}
const meta = {
  title: 'Workspace/Scenarios', component: Workspace,
  args: { scenario: 'fresh' },
  argTypes: { scenario: { control: 'select', options: ['fresh', 'recording', 'processing', 'unavailable', 'setup'] } },
  render: args => <Workspace key={args.scenario} {...args}/>,
} satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FreshRecording: Story = {};
export const Recording: Story = { args: { scenario: 'recording' } };
export const Processing: Story = { args: { scenario: 'processing' } };
export const MissingDevices: Story = { args: { scenario: 'unavailable' } };
export const SetupNeeded: Story = { args: { scenario: 'setup' } };
export const CompactRecorder: Story = {
  args: { scenario: 'recording' },
  globals: { viewport: { value: 'compact', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Compact' }));
    await expect(canvas.getByRole('button', { name: 'Expand' })).toBeVisible();
  },
};
export const SelectDevice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const source = await canvas.findByRole('button', { name: 'Display 1' });
    await userEvent.click(source);
    await userEvent.click(canvas.getByRole('button', { name: 'Quest 3' }));
    await waitFor(() => expect(canvas.queryByRole('group', { name: 'Capture sources' })).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: 'Quest 3' })).toHaveFocus();
  },
};
export const TranscriptWithoutVideo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Library selection and details' }));
    await expect(await canvas.findByRole('button', { name: /Seek to this model/ })).toBeVisible();
  },
};
