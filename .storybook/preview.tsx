import type { Preview } from '@storybook/react-vite';
import '../src/styles.css';
import '../src/Sidebar.css';
import '../src/ui/polish.css';
import '../src/stories/workshop.css';

const preview: Preview = {
  globalTypes: {
    theme: { description: 'Application appearance', toolbar: { icon: 'paintbrush', items: ['light', 'dark'], dynamicTitle: true } },
    motion: { description: 'Motion preference', toolbar: { icon: 'play', items: [{ value: 'system', title: 'System motion' }, { value: 'full', title: 'Full motion' }, { value: 'reduced', title: 'Reduced motion' }], dynamicTitle: true } },
  },
  initialGlobals: { theme: 'light', motion: 'system' },
  parameters: {
    layout: 'fullscreen',
    options: { storySort: { order: ['Foundations', 'Workspace', 'Sidebar', 'Dialog'] } },
    controls: { expanded: true },
    viewport: { options: {
      desktop: { name: 'Desktop · 1280 × 820', styles: { width: '1280px', height: '820px' } },
      small: { name: 'Small window · 900 × 650', styles: { width: '900px', height: '650px' } },
      compact: { name: 'Compact recorder · 520 × 320', styles: { width: '520px', height: '320px' } },
    } },
    a11y: { test: 'todo' },
  },
  decorators: [(Story, context) => {
    const theme = context.globals.theme as string;
    const motion = context.globals.motion as string;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cuereview.theme', theme);
    if (motion === 'system') delete document.documentElement.dataset.motion;
    else document.documentElement.dataset.motion = motion;
    return <div key={`${context.id}-${theme}-${motion}`} className="workshop-root"><Story /></div>;
  }],
  beforeEach() {
    const previous = localStorage.getItem('cuereview.closedSections');
    localStorage.removeItem('cuereview.closedSections');
    return () => {
      if (previous === null) localStorage.removeItem('cuereview.closedSections');
      else localStorage.setItem('cuereview.closedSections', previous);
    };
  },
};
export default preview;
