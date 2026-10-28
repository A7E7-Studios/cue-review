import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Sidebar } from '../Sidebar';
import { Icon } from '../icons';
import { date, sections as exampleSections, sessions as exampleSessions } from './fixtures';

type Props = { empty: boolean; longNames: boolean; longList: boolean; locked: boolean; loading: boolean };
function SidebarExample({ empty, longNames, longList, locked, loading }: Props) {
  const [sections, setSections] = useState(() => empty ? [] : exampleSections.map(section => ({ ...section, name: longNames ? `${section.name} — navigation, review and accessibility improvements` : section.name })));
  const [sessions, setSessions] = useState(() => empty ? [] : [...exampleSessions, ...(longList ? Array.from({ length: 36 }, (_, index) => ({ ...exampleSessions[3], id: `recent-${index}`, name: `Review session ${index + 1}` })) : [])].map(session => ({ ...session, name: longNames ? `${session.name} with a very long description that should truncate gracefully` : session.name })));
  const [activeId, setActiveId] = useState('library');
  const [message, setMessage] = useState('Select a recording, move it into a section, or reorder sections. All changes stay in this story.');
  return <div className="workshop-sidebar"><Sidebar sections={sections} sessions={sessions} activeId={activeId} locked={locked} loading={loading}
    utilities={<div className="utility-controls"><button aria-label="Settings" onClick={() => setMessage('Settings action selected.')}><Icon name="settings"/></button></div>}
    onCollapse={() => setMessage('Collapse action selected.')} onNew={() => { setActiveId(''); setMessage('Fresh temporary recording selected.'); }} onOpen={setActiveId}
    onRename={session => setMessage(`Rename selected: ${session.name}`)} onRenameSection={section => setMessage(`Rename selected: ${section.name}`)}
    onCreateSection={() => setSections(items => [...items, { id: `new-${items.length}`, name: 'New section', createdAt: date }])}
    onDeleteSection={section => { setSections(items => items.filter(item => item.id !== section.id)); setSessions(items => items.map(item => item.projectId === section.id ? { ...item, projectId: null } : item)); setMessage('Section removed. Its recordings are back in Recents.'); }}
    onDeleteSession={session => { setSessions(items => items.filter(item => item.id !== session.id)); setMessage('Sample recording removed. No files were accessed.'); }}
    onMove={async (id, projectId) => { setSessions(items => items.map(item => item.id === id ? { ...item, projectId } : item)); setMessage('Recording moved.'); return true; }}
    onReorder={async ids => { setSections(items => ids.map(id => items.find(item => item.id === id)!)); setMessage('Sections reordered.'); return true; }}/>
    <div className="workshop-sidebar-note"><h2>Recording organization</h2><p role="status">{message}</p><p>Use the row menu or drag a recording. Section menus also offer keyboard-accessible Move up and Move down actions.</p></div>
  </div>;
}
const meta = {
  title: 'Sidebar/Organization', component: SidebarExample,
  args: { empty: false, longNames: false, longList: false, locked: false, loading: false },
  render: args => <SidebarExample key={`${args.empty}-${args.longNames}-${args.longList}`} {...args}/>,
} satisfies Meta<typeof SidebarExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Empty: Story = { args: { empty: true } };
export const LongNames: Story = { args: { longNames: true } };
export const LongList: Story = { args: { longList: true } };
export const Busy: Story = { args: { locked: true } };
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
