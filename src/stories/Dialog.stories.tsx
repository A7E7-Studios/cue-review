import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Dialog } from '../ui/Dialog';

type Props = { busy: boolean; error: boolean; destructive: boolean; initiallyOpen: boolean };
function DialogExample({ busy, error, destructive, initiallyOpen }: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  const [value, setValue] = useState('Library selection and details');
  const [saved, setSaved] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  return <div className="workshop-dialog-launcher">
    <button ref={launcher} className="primary" onClick={() => { setSaved(false); setOpen(true); }}>Open dialog</button>
    <p>Open and close this real application dialog to compare motion and focus behavior. Use Tab, Shift+Tab and Escape.</p>
    {saved && <p role="status">Sample changes saved.</p>}
    <Dialog open={open} onClose={() => setOpen(false)} busy={busy} title={destructive ? 'Delete recording?' : 'Recording name'} role={destructive ? 'alertdialog' : 'dialog'}
      description={destructive ? <>Permanently delete <strong>Library selection and details</strong> and all its files? This cannot be undone.</> : undefined}
      restoreFocusRef={launcher} initialFocusRef={destructive ? cancel : input} closeLabel="Close dialog"
      onSubmit={destructive ? undefined : event => { event.preventDefault(); if (!busy) { setSaved(true); setOpen(false); } }}>
      {!destructive && <label className="workshop-dialog-label">Name<input ref={input} value={value} disabled={busy} onChange={event => setValue(event.target.value)}/></label>}
      {error && <p className="dialog-error" role="alert">The recording could not be updated. Its original files are unchanged.</p>}
      <div className="dialog-actions"><button ref={cancel} type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button className={destructive ? 'danger-button' : 'primary'} disabled={busy} type={destructive ? 'button' : 'submit'} onClick={destructive ? () => setOpen(false) : undefined}>{busy ? 'Saving…' : destructive ? 'Delete recording' : 'Save'}</button></div>
    </Dialog>
  </div>;
}
const meta = {
  title: 'Dialog/Editing', component: DialogExample,
  args: { busy: false, error: false, destructive: false, initiallyOpen: true },
  render: args => <DialogExample key={`${args.initiallyOpen}-${args.destructive}`} {...args}/>,
} satisfies Meta<typeof DialogExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Rename: Story = {};
export const Busy: Story = { args: { busy: true } };
export const Error: Story = { args: { error: true } };
export const DeleteRecording: Story = { args: { destructive: true } };
export const OpenCloseMotion: Story = { args: { initiallyOpen: false } };
export const KeyboardFocus: Story = {
  args: { initiallyOpen: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole('button', { name: 'Open dialog' });
    await userEvent.click(trigger);
    await waitFor(() => expect(page.getByRole('textbox', { name: 'Name' })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(trigger).toHaveFocus();
  },
};
