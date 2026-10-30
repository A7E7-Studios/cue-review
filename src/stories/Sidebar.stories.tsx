import { useLayoutEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { Sidebar } from '../Sidebar';
import type { Platform } from '../chrome/windowApi';
import { date, sections as exampleSections, sessions as exampleSessions } from './fixtures';

/** Sets `:root[data-platform]` for the story, as index.html does in the app, so macOS radii apply. */
export function usePlatformAttribute(os: Platform) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.platform;
    root.dataset.platform = os;
    return () => { if (previous === undefined) delete root.dataset.platform; else root.dataset.platform = previous; };
  }, [os]);
}

/** Workshop stand-in for the native macOS traffic lights at trafficLightPosition (24, 26): their top edge is 26px down. */
export function TrafficLights() {
  return <div aria-hidden="true" style={{ position: 'absolute', left: 24, top: 26, zIndex: 5, display: 'flex', gap: 8, pointerEvents: 'none' }}>
    {['#FF5F57', '#FEBC2E', '#28C840'].map(color => <span key={color} style={{ width: 12, height: 12, borderRadius: '50%', background: color, boxShadow: 'inset 0 0 0 .5px rgba(0, 0, 0, .12)' }}/>)}
  </div>;
}

export const moreRecents = [
  { ...exampleSessions[3], id: 'onboarding', name: 'Onboarding copy pass', durationMs: 58000 },
  { ...exampleSessions[3], id: 'export', name: 'Export dialog edge cases', durationMs: 96000 },
];

type Props = { platform: Platform; selected: boolean; filter: string; showCollapse: boolean; empty: boolean; longNames: boolean; longList: boolean; locked: boolean; loading: boolean };
function SidebarExample({ platform, selected, filter, showCollapse, empty, longNames, longList, locked, loading }: Props) {
  usePlatformAttribute(platform);
  const [sections, setSections] = useState(() => empty ? [] : exampleSections.map(section => ({ ...section, name: longNames ? `${section.name} — navigation, review and accessibility improvements` : section.name })));
  const [sessions, setSessions] = useState(() => empty ? [] : [...exampleSessions, ...moreRecents, ...(longList ? Array.from({ length: 36 }, (_, index) => ({ ...exampleSessions[3], id: `recent-${index}`, name: `Review session ${index + 1}` })) : [])].map(session => ({ ...session, name: longNames ? `${session.name} with a very long description that should truncate gracefully` : session.name })));
  const [activeId, setActiveId] = useState(selected ? 'library' : '');
  const [message, setMessage] = useState('Select a recording, move it into a section, or reorder sections. All changes stay in this story.');
  const mac = platform === 'macos';
  return <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'var(--size-sidebar) minmax(0, 1fr)', height: 'min(720px, 100vh)', background: mac ? 'var(--color-sheet)' : 'var(--color-ground)' }}>
    {mac && <TrafficLights/>}
    <Sidebar platform={platform} showCollapse={showCollapse} filter={filter} sections={sections} sessions={sessions} activeId={activeId} locked={locked} loading={loading} utilities={null}
      onCollapse={() => setMessage('Collapse action selected.')} onNew={() => { setActiveId(''); setMessage('Fresh temporary recording selected.'); }} onOpen={setActiveId}
      onRename={session => setMessage(`Rename selected: ${session.name}`)} onRenameSection={section => setMessage(`Rename selected: ${section.name}`)}
      onCreateSection={() => setSections(items => [...items, { id: `new-${items.length}`, name: 'New section', createdAt: date }])}
      onDeleteSection={section => { setSections(items => items.filter(item => item.id !== section.id)); setSessions(items => items.map(item => item.projectId === section.id ? { ...item, projectId: null } : item)); setMessage('Section removed. Its recordings are back in Recents.'); }}
      onDeleteSession={session => { setSessions(items => items.filter(item => item.id !== session.id)); setMessage('Sample recording removed. No files were accessed.'); }}
      onMove={async (id, projectId) => { setSessions(items => items.map(item => item.id === id ? { ...item, projectId } : item)); setMessage('Recording moved.'); return true; }}
      onReorder={async ids => { setSections(items => ids.map(id => items.find(item => item.id === id)!)); setMessage('Sections reordered.'); return true; }}/>
    <div className="workshop-sidebar-note" style={{ background: 'var(--color-sheet)', ...(mac ? {} : { borderTop: '1px solid var(--color-sheet-edge)', borderLeft: '1px solid var(--color-sheet-edge)', borderTopLeftRadius: 'var(--radius-window)' }) }}>
      <h2>Recording organization</h2>
      <p>{message}</p>
      <p>Use the row menu or drag a recording. Section menus also offer keyboard-accessible Move up and Move down actions. Right-click empty space for New session and New section. Hover or focus a row for its duration and date, and New session for its shortcut.</p>
    </div>
  </div>;
}

const meta = {
  title: 'Sidebar/Organization', component: SidebarExample,
  // Shared with Chrome.stories.tsx; not stories.
  excludeStories: ['usePlatformAttribute', 'TrafficLights', 'moreRecents'],
  args: { platform: 'windows', selected: true, filter: '', showCollapse: false, empty: false, longNames: false, longList: false, locked: false, loading: false },
  argTypes: { platform: { control: 'inline-radio', options: ['windows', 'macos', 'linux'] } },
  render: args => <SidebarExample key={`${args.empty}-${args.longNames}-${args.longList}-${args.selected}`} {...args}/>,
} satisfies Meta<typeof SidebarExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { args: { selected: false } };
export const Selected: Story = {};
export const HoverMeta: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole('button', { name: 'Empty states' });
    row.focus();
    const rowMeta = row.querySelector<HTMLElement>('.session-meta')!;
    await expect(rowMeta).toHaveAttribute('aria-hidden', 'true');
    await waitFor(() => expect(getComputedStyle(rowMeta).display).not.toBe('none'));
    await expect(row).toHaveAccessibleName('Empty states');
  },
};
export const ShortcutHint: Story = {
  play: async ({ canvasElement }) => {
    const create = within(canvasElement).getByRole('button', { name: 'New session' });
    await userEvent.tab();
    await expect(create).toHaveFocus();
    await expect(create).toHaveAttribute('aria-keyshortcuts');
    await expect(create.querySelector('kbd')).toHaveAttribute('aria-hidden', 'true');
  },
};
/** Right-click on empty space in the list: the sidebar's own menu. */
export const SidebarMenu: Story = {
  play: async ({ canvasElement }) => {
    const list = canvasElement.querySelector<HTMLElement>('.recording-list')!;
    const box = list.getBoundingClientRect();
    fireEvent.contextMenu(list, { clientX: box.left + 60, clientY: box.bottom - 120 });
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu', { name: 'Sidebar actions' });
    await expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['New session', 'New section']);
  },
};
export const Filtered: Story = { args: { filter: 'e' } };
export const NoMatches: Story = {
  args: { filter: 'zebra' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('No matches');
  },
};
export const MacOS: Story = { args: { platform: 'macos', showCollapse: true } };
export const Linux: Story = { args: { platform: 'linux' } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const MacOSDark: Story = { args: { platform: 'macos', showCollapse: true }, globals: { theme: 'dark' } };
export const Empty: Story = { args: { empty: true } };
export const LongNames: Story = { args: { longNames: true } };
export const LongList: Story = { args: { longList: true } };
export const Busy: Story = { args: { locked: true } };
/** While recording the sidebar's menu still opens, with both items disabled. */
export const SidebarMenuWhileRecording: Story = { args: { locked: true }, play: SidebarMenu.play };
export const Loading: Story = { args: { empty: true, loading: true } };
export const MoveToRecents: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole('button', { name: 'Recording options' })[0]);
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Move to section' }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Recents' }));
    const recents = canvas.getByRole('region', { name: 'Recents' });
    await expect(within(recents).getByRole('button', { name: 'Library selection and details' })).toBeVisible();
    await waitFor(() => expect(within(recents).getByRole('button', { name: 'Library selection and details' })).toHaveFocus());
  },
};
export const EscapeRestoresFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getAllByRole('button', { name: 'Recording options' })[0];
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('menu')).not.toBeInTheDocument());
    await expect(trigger).toHaveFocus();
  },
};
export const CollapsedSection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Interface' });
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  },
};
export const ContextMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.pointer({ target: canvas.getByRole('button', { name: 'Library selection and details' }), keys: '[MouseRight]' });
    await waitFor(() => expect(canvas.getByRole('menu', { name: 'Recording actions' })).toBeVisible());
  },
};
