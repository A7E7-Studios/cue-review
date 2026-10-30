// Browser-only Storybook fixtures: no app data, capture, microphone or device access.
// Start npm run storybook first. Requires: npx playwright install chromium webkit
const { chromium, webkit } = require('playwright');
const { expect } = require('playwright/test');

const base = process.env.CUEREVIEW_STORYBOOK_URL || 'http://127.0.0.1:6006';
const stories = [
  { name: 'draft', id: 'workspace-scenarios--mac-fresh', record: 'Record' },
  { name: 'review', id: 'workspace-scenarios--mac-review-takes', record: 'Record more' },
];
let failures = 0;

async function verify(page, story, browserName) {
  page.setDefaultTimeout(15000);
  await page.goto(`${base}/iframe.html?id=${story.id}&viewMode=story`);
  const bar = page.getByRole('group', { name: 'Recording bar', exact: true });
  await expect(bar.getByRole('button', { name: story.record, exact: true })).toBeEnabled();
  const source = bar.getByRole('button', { name: 'Display 1', exact: true }).and(page.locator('[aria-expanded]'));
  const microphone = bar.getByRole('button', { name: 'Studio microphone', exact: true }).and(page.locator('[aria-expanded]'));
  const pickers = [
    { name: 'source', trigger: source, group: 'Capture sources' },
    { name: 'microphone', trigger: microphone, group: 'Microphone options' },
  ];
  // Safari on macOS uses Option+Tab to include buttons when full keyboard access is off.
  const tab = browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
  // Record the real event order if a browser regresses. userEvent.click calls focus itself,
  // which hides WebKit's default focus transfer from an option to the workspace ancestor.
  await page.evaluate(() => {
    window.pickerToggleEvents = [];
    const describe = node => node instanceof Element
      ? `${node.tagName.toLowerCase()}.${node.className}` : null;
    for (const type of ['pointerdown', 'mousedown', 'focusout', 'focusin', 'click']) {
      document.addEventListener(type, event => {
        window.pickerToggleEvents.push({ type, target: describe(event.target), related: describe(event.relatedTarget) });
      }, true);
    }
  });
  const check = async (name, action) => {
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.pickerToggleEvents = []; });
    try {
      await action();
      console.log(`PASS ${browserName} ${story.name}: ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${browserName} ${story.name}: ${name}\n${error.message}`);
      console.error(JSON.stringify(await page.evaluate(() => window.pickerToggleEvents), null, 2));
    }
  };

  for (const picker of pickers) {
    const options = page.getByRole('group', { name: picker.group, exact: true });
    await check(`${picker.name} closes on its second click`, async () => {
      await picker.trigger.click();
      await expect(picker.trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(options.getByRole('button', { pressed: true })).toBeFocused();
      await picker.trigger.click();
      await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(options).toHaveCount(0);
      await expect(picker.trigger).toBeFocused();
    });
    await check(`${picker.name} closes on Escape, Tab and outside click`, async () => {
      await picker.trigger.click();
      await page.keyboard.press('Escape');
      await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(picker.trigger).toBeFocused();
      await picker.trigger.click();
      await expect(options.getByRole('button', { pressed: true })).toBeFocused();
      // The first Tab reaches the check box inside the picker; the second leaves its field.
      await page.keyboard.press(tab);
      await expect(picker.trigger).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press(tab);
      await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(() => picker.trigger.evaluate(trigger => document.activeElement instanceof HTMLButtonElement
        && !trigger.parentElement.contains(document.activeElement))).toBe(true);
      await picker.trigger.click();
      await page.getByRole('heading', { level: 1 }).click();
      await expect(picker.trigger).toHaveAttribute('aria-expanded', 'false');
    });
  }
  await check('switching triggers opens only the other picker', async () => {
    await source.click();
    await microphone.click();
    await expect(source).toHaveAttribute('aria-expanded', 'false');
    await expect(microphone).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('group', { name: 'Microphone options', exact: true }).getByRole('button', { pressed: true })).toBeFocused();
    await source.click();
    await expect(microphone).toHaveAttribute('aria-expanded', 'false');
    await expect(source).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(source).toBeFocused();
  });
  await check('arrow keys and typeahead still move through source options', async () => {
    await source.click();
    const options = page.getByRole('group', { name: 'Capture sources', exact: true });
    await page.keyboard.press('ArrowDown');
    await expect(options.getByRole('button', { name: 'Design review — Figma', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(options.getByRole('button', { name: 'Studio camera with a very long device name · unavailable', exact: true })).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('q');
    await expect(options.getByRole('button', { name: 'Quest 3', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(source).toBeFocused();
  });
}

(async () => {
  for (const [browserName, engine] of [['webkit', webkit], ['chromium', chromium]]) {
    const browser = await engine.launch();
    try {
      for (const story of stories) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
        try { await verify(page, story, browserName); }
        finally { await page.close(); }
      }
    } finally { await browser.close(); }
  }
  if (failures) throw new Error(`${failures} picker checks failed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
