// Captures UI screenshots for visual review: node screens.mjs
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const base = process.env.BASE_URL ?? 'http://localhost:8080';
const out = (n) => `/e2e/screens/${n}.png`;
writeFileSync('/tmp/quarterly-report.pdf', Buffer.alloc(3_400_000, 7));
writeFileSync('/tmp/site-photos.zip', Buffer.alloc(48_000_000, 3));
writeFileSync('/tmp/notes.txt', 'hello');

const picker = () => {
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('p' + Math.random().toString(36).slice(2), { create: true });
    return {
      name: 'Downloads',
      getFileHandle: async (name, opts) => {
        const h = await dir.getFileHandle(name, opts);
        return { createWritable: async (o) => { const w = await h.createWritable(o); return { write: async (d) => { await new Promise((r) => setTimeout(r, window.__delay ?? 0)); return w.write(d); }, close: () => w.close(), abort: (r) => w.abort(r) }; } };
      },
      removeEntry: (n) => dir.removeEntry(n),
    };
  };
};

const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
for (const scheme of ['dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
  const sender = await ctx.newPage();
  await sender.goto(base);
  await sender.waitForTimeout(1800);
  await sender.screenshot({ path: out('1-sender-empty-light'), fullPage: true });
  await sender.locator('input[type=file]').setInputFiles(['/tmp/quarterly-report.pdf', '/tmp/site-photos.zip', '/tmp/notes.txt']);
  await sender.screenshot({ path: out(`2-sender-selected-${scheme}`), fullPage: true });
  await sender.getByRole('button', { name: 'Create sharing link' }).click();
  const url = await sender.locator('#share-url').inputValue();

  const mk = async (name, delay, mobile) => {
    const c = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 900, height: 900 }, colorScheme: scheme, deviceScaleFactor: mobile ? 2 : 1 });
    await c.addInitScript(picker);
    const p = await c.newPage();
    await p.goto(url);
    await p.waitForTimeout(1800);
    if (name) await p.getByLabel('Your name (optional)').fill(name);
    await p.getByRole('button', { name: 'Connect to sender' }).click();
    await p.evaluate((d) => (window.__delay = d), delay);
    return p;
  };
  const done = await mk('Maria’s laptop', 0);
  const slow = await mk('Studio iMac', 12, true);
  const pending = await mk('', 0);
  await pending.screenshot({ path: out('3-receiver-waiting-light'), fullPage: true });
  await sender.getByRole('button', { name: 'Approve Maria’s laptop' }).click();
  await sender.getByRole('button', { name: 'Approve Studio iMac' }).click();
  await slow.getByRole('button', { name: 'Choose folder and accept' }).waitFor();
  await slow.screenshot({ path: out(`4-receiver-review-mobile-${scheme}`), fullPage: true });
  await done.getByRole('button', { name: 'Choose folder and accept' }).click();
  await done.getByText('All files received').waitFor();
  await done.screenshot({ path: out(`5-receiver-done-${scheme}`), fullPage: true });
  await slow.getByRole('button', { name: 'Choose folder and accept' }).click();
  await sender.waitForTimeout(2500);
  await slow.screenshot({ path: out(`6-receiver-progress-mobile-${scheme}`), fullPage: true });
  await sender.screenshot({ path: out(`7-sender-sharing-${scheme}`), fullPage: true });
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
  await ctx.close();
  await m.close();
}
await browser.close();
console.log('screens done');
