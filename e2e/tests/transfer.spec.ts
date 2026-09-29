/**
 * End-to-end tests in real (headless) Chromium: sender and receivers are
 * separate browser contexts talking through the real signaling server and
 * real WebRTC DataChannels.
 *
 * "Save to a folder" is exercised by replacing showDirectoryPicker with a
 * handle backed by the Origin Private File System, which supports the same
 * streaming createWritable() API as a user-picked folder. The native picker
 * dialog itself cannot be automated.
 */
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

const TMP = '/tmp/directsend-e2e';
mkdirSync(TMP, { recursive: true });

interface TestFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
}

function makeFile(name: string, size: number): TestFile {
  const path = join(TMP, name);
  const fd = openSync(path, 'w');
  const hash = createHash('sha256');
  const block = 4 * 1024 * 1024;
  for (let written = 0; written < size; ) {
    const n = Math.min(block, size - written);
    const buf = randomBytes(n);
    writeSync(fd, buf);
    hash.update(buf);
    written += n;
  }
  closeSync(fd);
  return { path, name, size, sha256: hash.digest('hex') };
}

/** Streams to OPFS through the same API a user-picked folder offers. Optional write delay simulates slow disks. */
const STREAMING_PICKER = () => {
  const w = window as unknown as Record<string, unknown>;
  w.__writeDelayMs = 0;
  w.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`picked-${Date.now()}-${Math.random().toString(36).slice(2)}`, { create: true });
    w.__pickedDir = dir;
    return {
      name: 'Test folder',
      getFileHandle: async (name: string, opts?: FileSystemGetFileOptions) => {
        const handle = await dir.getFileHandle(name, opts);
        return {
          createWritable: async (o?: FileSystemCreateWritableOptions) => {
            const writable = await handle.createWritable(o);
            return {
              write: async (data: BufferSource) => {
                const delay = w.__writeDelayMs as number;
                if (delay) await new Promise((r) => setTimeout(r, delay));
                return writable.write(data);
              },
              close: () => writable.close(),
              abort: (reason?: unknown) => writable.abort(reason),
            };
          },
        };
      },
      removeEntry: (name: string) => dir.removeEntry(name),
    };
  };
};

/** A browser without the File System Access API (e.g. Firefox, Safari, most mobile browsers). */
const NO_FILESYSTEM_API = () => {
  const w = window as unknown as Record<string, unknown>;
  w.showDirectoryPicker = undefined;
  w.showSaveFilePicker = undefined;
};

/**
 * Folder handle whose files checksum and discard their bytes. Used to measure
 * DirectSend's own memory use: incognito test contexts keep OPFS data in
 * memory with a small quota, which would distort the measurement.
 */
const CHECKSUM_PICKER = () => {
  const w = window as unknown as Record<string, unknown>;
  const results: Record<string, { size: number; fnv: number; closed: boolean }> = {};
  w.__checksums = results;
  w.showDirectoryPicker = async () => ({
    name: 'Checksum sink',
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      if (!opts?.create && !(name in results)) throw new DOMException('not found', 'NotFoundError');
      return {
        createWritable: async () => {
          const state = (results[name] = { size: 0, fnv: 0x811c9dc5, closed: false });
          return {
            write: async (data: Uint8Array) => {
              let h = state.fnv;
              for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i]!, 0x01000193) >>> 0;
              state.fnv = h;
              state.size += data.byteLength;
            },
            close: async () => {
              state.closed = true;
            },
            abort: async () => undefined,
          };
        },
      };
    },
    removeEntry: async () => undefined,
  });
};

function fnv1a(path: string): number {
  const buf = readFileSync(path);
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i]!, 0x01000193) >>> 0;
  return h;
}

async function newPage(browser: Browser, init?: () => void): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ acceptDownloads: true });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  return { context, page };
}

async function startSharing(page: Page, files: TestFile[]): Promise<string> {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles(files.map((f) => f.path));
  await expect(page.getByRole('list', { name: 'Selected files' }).getByRole('listitem')).toHaveCount(files.length);
  await page.getByRole('button', { name: 'Create sharing link' }).click();
  const input = page.locator('#share-url');
  await expect(input).toHaveValue(/\/join#[A-Za-z0-9_-]{22}$/);
  await expect(page.getByRole('img', { name: 'QR code for the sharing link' })).toBeVisible();
  return input.inputValue();
}

async function joinShare(page: Page, url: string, name?: string): Promise<void> {
  await page.goto(url);
  if (name) await page.getByLabel('Your name (optional)').fill(name);
  await page.getByRole('button', { name: 'Connect to sender' }).click();
  await expect(page.getByText('Waiting for the sender to approve you')).toBeVisible();
}

function receiverCard(sender: Page, name: string) {
  return sender.locator('li.receiver', { hasText: name });
}

async function opfsFile(page: Page, name: string, full = true): Promise<{ size: number; sha256?: string; head?: string; tail?: string }> {
  return page.evaluate(
    async ({ name, full }) => {
      const dir = (window as unknown as { __pickedDir: FileSystemDirectoryHandle }).__pickedDir;
      const file = await (await dir.getFileHandle(name)).getFile();
      const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      const digest = async (blob: Blob) => hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      if (full) return { size: file.size, sha256: await digest(file) };
      const mb = 1024 * 1024;
      return { size: file.size, head: await digest(file.slice(0, mb)), tail: await digest(file.slice(file.size - mb)) };
    },
    { name, full },
  );
}

async function opfsNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const dir = (window as unknown as { __pickedDir: FileSystemDirectoryHandle & { keys(): AsyncIterable<string> } }).__pickedDir;
    const names: string[] = [];
    for await (const key of dir.keys()) names.push(key);
    return names.sort();
  });
}

async function serverStats(page: Page): Promise<{ bytesIn: number; bytesRelayed: number; messagesIn: number }> {
  const res = await page.request.get('/api/stats');
  return res.json();
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------------------

test('multiple receivers download independently; only confirmed saves count as successful; server never sees file bytes', async ({ browser }) => {
  const files = [makeFile('photo-archive.bin', 5 * 1024 * 1024 + 123), makeFile('notes.txt', 20_000)];
  const sender = await newPage(browser);
  const url = await startSharing(sender.page, files);
  const before = await serverStats(sender.page);

  const streamer = await newPage(browser, STREAMING_PICKER);
  const memory = await newPage(browser);
  await joinShare(streamer.page, url, 'Stream Receiver');
  await joinShare(memory.page, url, 'Memory Receiver');

  // Nothing is offered before approval.
  await expect(streamer.page.getByRole('list', { name: 'Offered files' })).toHaveCount(0);
  await expect(receiverCard(sender.page, 'Stream Receiver')).toContainText('Awaiting approval');

  await sender.page.getByRole('button', { name: 'Approve Stream Receiver' }).click();
  await sender.page.getByRole('button', { name: 'Approve Memory Receiver' }).click();

  // Receivers review the offer, then explicitly accept.
  await expect(streamer.page.getByRole('list', { name: 'Offered files' })).toContainText('photo-archive.bin');
  await expect(streamer.page.getByText('Keep this tab open').first()).toBeVisible();
  await expect(receiverCard(sender.page, 'Stream Receiver')).toContainText('Awaiting acceptance');
  await streamer.page.getByRole('button', { name: 'Choose folder and accept' }).click();

  const downloads: Array<{ name: string; path: string }> = [];
  memory.page.on('download', async (d) => {
    downloads.push({ name: d.suggestedFilename(), path: (await d.path())! });
  });
  await memory.page.getByRole('button', { name: 'Accept and download' }).click();

  await expect(streamer.page.getByText('All files received')).toBeVisible();
  await expect(memory.page.getByText('Delivered to your browser — save unconfirmed')).toBeVisible();

  // Byte-exact results on both receivers.
  for (const f of files) {
    const saved = await opfsFile(streamer.page, f.name);
    expect(saved).toEqual({ size: f.size, sha256: f.sha256 });
  }
  await expect.poll(() => downloads.length).toBe(2);
  await expect.poll(async () => downloads.every((d) => d.path)).toBe(true);
  for (const f of files) {
    const d = downloads.find((x) => x.name === f.name)!;
    expect(sha256File(d.path)).toBe(f.sha256);
  }

  // Sender: one complete receiver; the memory receiver is listed separately and not counted.
  const history = sender.page.locator('section.history');
  await expect(receiverCard(sender.page, 'Stream Receiver')).toContainText('Completed');
  await expect(receiverCard(sender.page, 'Memory Receiver')).toContainText('Save unconfirmed');
  await expect(history.locator('.history-group')).toHaveCount(1);
  await expect(history.locator('.history-group')).toContainText('Stream Receiver');
  await expect(history.locator('.history-group')).toContainText('Received all files');
  await expect(history.locator('.stat').first()).toContainText('1');
  const other = history.locator('.other-outcomes');
  await expect(other).toContainText('Delivered to browser — save unconfirmed');
  await expect(other).toContainText('Memory Receiver');
  await expect(other.getByRole('row')).toHaveCount(3); // header + 2 files

  // The signaling server only relayed a few KB of negotiation messages.
  const after = await serverStats(sender.page);
  const totalFileBytes = files.reduce((n, f) => n + f.size, 0) * 2;
  const signalingBytes = after.bytesIn - before.bytesIn;
  console.log(`file bytes delivered: ${totalFileBytes}, signaling bytes received by server: ${signalingBytes}`);
  expect(signalingBytes).toBeLessThan(100_000);
  expect(signalingBytes).toBeLessThan(totalFileBytes / 100);

  for (const p of [sender, streamer, memory]) await p.context.close();
});

test('a receiver that disappears mid-transfer does not disrupt another receiver', async ({ browser }) => {
  const file = makeFile('video.bin', 40 * 1024 * 1024);
  const sender = await newPage(browser);
  const url = await startSharing(sender.page, [file]);

  const a = await newPage(browser, STREAMING_PICKER);
  const b = await newPage(browser, STREAMING_PICKER);
  await joinShare(a.page, url, 'Alice');
  await joinShare(b.page, url, 'Bob');
  for (const p of [a.page, b.page]) await p.evaluate(() => ((window as unknown as { __writeDelayMs: number }).__writeDelayMs = 4));
  await sender.page.getByRole('button', { name: 'Approve Alice' }).click();
  await sender.page.getByRole('button', { name: 'Approve Bob' }).click();
  await a.page.getByRole('button', { name: 'Choose folder and accept' }).click();
  await b.page.getByRole('button', { name: 'Choose folder and accept' }).click();

  const aliceBar = receiverCard(sender.page, 'Alice').getByRole('progressbar', { name: 'Overall progress for Alice' });
  await expect.poll(async () => Number(await aliceBar.getAttribute('aria-valuenow')), { timeout: 60_000 }).toBeGreaterThan(5);
  await a.context.close(); // Alice closes her tab mid-transfer

  await expect(receiverCard(sender.page, 'Alice')).toContainText('Failed', { timeout: 60_000 });
  await expect(receiverCard(sender.page, 'Alice')).toContainText('connection');
  await expect(b.page.getByText('All files received')).toBeVisible({ timeout: 120_000 });
  expect(await opfsFile(b.page, file.name)).toEqual({ size: file.size, sha256: file.sha256 });

  const history = sender.page.locator('section.history');
  await expect(history.locator('.history-group')).toHaveCount(1);
  await expect(history.locator('.history-group')).toContainText('Bob');
  await expect(history).not.toContainText('Alice');

  for (const p of [sender, b]) await p.context.close();
});

test('approval, rejection, retry, cancellation and stop sharing', async ({ browser }) => {
  const file = makeFile('report.bin', 30 * 1024 * 1024);
  const sender = await newPage(browser);
  const url = await startSharing(sender.page, [file]);

  // Sender rejects an unknown receiver.
  const stranger = await newPage(browser);
  await joinShare(stranger.page, url, 'Stranger');
  await receiverCard(sender.page, 'Stranger').getByRole('button', { name: 'Reject' }).click();
  await expect(stranger.page.getByText('Not approved')).toBeVisible();

  // Receiver declines, then asks to try again.
  const r = await newPage(browser, STREAMING_PICKER);
  await joinShare(r.page, url); // anonymous
  await expect(receiverCard(sender.page, 'Receiver 2')).toBeVisible();
  await sender.page.getByRole('button', { name: 'Approve Receiver 2' }).click();
  await r.page.getByRole('button', { name: 'Decline' }).click();
  await expect(receiverCard(sender.page, 'Receiver 2')).toContainText('Rejected');
  await expect(receiverCard(sender.page, 'Receiver 2')).toContainText('declined');
  await r.page.getByRole('button', { name: 'Try again' }).click();

  // New attempt: accept, then the sender cancels mid-way.
  await r.page.evaluate(() => ((window as unknown as { __writeDelayMs: number }).__writeDelayMs = 5));
  await r.page.getByRole('button', { name: 'Choose folder and accept' }).click();
  await expect(receiverCard(sender.page, 'Receiver 2')).toContainText('Attempt 2');
  const bar = receiverCard(sender.page, 'Receiver 2').getByRole('progressbar').first();
  await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow'))).toBeGreaterThan(3);
  await receiverCard(sender.page, 'Receiver 2').getByRole('button', { name: 'Cancel transfer' }).click();
  await expect(r.page.getByText('The sender canceled the transfer')).toBeVisible();
  await expect(receiverCard(sender.page, 'Receiver 2')).toContainText('Canceled');
  // The partially written file was removed from the receiver's folder.
  await expect.poll(() => opfsNames(r.page)).toEqual([]);

  // Retry from the sender side, let it finish.
  await r.page.evaluate(() => ((window as unknown as { __writeDelayMs: number }).__writeDelayMs = 0));
  await receiverCard(sender.page, 'Receiver 2').getByRole('button', { name: 'Retry' }).click();
  await r.page.getByRole('button', { name: 'Choose folder and accept' }).click();
  await expect(r.page.getByText('All files received')).toBeVisible({ timeout: 60_000 });
  expect(await opfsFile(r.page, file.name)).toEqual({ size: file.size, sha256: file.sha256 });
  await expect(sender.page.locator('section.history .history-group')).toContainText('Receiver 2');

  // Stop sharing: link dies, history stays.
  await sender.page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(sender.page.getByRole('heading', { name: 'Sharing stopped' })).toBeVisible();
  await expect(sender.page.locator('section.history .history-group')).toContainText('Receiver 2');
  const late = await newPage(browser);
  await late.page.goto(url);
  await late.page.getByRole('button', { name: 'Connect to sender' }).click();
  await expect(late.page.getByText('Link unavailable')).toBeVisible();
  await expect(late.page.getByText('no longer sharing')).toBeVisible();

  for (const p of [sender, stranger, r, late]) await p.context.close();
});

test('browsers without direct-to-disk saving reject large transfers before they begin', async ({ browser }) => {
  const file = makeFile('too-big.bin', 80 * 1024 * 1024); // e2e memory limit is 64 MB
  const sender = await newPage(browser);
  const url = await startSharing(sender.page, [file]);
  const r = await newPage(browser, NO_FILESYSTEM_API);
  await joinShare(r.page, url, 'Old Browser');
  await sender.page.getByRole('button', { name: 'Approve Old Browser' }).click();
  await expect(r.page.getByText('Too large for this browser')).toBeVisible();
  await expect(r.page.getByRole('button', { name: 'Accept and download' })).toHaveCount(0);
  await r.page.getByRole('button', { name: 'Tell the sender and close' }).click();
  await expect(receiverCard(sender.page, 'Old Browser')).toContainText('Rejected');
  await expect(receiverCard(sender.page, 'Old Browser')).toContainText('too large');
  for (const p of [sender, r]) await p.context.close();
});

test('approved receivers beyond the concurrency limit are queued visibly and served later', async ({ browser }) => {
  const file = makeFile('dataset.bin', 12 * 1024 * 1024);
  const sender = await newPage(browser);
  const url = await startSharing(sender.page, [file]);
  const names = ['Q1', 'Q2', 'Q3', 'Q4'];
  const receivers = [];
  for (const name of names) {
    const r = await newPage(browser, STREAMING_PICKER);
    await joinShare(r.page, url, name);
    await r.page.evaluate(() => ((window as unknown as { __writeDelayMs: number }).__writeDelayMs = 3));
    receivers.push(r);
  }
  for (const name of names) await sender.page.getByRole('button', { name: `Approve ${name}` }).click();

  // Limit is 3 in the e2e environment.
  await expect(receiverCard(sender.page, 'Q4')).toContainText('Queued · #1');
  await expect(receivers[3]!.page.getByText('number 1 in line')).toBeVisible();

  for (const r of receivers.slice(0, 3)) await r.page.getByRole('button', { name: 'Choose folder and accept' }).click();
  await receivers[3]!.page.getByRole('button', { name: 'Choose folder and accept' }).click({ timeout: 120_000 });
  for (const r of receivers) await expect(r.page.getByText('All files received')).toBeVisible({ timeout: 120_000 });
  await expect(sender.page.locator('section.history .history-group')).toHaveCount(4);
  await expect(sender.page.locator('section.history .stat').first()).toContainText('4');
  for (const p of [sender, ...receivers]) await p.context.close();
});

test('large streamed transfer keeps browser memory bounded', async ({ browser }) => {
  const sizeMb = Number(process.env.LARGE_FILE_MB ?? 1024);
  const file = makeFile('large.bin', sizeMb * 1024 * 1024);
  const sender = await newPage(browser);
  const url = await startSharing(sender.page, [file]);
  const r = await newPage(browser, CHECKSUM_PICKER);
  await joinShare(r.page, url, 'Big');
  await sender.page.getByRole('button', { name: 'Approve Big' }).click();

  const browserRssMb = () => {
    const out = execSync('ps -eo rss=,args=').toString();
    return (
      out
        .split('\n')
        .filter((line) => /chrom|headless_shell/i.test(line))
        .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] ?? 0), 0) / 1024
    );
  };
  const heapMb = (p: Page) =>
    p.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576);

  const baseline = browserRssMb();
  let peakRss = baseline;
  let peakHeap = 0;
  const started = Date.now();
  await r.page.getByRole('button', { name: 'Choose folder and accept' }).click();
  const done = r.page.getByText('All files received');
  const failed = r.page.getByText('Transfer failed');
  while (!(await done.isVisible())) {
    expect(await failed.isVisible()).toBe(false);
    peakRss = Math.max(peakRss, browserRssMb());
    peakHeap = Math.max(peakHeap, await heapMb(sender.page), await heapMb(r.page));
    if (Date.now() - started > 200_000) throw new Error('large transfer timed out');
    await new Promise((res) => setTimeout(res, 500));
  }
  const seconds = (Date.now() - started) / 1000;
  const growth = peakRss - baseline;
  console.log(
    `${sizeMb} MB in ${seconds.toFixed(1)} s (${(sizeMb / seconds).toFixed(1)} MB/s); browser RSS baseline ${baseline.toFixed(0)} MB, peak growth ${growth.toFixed(0)} MB; peak JS heap ${peakHeap.toFixed(0)} MB`,
  );
  // Fixed overhead (WebRTC/SCTP buffers, browser internals) that must not scale
  // with file size: measured ~134 MB for 256 MB and ~143 MB for 1 GB.
  expect(growth).toBeLessThan(300);
  expect(peakHeap).toBeLessThan(150);

  const result = await r.page.evaluate(
    (name) => (window as unknown as { __checksums: Record<string, { size: number; fnv: number; closed: boolean }> }).__checksums[name],
    file.name,
  );
  expect(result).toEqual({ size: file.size, fnv: fnv1a(file.path), closed: true });
  await expect(sender.page.locator('section.history .history-group')).toContainText('Big');
  for (const p of [sender, r]) await p.context.close();
});
