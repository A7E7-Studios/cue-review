import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Session, Transcript } from '../backend';
import { SearchDialog } from './SearchDialog';

const session = (id: string, name: string, createdAt: string, projectId: string | null = null): Session => ({ id, projectId, name, createdAt, durationMs: 134000, status: 'ready' });
const sessions = [
  session('library', 'Library selection and details', '2026-10-28T10:00:00Z', 'interface'),
  session('filters', 'Filter panel overlap', '2026-10-27T10:00:00Z', 'interface'),
  session('quest', 'Quest navigation', '2026-10-26T10:00:00Z'),
];
const transcripts = new Map<string, Transcript>([
  ['library', { segments: [{ startMs: 24000, endMs: 30000, text: 'Now if I open the filters, the panel covers the first row.', words: [] }] }],
  ['quest', { segments: [{ startMs: 5000, endMs: 9000, text: 'The menu follows the controller.', words: [] }] }],
]);
type Props = ComponentProps<typeof SearchDialog>;
function renderSearch(overrides: Partial<Props> = {}) {
  const props: Props = { open: true, onClose: vi.fn(), sessions, sections: [{ id: 'interface', name: 'Interface', createdAt: '2026-10-01' }], transcripts, onOpen: vi.fn(), ...overrides };
  return { ...render(<SearchDialog {...props}/>), props };
}

describe('SearchDialog', () => {
  it('opens with recent recordings and closes on Escape', async () => {
    const user = userEvent.setup();
    const { props } = renderSearch();
    const dialog = screen.getByRole('dialog', { name: 'Search' });
    const field = within(dialog).getByRole('combobox', { name: 'Search recordings' });
    expect(field).toHaveFocus();
    const options = within(dialog).getAllByRole('option');
    expect(options.map(option => option.querySelector('.search-result-title')?.textContent)).toEqual(['Library selection and details', 'Filter panel overlap', 'Quest navigation']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(field).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(options[0]).toHaveTextContent('Interface');
    await user.keyboard('{Escape}');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it('lists recordings and transcript lines', async () => {
    const user = userEvent.setup();
    const { props } = renderSearch();
    await user.type(screen.getByRole('combobox'), 'FILTER');
    const options = screen.getAllByRole('option');
    // A recording whose name matches, then the line that matches, with its time and the word marked.
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Filter panel overlap');
    // Each part is a labelled group of the listbox.
    expect(options[0].closest('[role=group]')).toHaveAccessibleName('Recordings');
    expect(options[1]).toHaveTextContent('Library selection and details');
    expect(options[1]).toHaveTextContent('0:24');
    expect(options[1].closest('[role=group]')).toHaveAccessibleName('In transcripts');
    expect([...options[1].querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['filter']);
    // Every word, in any order.
    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'panel filters');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    // ↓ and Enter open the line at its time.
    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'filter{ArrowDown}');
    await waitFor(() => expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
    await user.keyboard('{Enter}');
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onOpen).toHaveBeenCalledWith('library', 24000);
  });
  it('keeps the active result while transcripts arrive', async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderSearch();
    await user.type(screen.getByRole('combobox'), 'the{ArrowDown}');
    const active = () => screen.getAllByRole('option').find(option => option.getAttribute('aria-selected') === 'true');
    expect(active()).toHaveTextContent('The menu follows the controller.');
    // A newer recording's transcript arrives and its line is listed first.
    const more = new Map(transcripts).set('filters', { segments: [{ startMs: 1000, endMs: 2000, text: 'The filter chips wrap.', words: [] }] });
    rerender(<SearchDialog {...props} transcripts={more}/>);
    expect(active()).toHaveTextContent('The menu follows the controller.');
    await user.keyboard('{Enter}');
    expect(props.onOpen).toHaveBeenCalledWith('quest', 5000);
  });
  it('keeps the first result for Enter while a newer recording\'s lines arrive', async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderSearch();
    await user.type(screen.getByRole('combobox'), 'menu');
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('The menu follows the controller.');
    // A newer recording's line arrives ahead of it; Enter still opens the result that was first.
    const more = new Map(transcripts).set('library', { segments: [{ startMs: 2000, endMs: 3000, text: 'The menu is hidden.', words: [] }] });
    rerender(<SearchDialog {...props} transcripts={more}/>);
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('The menu is hidden.');
    await user.keyboard('{Enter}');
    expect(props.onOpen).toHaveBeenCalledWith('quest', 5000);
  });
  it('starts empty each time it opens', async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderSearch();
    await user.type(screen.getByRole('combobox'), 'zebra');
    rerender(<SearchDialog {...props} open={false}/>);
    rerender(<SearchDialog {...props} open/>);
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
  it('opens a recording from its start when its name is chosen', async () => {
    const user = userEvent.setup();
    const { props } = renderSearch();
    await user.type(screen.getByRole('combobox'), 'quest');
    await user.click(screen.getByRole('option', { name: /Quest navigation/ }));
    expect(props.onOpen).toHaveBeenCalledWith('quest', undefined);
  });
  it('says No matches', async () => {
    const user = userEvent.setup();
    renderSearch();
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();
    await user.type(screen.getByRole('combobox'), 'zebra');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(status).toHaveTextContent('No matches');
  });
});
