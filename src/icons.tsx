import type { CSSProperties } from 'react';
const paths: Record<string, string> = {
  panel:'M8 3v18M3 3h18v18H3z', plus:'M12 5v14M5 12h14', chevron:'m8 5 7 7-7 7',
  play:'m8 4 12 8-12 8z', pause:'M8 5v14M16 5v14', monitor:'M3 4h18v13H3zM8 21h8M12 17v4',
  mic:'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
  folder:'M3 6h7l2 3h9v12H3z', arrow:'M7 17 17 7M7 7h10v10', check:'m4 12 5 5L20 6',
  close:'m6 6 12 12M6 18 18 6', sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2',
  moon:'M20 14A9 9 0 0 1 10 4a9 9 0 1 0 10 10z', marker:'M6 3h12v18l-6-4-6 4z',
  more:'M4 12h1M11 12h1M18 12h1', volume:'M4 9h4l5-5v16l-5-5H4zM17 8a6 6 0 0 1 0 8',
  expand:'M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6', refresh:'M20 7v6h-6M20 12a8 8 0 1 0-2 6',
  settings:'M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1zM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  compact:'M3 4h18v16H3zM13 12h6v6h-6z', warning:'m12 3 10 18H2zM12 9v5M12 17v1',
};
export function Icon({name,style}: {name:string;style?:CSSProperties}) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name] || paths.more}/></svg>;
}
