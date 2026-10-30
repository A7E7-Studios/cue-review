import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { Sidebar } from './Sidebar';
import type { Session } from './backend';

const session: Session = { id: 'review', projectId: 'work', name: 'Library review', createdAt: '2026-01-01', durationMs: 30000, status: 'ready' };
type Props = ComponentProps<typeof Sidebar>;
function renderSidebar(overrides: Partial<Props> = {}) {
  const onRename = vi.fn();
  const onNew = vi.fn();
  const onCreateSection = vi.fn();
  const props = (next: Partial<Props> = {}): Props => ({ sections: [{id:'work',name:'Workspace',createdAt:'2026-01-01'}], sessions: [session], activeId: session.id, locked: false, loading: false, utilities: <button>Settings</button>, onCollapse: vi.fn(), onNew, onOpen: vi.fn(), onRename, onRenameSection: vi.fn(), onCreateSection, onDeleteSection: vi.fn(), onDeleteSession: vi.fn(), onReorder: vi.fn().mockResolvedValue(true), onMove: vi.fn().mockResolvedValue(true), ...overrides, ...next });
  const view = render(<Sidebar {...props()}/>);
  return {onRename, onNew, onCreateSection, rerender: (next: Partial<Props>) => view.rerender(<Sidebar {...props(next)}/>)};
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
  // Focus moves on from the trigger: the next stop after the last row is the utility button below the list.
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
  test('puts New session alone at the top with a plus, and hides the shortcut hint from the name', () => {
    renderSidebar({platform: 'windows'});
    const tools = document.querySelector<HTMLElement>('.side-tools')!;
    const create = within(tools).getByRole('button', {name:'New session'});
    expect(within(tools).getAllByRole('button')).toEqual([create]);
    expect(create.querySelector('svg')).not.toBeNull();
    expect(create.querySelector('.new-recording-dot')).toBeNull();
    expect(screen.queryByRole('button', {name:'New section'})).not.toBeInTheDocument();
    expect(create).toHaveAttribute('aria-keyshortcuts', 'Control+N');
    const hint = create.querySelector('kbd')!;
    expect(hint).toHaveTextContent('Ctrl+N');
    expect(hint).toHaveAttribute('aria-hidden', 'true');
  });

  test('labels shortcuts with ⌘ on macOS and Ctrl on Linux', () => {
    const {rerender} = renderSidebar({platform: 'macos'});
    const create = screen.getByRole('button', {name:'New session'});
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

  test('in-progress rows show a status dot, speak their status, and show no duration', () => {
    const {rerender} = renderSidebar({sessions: [{...session, status: 'recording'}]});
    const row = screen.getByRole('button', {name:'Library review, recording'});
    // The dot is decorative; the status is visually hidden text, so no visible label truncates the name.
    expect(row.querySelector('.session-status-dot')).toHaveAttribute('aria-hidden', 'true');
    expect(row.querySelector('.session-status-dot')).toHaveAttribute('data-status', 'recording');
    expect(row.querySelector('.session-status-text')).toHaveTextContent(', recording');
    expect(row.querySelector('small')).toBeNull();
    expect(row.querySelector('.session-meta')).toBeNull();
    rerender({sessions: [{...session, status: 'processing'}]});
    expect(screen.getByRole('button', {name:'Library review, processing'}).querySelector('.session-status-dot')).toHaveAttribute('data-status', 'processing');
    rerender({sessions: [{...session, status: 'ready'}]});
    expect(screen.getByRole('button', {name:'Library review'}).querySelector('.session-status-dot')).toBeNull();
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
    expect(screen.getByRole('button', {name:'New session'})).toBeEnabled();
  });

  test('renders the Hide sidebar button unless showCollapse is false', async () => {
    const user = userEvent.setup();
    const onCollapse = vi.fn();
    const {rerender} = renderSidebar({onCollapse, platform: 'windows'});
    await user.click(screen.getByRole('button', {name:'Hide sidebar'}));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    rerender({showCollapse: false});
    expect(screen.queryByRole('button', {name:'Hide sidebar'})).not.toBeInTheDocument();
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

describe('the sidebar menu', () => {
  test('right-clicking empty space in the list offers New session and New section', async () => {
    const user = userEvent.setup();
    const {onNew, onCreateSection} = renderSidebar();
    fireEvent.contextMenu(document.querySelector('.recording-list')!, {clientX: 40, clientY: 400});
    const menu = screen.getByRole('menu', {name:'Sidebar actions'});
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['New session', 'New section']);
    await user.click(within(menu).getByRole('menuitem', {name:'New section'}));
    expect(onCreateSection).toHaveBeenCalledWith();
    fireEvent.contextMenu(document.querySelector('.recording-list')!, {clientX: 40, clientY: 400});
    await user.click(screen.getByRole('menuitem', {name:'New session'}));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  test('closes the sidebar menu on a click outside it', async () => {
    const user = userEvent.setup();
    renderSidebar();
    fireEvent.contextMenu(document.querySelector('.recording-list')!, {clientX: 40, clientY: 400});
    expect(screen.getByRole('menu', {name:'Sidebar actions'})).toBeVisible();
    await user.click(screen.getByRole('button', {name:'Settings'}));
    expect(screen.queryByRole('menu', {name:'Sidebar actions'})).not.toBeInTheDocument();
  });

  test('a right-click on a row or section options button opens its own menu', () => {
    renderSidebar({onNewInSection: vi.fn()});
    fireEvent.contextMenu(screen.getByRole('button', {name:'New session in Workspace'}));
    expect(screen.getByRole('menu', {name:'Section actions'})).toBeVisible();
    fireEvent.contextMenu(screen.getByRole('button', {name:'Recording options'}));
    expect(screen.getByRole('menu', {name:'Recording actions'})).toBeVisible();
    fireEvent.contextMenu(screen.getByRole('button', {name:'Section options for Workspace'}));
    expect(screen.getByRole('menu', {name:'Section actions'})).toBeVisible();
    expect(screen.queryByRole('menu', {name:'Sidebar actions'})).not.toBeInTheDocument();
  });

  test('a row keeps its own menu, and the New session button opens the sidebar menu from the keyboard', async () => {
    const user = userEvent.setup();
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole('button', {name:'Library review'}));
    expect(screen.getByRole('menu', {name:'Recording actions'})).toBeVisible();
    await user.keyboard('{Escape}');
    const create = screen.getByRole('button', {name:'New session'});
    create.focus();
    fireEvent.contextMenu(create);
    expect(screen.getByRole('menuitem', {name:'New session'})).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(create).toHaveFocus();
  });

  test('opens the sidebar menu with both items disabled while recording', async () => {
    const user = userEvent.setup();
    const {onNew, onCreateSection} = renderSidebar({locked: true});
    fireEvent.contextMenu(document.querySelector('.recording-list')!);
    const items = within(screen.getByRole('menu', {name:'Sidebar actions'})).getAllByRole('menuitem');
    expect(items.map(item => item.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    expect(items[0]).toHaveFocus();
    await user.click(items[0]); await user.click(items[1]);
    expect(onNew).not.toHaveBeenCalled();
    expect(onCreateSection).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('opens from anywhere in the sidebar outside rows and headings', () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole('button', {name:'Settings'}));
    expect(screen.getByRole('menu', {name:'Sidebar actions'})).toBeVisible();
  });

  test('closes when the New session row it was opened from is clicked', async () => {
    const user = userEvent.setup();
    const {onNew} = renderSidebar();
    const create = screen.getByRole('button', {name:'New session'});
    fireEvent.contextMenu(create);
    expect(screen.getByRole('menu', {name:'Sidebar actions'})).toBeVisible();
    await user.click(create);
    expect(screen.queryByRole('menu', {name:'Sidebar actions'})).not.toBeInTheDocument();
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

describe('Move to section submenu', () => {
  const twoSections = [{ id: 'work', name: 'Workspace', createdAt: '2026-01-01' }, { id: 'home', name: 'Home', createdAt: '2026-01-02' }];
  test('opens Move to section as a submenu on hover', async () => {
    const user = userEvent.setup();
    renderSidebar({ sections: twoSections });
    await user.click(screen.getByRole('button', { name: 'Recording options' }));
    const trigger = screen.getByRole('menuitem', { name: 'Move to section' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await user.hover(trigger);
    const submenu = await screen.findByRole('menu', { name: 'Move to section' });
    // The recording's menu stays open beside it, its trigger expanded.
    expect(screen.getByRole('menu', { name: 'Recording actions' })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = within(submenu).getAllByRole('menuitem');
    expect(items.map(item => item.textContent)).toEqual(['Recents', 'Workspace', 'Home', 'New section…']);
    expect(within(submenu).getByRole('menuitem', { name: 'Workspace' })).toBeDisabled();
    // Pointing at another item closes it after a pause.
    await user.hover(screen.getByRole('menuitem', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Move to section' })).not.toBeInTheDocument());
  });
  test('moves a recording through the submenu with the keyboard', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn().mockResolvedValue(true);
    renderSidebar({ sections: twoSections, onMove });
    await user.click(screen.getByRole('button', { name: 'Recording options' }));
    const trigger = screen.getByRole('menuitem', { name: 'Move to section' });
    expect(trigger).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const submenu = screen.getByRole('menu', { name: 'Move to section' });
    expect(within(submenu).getByRole('menuitem', { name: 'Recents' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('menu', { name: 'Move to section' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}');
    // Workspace is the recording's own section and is skipped.
    expect(screen.getByRole('menuitem', { name: 'Home' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledWith('review', 'home');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Library review' })).toHaveFocus());
  });
  test('does not open the submenu when the pointer only crosses Move to section', async () => {
    const user = userEvent.setup();
    renderSidebar({ sections: twoSections });
    await user.click(screen.getByRole('button', { name: 'Recording options' }));
    await user.hover(screen.getByRole('menuitem', { name: 'Move to section' }));
    // Out of the menu within the 100ms pause.
    await user.unhover(screen.getByRole('menu', { name: 'Recording actions' }));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(screen.queryByRole('menu', { name: 'Move to section' })).not.toBeInTheDocument();
  });
  test('moves focus into a submenu the pointer already opened', async () => {
    const user = userEvent.setup();
    renderSidebar({ sections: twoSections });
    await user.click(screen.getByRole('button', { name: 'Recording options' }));
    const trigger = screen.getByRole('menuitem', { name: 'Move to section' });
    await user.hover(trigger);
    await screen.findByRole('menu', { name: 'Move to section' });
    trigger.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menuitem', { name: 'Recents' })).toHaveFocus();
    // Pointing at Rename closes it after a pause and gives focus back to Move to section.
    await user.hover(screen.getByRole('menuitem', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Move to section' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
  test('offers New section at the end of the submenu', async () => {
    const user = userEvent.setup();
    const onCreateSection = vi.fn();
    renderSidebar({ onCreateSection });
    await user.click(screen.getByRole('button', { name: 'Recording options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to section' }));
    await user.click(within(screen.getByRole('menu', { name: 'Move to section' })).getByRole('menuitem', { name: 'New section…' }));
    expect(onCreateSection).toHaveBeenCalledWith('review');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('making sections and sessions from the sidebar', () => {
  test('offers New section in a section\'s menu', async () => {
    const user = userEvent.setup();
    const onCreateSection = vi.fn();
    renderSidebar({ onCreateSection });
    await user.click(screen.getByRole('button', { name: 'Section options for Workspace' }));
    await user.click(within(screen.getByRole('menu', { name: 'Section actions' })).getByRole('menuitem', { name: 'New section…' }));
    expect(onCreateSection).toHaveBeenCalledWith();
  });
  test('shows a new-session button on a section heading', async () => {
    const user = userEvent.setup();
    const onNewInSection = vi.fn();
    renderSidebar({ onNewInSection });
    const add = screen.getByRole('button', { name: 'New session in Workspace' });
    // A collapsed section opens, so the new recording shows where it lands.
    await user.click(screen.getByRole('button', { name: 'Workspace' }));
    await user.click(add);
    expect(onNewInSection).toHaveBeenCalledWith('work');
    expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-expanded', 'true');
  });
  test('hides the new-session button while a search filters the sidebar', () => {
    const { rerender } = renderSidebar({ onNewInSection: vi.fn() });
    rerender({ filter: 'library' });
    expect(screen.getByRole('button', { name: 'Library review' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New session in Workspace' })).not.toBeInTheDocument();
  });
  test('hides the new-session button while recording', () => {
    const { rerender } = renderSidebar({ onNewInSection: vi.fn() });
    expect(screen.getByRole('button', { name: 'New session in Workspace' })).toBeInTheDocument();
    rerender({ locked: true });
    expect(screen.queryByRole('button', { name: 'New session in Workspace' })).not.toBeInTheDocument();
  });
});
