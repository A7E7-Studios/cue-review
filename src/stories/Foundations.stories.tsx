import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from '../icons';
import '../workspace/workspace.css';

// The Float v2 roles from src/ui/tokens.css and the shared controls, as the app renders them.
const surfaces = ['ground', 'sheet', 'sheet-edge', 'divider', 'panel', 'pill', 'row-hover', 'row-selected', 'current-row', 'dock'];
const text = ['text', 'text-secondary', 'text-tertiary', 'transcript', 'accent', 'accent-text', 'record', 'stop', 'status-recording-text'];
const type = [
  { label: 'Title · 18/700', style: { fontSize: 'var(--font-size-title)', fontWeight: 'var(--font-weight-title)', lineHeight: 'var(--line-height-title)' } },
  { label: 'Pane title · 14/700', style: { fontSize: 'var(--font-size-pane-title)', fontWeight: 700 } },
  { label: 'Transcript · 14/1.55', style: { fontSize: 'var(--font-size-transcript)', lineHeight: 'var(--line-height-transcript)', color: 'var(--color-transcript)' } },
  { label: 'Body · 13.5', style: { fontSize: 'var(--font-size-body)' } },
  { label: 'Control · 12.5/600', style: { fontSize: 'var(--font-size-control)', fontWeight: 'var(--font-weight-strong)' } },
  { label: 'Meta · 12', style: { fontSize: 'var(--font-size-meta)', color: 'var(--color-text-tertiary)' } },
];

function Swatches({ title, roles }: { title: string; roles: string[] }) {
  return <section className="workshop-section"><h2>{title}</h2><div className="workshop-row">{roles.map(role => <div key={role} className="workshop-swatch" style={{ width: 220 }}>
    <span style={{ background: `var(--color-${role})` }}/><code>--color-{role}</code>
  </div>)}</div></section>;
}

function Foundations() {
  return <main className="workshop-page" style={{ background: 'var(--color-sheet)', color: 'var(--color-text)', minHeight: '100vh' }}>
    <h1>Float v2 foundations</h1>
    <p>The application’s tokens, type and controls. Use the toolbar to compare themes, motion preferences and window sizes.</p>
    <Swatches title="Surfaces" roles={surfaces}/>
    <Swatches title="Text and accents" roles={text}/>
    <section className="workshop-section"><h2>Type</h2>{type.map(item => <p key={item.label} style={{ ...item.style, margin: '0 0 8px' }}>{item.label}</p>)}</section>
    <section className="workshop-section"><h2>Pills and buttons</h2><div className="workshop-row">
      <button type="button" className="cr-btn cr-accent-pill"><Icon name="agent" strokeWidth={1.9}/>Copy for agent</button>
      <button type="button" className="cr-btn cr-accent-pill" disabled><Icon name="agent" strokeWidth={1.9}/>Copy for agent</button>
      <button type="button" className="cr-btn cr-dark-pill"><span className="cr-record-dot" aria-hidden="true"/>Record more</button>
      <button type="button" className="cr-btn cr-dark-pill" disabled><span className="cr-record-dot" aria-hidden="true"/>Record more</button>
      <button type="button" className="cr-btn cr-pill"><Icon name="refresh" strokeWidth={1.8}/>Retry transcription</button>
      <button type="button" className="cr-btn cr-speed">1×</button>
      <button type="button" className="cr-btn cr-round-button" aria-label="Open recording folder"><Icon name="folder" strokeWidth={1.7}/></button>
      <button type="button" className="cr-btn cr-round-button cr-ghost" aria-label="Focus video"><Icon name="expand" strokeWidth={1.8}/></button>
      <button type="button" className="cr-btn cr-play" data-playing="false" aria-label="Play"><Icon name="play" filled/></button>
    </div></section>
    <section className="workshop-section"><h2>Capture</h2><div className="workshop-row">
      <button type="button" className="cr-btn cr-capture-trigger"><Icon name="monitor" strokeWidth={1.7}/><span>Display 1</span><Icon name="chevron" strokeWidth={2}/></button>
      <button type="button" className="cr-btn cr-capture-trigger"><Icon name="mic" strokeWidth={1.7}/><span>Studio microphone</span><Icon name="chevron" strokeWidth={2}/></button>
      <button type="button" className="cr-btn cr-dark-pill cr-record"><span className="cr-record-dot" aria-hidden="true"/>Record</button>
      <button type="button" className="cr-btn cr-stop"><span className="cr-stop-square" aria-hidden="true"/>Stop</button>
    </div></section>
    <section className="workshop-section"><h2>Dialog actions</h2><div className="workshop-row">
      <button type="button" className="dialog-button">Cancel</button>
      <button type="button" className="dialog-button primary">Save</button>
      <button type="button" className="dialog-button primary" disabled>Saving…</button>
      <button type="button" className="dialog-button danger-button">Delete recording</button>
    </div></section>
    <section className="workshop-section"><h2>Notices</h2><div style={{ maxWidth: 560, display: 'grid', gap: 8 }}>
      <div className="app-error" role="alert" style={{ marginTop: 0 }}><Icon name="warning" strokeWidth={1.8}/><p>USB device disconnected. Reconnect Quest and try again.</p><button type="button" aria-label="Dismiss error"><Icon name="close" strokeWidth={1.8}/></button></div>
      <div className="app-setup" style={{ marginTop: 0 }}><span>Transcription needs setup.</span><button type="button">Review setup<Icon name="arrow" strokeWidth={1.8}/></button></div>
    </div></section>
  </main>;
}
const meta = { title: 'Foundations/Overview', component: Foundations } satisfies Meta<typeof Foundations>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const Dark: Story = { globals: { theme: 'dark' } };
