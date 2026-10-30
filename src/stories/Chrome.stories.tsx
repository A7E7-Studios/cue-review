import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sidebar } from '../Sidebar';
import { TitleBar } from '../chrome/TitleBar';
import type { Platform } from '../chrome/windowApi';
import { sections, sessions } from './fixtures';
import { moreRecents, TrafficLights, usePlatformAttribute } from './Sidebar.stories';

// Window chrome (decision 9). Window controls are no-ops in the workshop: windowApi only acts inside
// the desktop app. The macOS traffic lights are drawn by the workshop where the native ones would sit.

type Props = { layout: 'bar' | 'window'; platform: Platform; sidebarVisible: boolean; maximized?: boolean; compact: boolean };
const sheet = (os: Platform): CSSProperties => ({
  minWidth: 0, minHeight: 0, padding: '16px 28px', background: 'var(--color-sheet)', color: 'var(--color-text)',
  ...(os === 'macos' ? {} : { borderTop: '1px solid var(--color-sheet-edge)', borderLeft: '1px solid var(--color-sheet-edge)', borderTopLeftRadius: 'var(--radius-window)' }),
});

function ChromeExample({ layout, platform, sidebarVisible: initiallyVisible, maximized, compact }: Props) {
  usePlatformAttribute(platform);
  const [sidebarVisible, setSidebarVisible] = useState(initiallyVisible);
  const [activeId, setActiveId] = useState('library');
  const [message, setMessage] = useState('Window controls do nothing in the workshop.');
  const mac = platform === 'macos';
  const bar = <TitleBar platform={platform} sidebarVisible={sidebarVisible} onToggleSidebar={() => setSidebarVisible(visible => !visible)}
    onOpenSettings={() => setMessage('Settings selected.')} maximized={maximized} compact={compact}/>;
  const body = <div style={sheet(platform)}>
    <h1 style={{ fontSize: 'var(--font-size-title)', fontWeight: 'var(--font-weight-title)', lineHeight: 'var(--line-height-title)' }}>{compact ? 'Recording' : 'Library selection and details'}</h1>
    <p style={{ color: 'var(--color-text-secondary)', marginTop: 8 }}>{message}</p>
  </div>;

  if (layout === 'bar' || compact) return <div style={{ position: 'relative', background: mac ? 'var(--color-sheet)' : 'var(--color-ground)', minHeight: 160, display: 'flex', flexDirection: 'column' }}>
    {mac && <TrafficLights/>}
    {bar}
    {body}
  </div>;

  const sidebar = sidebarVisible && <Sidebar platform={platform} showCollapse={mac} onSearch={() => setMessage('Search selected.')} sections={sections} sessions={[...sessions, ...moreRecents]} activeId={activeId}
    locked={false} loading={false} utilities={null} onCollapse={() => setSidebarVisible(false)} onNew={() => setActiveId('')} onOpen={setActiveId}
    onRename={() => {}} onRenameSection={() => {}} onCreateSection={() => {}} onDeleteSection={() => {}} onDeleteSession={() => {}}
    onReorder={async () => true} onMove={async () => true}/>;
  const columns = sidebarVisible ? 'var(--size-sidebar) minmax(0, 1fr)' : 'minmax(0, 1fr)';
  if (mac) return <div style={{ position: 'relative', height: 'min(820px, 100vh)', display: 'grid', gridTemplateColumns: columns, background: 'var(--color-sheet)' }}>
    <TrafficLights/>
    {sidebar}
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>{bar}{body}</div>
  </div>;
  return <div style={{ height: 'min(820px, 100vh)', display: 'flex', flexDirection: 'column', background: 'var(--color-ground)' }}>
    {bar}
    <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: columns }}>{sidebar}{body}</div>
  </div>;
}

const meta = {
  title: 'Chrome/Window chrome', component: ChromeExample,
  args: { layout: 'bar', platform: 'windows', sidebarVisible: true, compact: false },
  argTypes: {
    layout: { control: 'inline-radio', options: ['bar', 'window'] },
    platform: { control: 'inline-radio', options: ['windows', 'macos', 'linux'] },
    maximized: { control: 'boolean', description: 'Leave unset to track the window (always restored in the workshop).' },
  },
  render: args => <ChromeExample key={`${args.platform}-${args.sidebarVisible}-${args.compact}`} {...args}/>,
} satisfies Meta<typeof ChromeExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Windows: Story = {};
export const WindowsMaximized: Story = { args: { maximized: true } };
export const WindowsSidebarHidden: Story = { args: { sidebarVisible: false } };
export const MacOS: Story = { args: { platform: 'macos' } };
export const MacOSSidebarHidden: Story = { args: { platform: 'macos', sidebarVisible: false } };
export const Linux: Story = { args: { platform: 'linux' } };
export const CompactWindows: Story = { args: { compact: true } };
export const CompactMacOS: Story = { args: { platform: 'macos', compact: true } };
export const Dark: Story = { globals: { theme: 'dark' } };

export const WindowsWindow: Story = { args: { layout: 'window' } };
export const MacOSWindow: Story = { args: { layout: 'window', platform: 'macos' } };
export const LinuxWindow: Story = { args: { layout: 'window', platform: 'linux' } };
export const WindowsWindowDark: Story = { args: { layout: 'window' }, globals: { theme: 'dark' } };
export const MacOSWindowDark: Story = { args: { layout: 'window', platform: 'macos' }, globals: { theme: 'dark' } };
