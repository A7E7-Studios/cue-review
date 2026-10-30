import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import App from '../App';
import type { Platform } from '../chrome/windowApi';
import { configureScenario } from './backend.fixture';
import type { Scenario as FixtureScenario } from './backend.fixture';
import { TrafficLights, usePlatformAttribute } from './Sidebar.stories';

// The whole app on the in-memory workshop backend. Nothing records, and window controls
// do nothing outside the desktop app. macOS draws stand-in traffic lights where the native
// ones sit. Use the viewport toolbar for 1280 × 820, 900 × 650 and the 520 × 320 compact recorder.

type Scenario = 'fresh' | 'recording' | 'recording-take' | 'processing' | 'takes' | 'window-closed' | 'unavailable' | 'setup' | 'compact';
const FIXTURE: Record<Scenario, FixtureScenario> = {
  fresh: 'fresh', recording: 'recording', 'recording-take': 'recording-take', processing: 'processing',
  takes: 'takes', 'window-closed': 'window-closed', unavailable: 'unavailable', setup: 'setup', compact: 'recording-take',
};
const SCENARIOS: Scenario[] = ['fresh', 'recording', 'recording-take', 'processing', 'takes', 'window-closed', 'unavailable', 'setup', 'compact'];
interface Args { scenario: Scenario; platform: Platform }

function Workspace({ scenario, platform }: Args) {
  usePlatformAttribute(platform);
  useState(() => { configureScenario(FIXTURE[scenario]); return true; });
  return <div style={{ position: 'relative' }}>
    {platform === 'macos' && <TrafficLights/>}
    <App platform={platform}/>
  </div>;
}

const openLibrary = async (canvas: ReturnType<typeof within>) => {
  // Below 1000px the sidebar starts hidden; its toggle shows it over the sheet.
  await canvas.findByRole('button', { name: 'Record' });
  const toggle = canvas.queryByRole('button', { name: 'Show sidebar' });
  if (toggle) await userEvent.click(toggle);
  await userEvent.click(await canvas.findByRole('button', { name: 'Library selection and details' }));
};
const openTakes: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await openLibrary(canvas);
  await canvas.findByText('Take 2 · 1:20');
  await waitFor(() => expect(canvas.getByRole('button', { name: 'Record more' })).toBeEnabled());
  // The moment the mocks show: "grid" at 0:33.
  await waitFor(() => expect(canvas.getByRole('group', { name: 'Playback' })).toHaveTextContent('/ 2:14'));
  await userEvent.click(canvas.getByRole('button', { name: 'Seek to grid at 0:33' }));
  await userEvent.unhover(canvas.getByRole('button', { name: 'Seek to grid at 0:33' }));
  (canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
};
// The window chosen in the bar has closed: Record more is refused under the recording bar, offering New recording.
const refuseRecordMore: Story['play'] = async context => {
  await openTakes(context);
  const canvas = within(context.canvasElement);
  const bar = within(canvas.getByRole('group', { name: 'Recording bar' }));
  await userEvent.click(bar.getByRole('button', { name: 'Display 1' }));
  await userEvent.click(within(await canvas.findByRole('group', { name: 'Capture sources' })).getByRole('button', { name: 'Design review — Figma' }));
  await userEvent.click(bar.getByRole('button', { name: 'Record more' }));
  const message = await bar.findByRole('alert');
  await expect(message).toHaveTextContent('no longer available');
  await expect(within(message).getByRole('button', { name: 'New recording' })).toBeVisible();
  (context.canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
};
const enterCompact: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Compact' }));
  await expect(await canvas.findByRole('button', { name: 'Expand' })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Stop' })).toBeVisible();
};
const compact = { viewport: { value: 'compact', isRotated: false } };
const dark = { theme: 'dark' };

const meta = {
  title: 'Workspace/Scenarios', component: Workspace,
  args: { scenario: 'fresh', platform: 'windows' },
  argTypes: {
    scenario: { control: 'select', options: SCENARIOS },
    platform: { control: 'inline-radio', options: ['windows', 'macos', 'linux'] },
  },
  render: args => <Workspace key={`${args.scenario}-${args.platform}`} {...args}/>,
  globals: { viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;

// Windows
export const WindowsFresh: Story = {};
export const WindowsFreshDark: Story = { globals: dark };
export const WindowsRecording: Story = { args: { scenario: 'recording' } };
export const WindowsRecordingDark: Story = { args: { scenario: 'recording' }, globals: dark };
export const WindowsRecordingTakeTwo: Story = { args: { scenario: 'recording-take' } };
export const WindowsRecordingTakeTwoDark: Story = { args: { scenario: 'recording-take' }, globals: dark };
export const WindowsProcessing: Story = { args: { scenario: 'processing' } };
export const WindowsProcessingDark: Story = { args: { scenario: 'processing' }, globals: dark };
export const WindowsReviewTakes: Story = { args: { scenario: 'takes' }, play: openTakes };
export const WindowsReviewTakesDark: Story = { args: { scenario: 'takes' }, globals: dark, play: openTakes };
export const WindowsWindowClosed: Story = { args: { scenario: 'window-closed' }, play: refuseRecordMore };
export const WindowsWindowClosedDark: Story = { args: { scenario: 'window-closed' }, globals: dark, play: refuseRecordMore };
export const WindowsUnavailable: Story = { args: { scenario: 'unavailable' } };
export const WindowsUnavailableDark: Story = { args: { scenario: 'unavailable' }, globals: dark };
export const WindowsSetup: Story = { args: { scenario: 'setup' } };
export const WindowsSetupDark: Story = { args: { scenario: 'setup' }, globals: dark };
export const WindowsCompact: Story = { args: { scenario: 'compact' }, globals: compact, play: enterCompact };
export const WindowsCompactDark: Story = { args: { scenario: 'compact' }, globals: { ...compact, ...dark }, play: enterCompact };

// macOS
export const MacFresh: Story = { args: { platform: 'macos' } };
export const MacFreshDark: Story = { args: { platform: 'macos' }, globals: dark };
export const MacRecording: Story = { args: { platform: 'macos', scenario: 'recording' } };
export const MacRecordingDark: Story = { args: { platform: 'macos', scenario: 'recording' }, globals: dark };
export const MacRecordingTakeTwo: Story = { args: { platform: 'macos', scenario: 'recording-take' } };
export const MacRecordingTakeTwoDark: Story = { args: { platform: 'macos', scenario: 'recording-take' }, globals: dark };
export const MacProcessing: Story = { args: { platform: 'macos', scenario: 'processing' } };
export const MacProcessingDark: Story = { args: { platform: 'macos', scenario: 'processing' }, globals: dark };
export const MacReviewTakes: Story = { args: { platform: 'macos', scenario: 'takes' }, play: openTakes };
export const MacReviewTakesDark: Story = { args: { platform: 'macos', scenario: 'takes' }, globals: dark, play: openTakes };
export const MacWindowClosed: Story = { args: { platform: 'macos', scenario: 'window-closed' }, play: refuseRecordMore };
export const MacWindowClosedDark: Story = { args: { platform: 'macos', scenario: 'window-closed' }, globals: dark, play: refuseRecordMore };
export const MacUnavailable: Story = { args: { platform: 'macos', scenario: 'unavailable' } };
export const MacUnavailableDark: Story = { args: { platform: 'macos', scenario: 'unavailable' }, globals: dark };
export const MacSetup: Story = { args: { platform: 'macos', scenario: 'setup' } };
export const MacSetupDark: Story = { args: { platform: 'macos', scenario: 'setup' }, globals: dark };
export const MacCompact: Story = { args: { platform: 'macos', scenario: 'compact' }, globals: compact, play: enterCompact };
export const MacCompactDark: Story = { args: { platform: 'macos', scenario: 'compact' }, globals: { ...compact, ...dark }, play: enterCompact };

// Linux
export const LinuxFresh: Story = { args: { platform: 'linux' } };
export const LinuxFreshDark: Story = { args: { platform: 'linux' }, globals: dark };
export const LinuxRecording: Story = { args: { platform: 'linux', scenario: 'recording' } };
export const LinuxRecordingDark: Story = { args: { platform: 'linux', scenario: 'recording' }, globals: dark };
export const LinuxRecordingTakeTwo: Story = { args: { platform: 'linux', scenario: 'recording-take' } };
export const LinuxRecordingTakeTwoDark: Story = { args: { platform: 'linux', scenario: 'recording-take' }, globals: dark };
export const LinuxProcessing: Story = { args: { platform: 'linux', scenario: 'processing' } };
export const LinuxProcessingDark: Story = { args: { platform: 'linux', scenario: 'processing' }, globals: dark };
export const LinuxReviewTakes: Story = { args: { platform: 'linux', scenario: 'takes' }, play: openTakes };
export const LinuxReviewTakesDark: Story = { args: { platform: 'linux', scenario: 'takes' }, globals: dark, play: openTakes };
export const LinuxWindowClosed: Story = { args: { platform: 'linux', scenario: 'window-closed' }, play: refuseRecordMore };
export const LinuxWindowClosedDark: Story = { args: { platform: 'linux', scenario: 'window-closed' }, globals: dark, play: refuseRecordMore };
export const LinuxUnavailable: Story = { args: { platform: 'linux', scenario: 'unavailable' } };
export const LinuxUnavailableDark: Story = { args: { platform: 'linux', scenario: 'unavailable' }, globals: dark };
export const LinuxSetup: Story = { args: { platform: 'linux', scenario: 'setup' } };
export const LinuxSetupDark: Story = { args: { platform: 'linux', scenario: 'setup' }, globals: dark };
export const LinuxCompact: Story = { args: { platform: 'linux', scenario: 'compact' }, globals: compact, play: enterCompact };
export const LinuxCompactDark: Story = { args: { platform: 'linux', scenario: 'compact' }, globals: { ...compact, ...dark }, play: enterCompact };

// Interactions
export const SelectDevice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Display 1' }));
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
    await expect(canvas.getByRole('heading', { name: 'No video available' })).toBeVisible();
  },
};
export const RecordMoreThenStop: Story = {
  args: { scenario: 'takes' },
  play: async context => {
    await openTakes(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Record more' }));
    await expect(await canvas.findByRole('timer', { name: 'Take 3 elapsed time' })).toBeVisible();
    await expect(canvas.getByText('Take 3 · recording')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Copy for agent' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Record more' })).toBeEnabled());
  },
};
export const WindowClosedNewRecording: Story = {
  args: { scenario: 'window-closed' },
  play: async context => {
    await refuseRecordMore(context);
    const canvas = within(context.canvasElement);
    const message = within(canvas.getByRole('group', { name: 'Recording bar' })).getByRole('alert');
    await userEvent.click(within(message).getByRole('button', { name: 'New recording' }));
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('New recording');
    await expect(canvas.queryByRole('alert')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Record' })).toBeEnabled();
  },
};
export const WindowClosedAnotherSource: Story = {
  args: { scenario: 'window-closed' },
  play: async context => {
    await refuseRecordMore(context);
    const canvas = within(context.canvasElement);
    const bar = within(canvas.getByRole('group', { name: 'Recording bar' }));
    await userEvent.click(bar.getByRole('button', { name: 'Design review — Figma' }));
    await userEvent.click(within(await canvas.findByRole('group', { name: 'Capture sources' })).getByRole('button', { name: 'Display 1' }));
    await userEvent.click(bar.getByRole('button', { name: 'Record more' }));
    await expect(await canvas.findByRole('timer', { name: 'Take 3 elapsed time' })).toBeVisible();
  },
};
export const DeleteConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const row = await canvas.findByRole('button', { name: 'Empty states' });
    await userEvent.hover(row);
    await userEvent.click(within(row.parentElement!).getByRole('button', { name: 'Recording options' }));
    await userEvent.click(await body.findByRole('menuitem', { name: 'Delete recording…' }));
    const dialog = await body.findByRole('alertdialog', { name: 'Delete recording?' });
    await expect(dialog).toHaveTextContent('all its files');
    await expect(body.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  },
};
export const RenameRecording: Story = {
  args: { scenario: 'takes' },
  play: async context => {
    await openTakes(context);
    const canvas = within(context.canvasElement);
    const body = within(context.canvasElement.ownerDocument.body);
    await userEvent.click(within(canvas.getByRole('heading', { level: 1 })).getByRole('button', { name: 'Library selection and details' }));
    const dialog = await body.findByRole('dialog', { name: 'Recording name' });
    await waitFor(() => expect(dialog).toBeVisible());
    await expect(body.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  },
};
export const SearchRecordings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('searchbox', { name: 'Search recordings' });
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect(field).toHaveFocus();
    // As in Chrome.stories: in the static workshop, user-event typing does not reach React 19's
    // onChange for this controlled field (real typing does), so the query goes through the native setter.
    fireEvent.input(field, { target: { value: 'quest' } });
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'Library selection and details' })).not.toBeInTheDocument());
    await expect(canvas.getByRole('button', { name: 'Quest navigation' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(await canvas.findByRole('button', { name: 'Library selection and details' })).toBeVisible();
  },
};
