import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { Sidebar } from './Sidebar';
import type { Session } from './backend';

const session: Session = { id: 'review', projectId: 'work', name: 'Library review', createdAt: '2026-01-01', durationMs: 30000, status: 'ready' };
type Props = ComponentProps<typeof Sidebar>;
function renderSidebar(overrides: Partial<Props> = {}) {
  const onRename = vi.fn();
  const props = (next: Partial<Props> = {}): Props => ({ sections: [{id:'work',name:'Workspace',createdAt:'2026-01-01'}], sessions: [session], activeId: session.id, locked: false, loading: false, utilities: <button>Settings</button>, onCollapse: vi.fn(), onNew: vi.fn(), onOpen: vi.fn(), onRename, onRenameSection: vi.fn(), onCreateSection: vi.fn(), onDeleteSection: vi.fn(), onDeleteSession: vi.fn(), onReorder: vi.fn().mockResolvedValue(true), onMove: vi.fn().mockResolvedValue(true), ...overrides, ...next });
  const view = render(<Sidebar {...props()}/>);
  return {onRename, rerender: (next: Partial<Props>) => view.rerender(<Sidebar {...props(next)}/>)};
}
beforeEach(() => { document.documentElement.dataset.motion = 'reduced'; });
afterEach(() => { delete document.documentElement.dataset.motion; });

test('collapsed sections leave their recordings out of keyboard and accessibility navigation', async () => {
  const user = userEvent.setup();
  renderSidebar();
  await user.click(screen.getByRole('button', {name:'Workspace'}));
  expect(screen.queryByRole('button', {name:'Library review'})).not.toBeInTheDocument();
  expect(document.querySelector('.section-reveal')).toHaveAttribute('inert');
  await user.click(screen.getByRole('button', {name:'Workspace'}));
  expect(screen.getByRole('button', {name:'Library review'})).toBeVisible();
});

test('context menus support typeahead, a single tab stop, and Escape restoration', async () => {
  const user = userEvent.setup();
  const {onRename} = renderSidebar();
  const trigger = screen.getByRole('button', {name:'Recording options'});
  await user.click(trigger);
  const menu = screen.getByRole('menu', {name:'Recording actions'});
  await user.keyboard('r');
  expect(within(menu).getByRole('menuitem', {name:'Rename'})).toHaveFocus();
  expect([...menu.querySelectorAll('button')].filter(button => button.tabIndex === 0)).toHaveLength(1);
  await user.keyboard('{Enter}');
  expect(onRename).toHaveBeenCalledWith(session);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await user.click(trigger);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
});

test('Tab dismisses a context menu and continues into the workspace', async () => {
  const user = userEvent.setup();
  renderSidebar();
  await user.click(screen.getByRole('button', {name:'Recording options'}));
  await user.tab();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  // Focus moves on from the trigger. New section now sits beside New recording (decision 2),
  // so the next stop after the last row is the utility button below the list.
  expect(screen.getByRole('button', {name:'Settings'})).toHaveFocus();
});

test('Space activates the focused menu action', async () => {
  const user = userEvent.setup();
  const {onRename} = renderSidebar();
  await user.click(screen.getByRole('button', {name:'Recording options'}));
  await user.keyboard('r');
  await user.keyboard(' ');
  expect(onRename).toHaveBeenCalledWith(session);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

describe('Float v2 sidebar', () => {
  test('puts New recording first with New section beside it, and hides the shortcut hint from the name', () => {
    renderSidebar({platform: 'windows'});
    const tools = document.querySelector<HTMLElement>('.side-tools')!;
    const create = within(tools).getByRole('button', {name:'New recording'});
    expect(within(tools).getAllByRole('button')).toEqual([create, within(tools).getByRole('button', {name:'New section'})]);
    expect(create).toHaveAttribute('aria-keyshortcuts', 'Control+N');
    const hint = create.querySelector('kbd')!;
    expect(hint).toHaveTextContent('Ctrl+N');
    expect(hint).toHaveAttribute('aria-hidden', 'true');
  });

  test('labels shortcuts with ⌘ on macOS and Ctrl on Linux', () => {
    const {rerender} = renderSidebar({platform: 'macos'});
    const create = screen.getByRole('button', {name:'New recording'});
    expect(create).toHaveAttribute('aria-keyshortcuts', 'Meta+N');
    expect(create.querySelector('kbd')).toHaveTextContent('⌘N');
    rerender({platform: 'linux'});
    expect(create).toHaveAttribute('aria-keyshortcuts', 'Control+N');
    expect(create.querySelector('kbd')).toHaveTextContent('Ctrl+N');
  });

  test('rows show the name only; duration and date are aria-hidden', () => {
    renderSidebar();
    const row = screen.getByRole('button', {name:'Library review'});
    expect(row).toHaveTextContent(/^Library review$/);
    expect(row).toHaveAttribute('aria-current', 'true');
    const meta = row.querySelector('.session-meta')!;
    expect(meta).toHaveAttribute('aria-hidden', 'true');
    expect(meta.getAttribute('data-meta')).toMatch(/^0:30 · \S/);
    expect(screen.queryByText(/\(\d+\)/)).not.toBeInTheDocument();
  });

  test('in-progress rows keep their status and show no duration', () => {
    renderSidebar({sessions: [{...session, status: 'recording'}]});
    const row = screen.getByRole('button', {name:/^Library review/});
    expect(row).toHaveTextContent(/^Library reviewRecording$/);
    expect(row.querySelector('.session-meta')).toBeNull();
  });

  test('filters by session name, opens collapsed sections for matches, and leaves the saved state alone', async () => {
    const user = userEvent.setup();
    const other: Session = {...session, id: 'other', projectId: null, name: 'Export dialog'};
    const {rerender} = renderSidebar({sessions: [session, other]});
    await user.click(screen.getByRole('button', {name:'Workspace'}));
    expect(JSON.parse(localStorage.getItem('cuereview.closedSections')!)).toEqual(['work']);

    rerender({sessions: [session, other], filter: '  LIBRARY '});
    expect(screen.getByRole('button', {name:'Workspace'})).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('region', {name:'Section: Workspace'})).getByRole('button', {name:'Library review'})).toBeVisible();
    expect(screen.queryByRole('button', {name:'Export dialog'})).not.toBeInTheDocument();
    expect(screen.queryByRole('region', {name:'Recents'})).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {name:'Workspace'}));
    expect(screen.getByRole('button', {name:'Workspace'})).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem('cuereview.closedSections')!)).toEqual(['work']);

    rerender({sessions: [session, other], filter: 'export'});
    expect(screen.queryByRole('region', {name:'Section: Workspace'})).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', {name:'Recents'})).getByRole('button', {name:'Export dialog'})).toBeVisible();

    rerender({sessions: [session, other], filter: ''});
    expect(screen.getByRole('button', {name:'Workspace'})).toHaveAttribute('aria-expanded', 'false');
  });

  test('announces No matches when the filter finds nothing', () => {
    const {rerender} = renderSidebar();
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();
    rerender({filter: 'quest'});
    expect(status).toHaveTextContent('No matches');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name:'New recording'})).toBeEnabled();
  });

  test('renders the Collapse sidebar button unless showCollapse is false', async () => {
    const user = userEvent.setup();
    const onCollapse = vi.fn();
    const {rerender} = renderSidebar({onCollapse, platform: 'windows'});
    await user.click(screen.getByRole('button', {name:'Collapse sidebar'}));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    rerender({showCollapse: false});
    expect(screen.queryByRole('button', {name:'Collapse sidebar'})).not.toBeInTheDocument();
    expect(document.querySelector('.side-header')).toBeNull();
  });

  test('macOS keeps the traffic-light row as a drag region, even without the collapse button', () => {
    renderSidebar({platform: 'macos', showCollapse: false});
    const aside = screen.getByRole('complementary', {name:'Recordings'});
    expect(aside).toHaveAttribute('data-platform', 'macos');
    const header = aside.querySelector('.side-header')!;
    expect(header).toHaveAttribute('data-tauri-drag-region');
    expect(header.querySelector('.side-traffic-lights')).toHaveAttribute('aria-hidden', 'true');
    expect(within(aside).getAllByRole('button').filter(button => button.hasAttribute('data-tauri-drag-region'))).toEqual([]);
  });

  test('omits the utility row when Float v2 passes no utilities', () => {
    renderSidebar({utilities: null});
    expect(document.querySelector('.side-bottom')).toBeNull();
  });
});
