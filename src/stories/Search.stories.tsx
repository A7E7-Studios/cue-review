import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { Session, Transcript } from '../backend';
import { SearchDialog } from '../search/SearchDialog';
import { sections, sessions, transcript } from './fixtures';

// The search window (search spec) over the workshop's recordings. Choosing a result only reports it.

const transcripts = new Map<string, Transcript>(sessions.map((session: Session) => [session.id, transcript]));

function SearchExample() {
  const [open, setOpen] = useState(true);
  const [message, setMessage] = useState('Type to search names and transcript lines.');
  return <div style={{ minHeight: 640, padding: 24, background: 'var(--color-sheet)', color: 'var(--color-text)' }}>
    <button type="button" onClick={() => setOpen(true)}>Open search</button>
    <p style={{ color: 'var(--color-text-secondary)' }}>{message}</p>
    <SearchDialog open={open} onClose={() => setOpen(false)} sessions={sessions} sections={sections} transcripts={transcripts}
      onOpen={(id, atMs) => setMessage(`Open ${id}${atMs === undefined ? '' : ` at ${atMs} ms`}.`)}/>
  </div>;
}

/** The window is a portal on the page's body, outside the story's canvas. */
async function typeQuery(canvasElement: HTMLElement, query: string) {
  const field = await within(canvasElement.ownerDocument.body).findByRole('combobox', { name: 'Search recordings' });
  if (query) await userEvent.type(field, query);
}

const meta = {
  title: 'Workspace/Search', component: SearchExample,
} satisfies Meta<typeof SearchExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Recent: Story = { play: ({ canvasElement }) => typeQuery(canvasElement, '') };
export const RecentDark: Story = { ...Recent, globals: { theme: 'dark' } };
export const Results: Story = {
  play: async ({ canvasElement }) => {
    await typeQuery(canvasElement, 'grid');
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getAllByRole('option').length).toBeGreaterThan(0));
  },
};
export const ResultsDark: Story = { ...Results, globals: { theme: 'dark' } };
export const ResultsReducedMotion: Story = { ...Results, globals: { motion: 'reduced' } };
export const NoMatches: Story = {
  play: async ({ canvasElement }) => {
    await typeQuery(canvasElement, 'zebra');
    await expect(within(canvasElement.ownerDocument.body).getByRole('status')).toHaveTextContent('No matches');
  },
};
