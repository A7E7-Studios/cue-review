import { useId } from 'react';
import './Switch.css';

export interface SwitchProps {
  /** The visible label, which names the switch. */
  label: string;
  /** One line of help under the label, which describes the switch. */
  help?: string;
  checked: boolean;
  /** Called with the new state when the switch is clicked, or pressed with Space or Enter, or its label is clicked. */
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * An on/off switch for a choice that takes effect at once: the label and one line of help on the
 * left, a 36×20 track with a 16px thumb on the right, `--color-accent` when on. A native button
 * with `role="switch"` and `aria-checked`, so Space, Enter and the label all toggle it.
 */
export function Switch({ label, help, checked, onChange, disabled = false, className }: SwitchProps) {
  const id = useId();
  return <div className={className ? `ui-switch-row ${className}` : 'ui-switch-row'} data-disabled={disabled || undefined}>
    <span className="ui-switch-text">
      <label id={`${id}-label`} htmlFor={id} className="ui-switch-label">{label}</label>
      {help && <span id={`${id}-help`} className="ui-switch-help">{help}</span>}
    </span>
    <button id={id} type="button" role="switch" className="ui-switch" aria-checked={checked}
      aria-labelledby={`${id}-label`} aria-describedby={help ? `${id}-help` : undefined}
      disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="ui-switch-thumb" aria-hidden="true"/>
    </button>
  </div>;
}
