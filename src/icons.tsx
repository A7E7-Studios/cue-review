import type { CSSProperties } from 'react';
// 24×24 stroke paths. Names shared with the Float v2 mocks (docs/design/float-v2, `ic`) use the mock's path.
const paths = {
  // Float v2 mocks
  panel: 'M3 4.5h18v15H3zM9 4.5v15',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.8-4.8',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  close: 'm5 5 14 14M19 5 5 19',
  folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10.5v5M9.5 13h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  agent: 'M4 5h16v14H4zM8 10l3 2-3 2M13 14h3',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  mic: 'M12 3.5a3 3 0 0 0-3 3V12a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
  compact: 'M3 5h18v14H3zM12.5 12h6v4.5h-6z',
  // Drawn filled in the mocks: pass `filled`.
  play: 'M8 5.6v12.8a1 1 0 0 0 1.53.85l10.2-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  // A companion the mocks imply: the muted microphone.
  micOff: 'M12 3.5a3 3 0 0 0-3 3V12a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M4 4l16 16',
  // Earlier icons
  plus: 'M12 5v14M5 12h14', chevron: 'm8 5 7 7-7 7', pause: 'M8 5v14M16 5v14',
  edit: 'm16 3 5 5-12 12-6 1 1-6zM14 5l5 5', arrow: 'M7 17 17 7M7 7h10v10', check: 'm4 12 5 5L20 6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2',
  moon: 'M20 14A9 9 0 0 1 10 4a9 9 0 1 0 10 10z', marker: 'M6 3h12v18l-6-4-6 4z',
  more: 'M4 12h1M11 12h1M18 12h1', volume: 'M4 9h4l5-5v16l-5-5H4zM17 8a6 6 0 0 1 0 8',
  refresh: 'M20 7v6h-6M20 12a8 8 0 1 0-2 6',
  settings: 'M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1zM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  warning: 'm12 3 10 18H2zM12 9v5M12 17v1',
} satisfies Record<string, string>;
export type IconName = keyof typeof paths;
export const iconNames = Object.keys(paths) as IconName[];

type IconProps = {
  /** Unknown names render `more`. */
  name: IconName | (string & {});
  style?: CSSProperties;
  className?: string;
  /** Width and height in px. Without it the icon takes its size from CSS. */
  size?: number;
  strokeWidth?: number;
  /** Fill the shape instead of stroking it, like the mocks' play button. */
  filled?: boolean;
};
export function Icon({name,style,className,size,strokeWidth=1.6,filled=false}: IconProps) {
  const d = (paths as Record<string, string>)[name] || paths.more;
  return <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill={filled?'currentColor':'none'} stroke={filled?'none':'currentColor'} strokeWidth={filled?undefined:strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={d}/></svg>;
}
