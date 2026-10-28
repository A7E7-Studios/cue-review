import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';
import type { Session } from './backend';

const session: Session = { id: 'review', projectId: 'work', name: 'Library review', createdAt: '2026-01-01', durationMs: 30000, status: 'ready' };
function renderSidebar() {
  const onRename = vi.fn();
  render(<Sidebar sections={[{id:'work',name:'Workspace',createdAt:'2026-01-01'}]} sessions={[session]} activeId={session.id} locked={false} loading={false} utilities={<button>Settings</button>} onCollapse={vi.fn()} onNew={vi.fn()} onOpen={vi.fn()} onRename={onRename} onRenameSection={vi.fn()} onCreateSection={vi.fn()} onDeleteSection={vi.fn()} onDeleteSession={vi.fn()} onReorder={vi.fn().mockResolvedValue(true)} onMove={vi.fn().mockResolvedValue(true)}/>);
  return {onRename};
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
  expect(screen.getByRole('button', {name:'New section'})).toHaveFocus();
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

