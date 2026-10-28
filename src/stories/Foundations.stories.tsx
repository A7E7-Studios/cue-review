import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from '../icons';

function Foundations() {
  const colors = ['bg', 'side', 'surface', 'hover', 'active', 'line', 'text', 'muted', 'faint', 'accent', 'red'];
  return <main className="workshop-page">
    <h1>Small, deliberate controls</h1>
    <p>The application’s actual CSS tokens, type and controls. Use the toolbar to compare themes, motion preferences and window sizes.</p>
    <section className="workshop-section"><h2>Semantic colors</h2><div className="workshop-row">{colors.map(color => <div key={color} className="workshop-swatch"><span style={{ background: `var(--${color})` }}/><code>--{color}</code></div>)}</div></section>
    <section className="workshop-section"><h2>Actions</h2><div className="workshop-row">
      <button>Cancel</button><button className="primary">Save</button><button className="primary" disabled>Saving…</button><button className="danger-button">Delete recording</button><button aria-label="Settings" title="Settings"><Icon name="settings"/></button><button disabled aria-label="Unavailable action"><Icon name="refresh"/></button>
    </div></section>
    <section className="workshop-section"><h2>Recording controls</h2><div className="workshop-row">
      <button className="capture-setting"><Icon name="monitor"/><span>Display 1</span><Icon name="chevron"/></button>
      <button className="capture-setting"><Icon name="mic"/><span>Studio microphone</span></button>
      <button className="record-button" style={{ marginLeft: 0 }}><span className="record-dot"/>Record</button>
      <button className="record-button is-recording" style={{ marginLeft: 0 }}><span className="record-dot"/>Stop</button>
    </div></section>
    <section className="workshop-section"><h2>Hierarchy</h2><div className="session-heading"><div className="title-row"><h1>Library selection and details</h1></div><div className="meta">Interface <span>·</span> Oct 28 <span>·</span> 2:14</div></div><p style={{ marginTop: 12 }}>Body text remains readable at a compact desktop density.</p><p className="option-note">Secondary information uses the application’s subdued text token.</p></section>
    <section className="workshop-section"><h2>Selection states</h2><div style={{ maxWidth: 300 }}><button className="option-button selected" aria-pressed="true"><span>Display 1<small>2560 × 1440</small></span><Icon name="check"/></button><button className="option-button"><span>Quest 3</span></button><button className="option-button" disabled><span>Studio camera<small>Unavailable</small></span></button></div></section>
  </main>;
}
const meta = { title: 'Foundations/Overview', component: Foundations } satisfies Meta<typeof Foundations>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
