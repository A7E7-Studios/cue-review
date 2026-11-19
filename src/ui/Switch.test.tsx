import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch';

// Read the stylesheet itself (Vitest turns CSS imports into empty modules). The project has no Node types, hence the cast.
const fs = 'node:fs';
const { readFileSync } = await import(/* @vite-ignore */ fs) as { readFileSync: (path: string, encoding: 'utf8') => string };
const css = readFileSync('src/ui/Switch.css', 'utf8');
const rule = (selector: string) => new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*{([^}]*)}`).exec(css)?.[1] ?? '';

function Harness({ initial = false, disabled = false, onChange = vi.fn() }: { initial?: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(initial);
  return <Switch label="Use the graphics card" help="Turn it off if a game stutters." checked={checked} disabled={disabled}
    onChange={next => { onChange(next); setChecked(next); }}/>;
}

describe('Switch', () => {
  it('is a switch named by its label and described by its help', () => {
    render(<Harness initial/>);
    const toggle = screen.getByRole('switch', { name: 'Use the graphics card' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAccessibleDescription('Turn it off if a game stutters.');
    expect(toggle).toHaveAttribute('type', 'button');
  });

  it('toggles with a click, Space, Enter and its label', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange}/>);
    const toggle = screen.getByRole('switch', { name: 'Use the graphics card' });
    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByText('Use the graphics card'));
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('ignores every input while disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness disabled onChange={onChange}/>);
    const toggle = screen.getByRole('switch', { name: 'Use the graphics card' });
    expect(toggle).toBeDisabled();
    await user.click(toggle);
    await user.click(screen.getByText('Use the graphics card'));
    await user.tab();
    expect(toggle).not.toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('draws a 36×20 track with a 16px thumb, the accent when on, and the focus ring of the other controls', () => {
    expect(rule('.ui-switch')).toMatch(/width:\s*36px;[\s\S]*height:\s*20px/);
    expect(rule('.ui-switch-thumb')).toMatch(/width:\s*16px;[\s\S]*height:\s*16px/);
    expect(css).toMatch(/\.ui-switch\[aria-checked='true'\][^{]*{[^}]*background:\s*var\(--color-accent\)/);
    expect(rule(".ui-switch[aria-checked='true'] .ui-switch-thumb")).toMatch(/translateX\(16px\)/);
    expect(rule('.ui-switch:focus-visible')).toMatch(/outline:\s*2px solid var\(--color-focus\);\s*outline-offset:\s*2px/);
    // Its motion runs on the motion tokens, which reduced motion sets to 0.
    for (const selector of ['.ui-switch', '.ui-switch-thumb']) expect(rule(selector)).toMatch(/transition:[^;]*var\(--motion-fast\)/);
  });
});
