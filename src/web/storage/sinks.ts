/**
 * Receiver storage: where incoming bytes go.
 *
 *  - DirectorySinkFactory streams each file straight to disk inside a folder
 *    the user picked (File System Access API). Memory stays bounded; a save
 *    is confirmed once the writable stream closed successfully.
 *  - SaveFileSinkFactory does the same for a single file chosen with a
 *    "Save as" dialog.
 *  - MemorySinkFactory buffers one file in memory, then hands it to the
 *    browser's download manager. The app cannot know whether the download was
 *    saved, so it reports `confirmsSave = false`.
 */

export interface SinkFileInfo {
  safeName: string;
  size: number;
  safeType: string;
}

export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Finalizes the file. Resolves only after the destination was closed successfully. */
  close(): Promise<void>;
  /** Discards partial data. Never throws. */
  abort(): Promise<void>;
  /** Final name at the destination (may differ from the offered name to avoid overwriting). */
  readonly savedName: string;
}

export interface SinkFactory {
  readonly mode: 'stream' | 'memory';
  /** Whether a successful close() proves the file was saved at its destination. */
  readonly confirmsSave: boolean;
  /** Human-readable destination, e.g. the folder name. */
  readonly destinationLabel: string;
  open(file: SinkFileInfo): Promise<FileSink>;
  /** Releases resources held by the factory (object URLs, handles). */
  dispose(): void;
}

export class StorageError extends Error {
  constructor(
    readonly code: 'storage-full' | 'write-failed' | 'permission-denied' | 'too-large',
    message: string,
  ) {
    super(message);
  }
}

export function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : '';
  if (name === 'QuotaExceededError') {
    return new StorageError('storage-full', 'The device ran out of storage space while saving.');
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new StorageError('permission-denied', 'The browser did not allow saving to the chosen location. Choose another folder.');
  }
  return new StorageError('write-failed', 'Saving the file failed. Check that the destination is available and has free space.');
}

// ---------------------------------------------------------------------------
// Streaming to a user-selected folder

type WritableLike = { write(data: Uint8Array): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> };

export interface DirectoryHandleLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
}
export interface FileHandleLike {
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

class WritableSink implements FileSink {
  private closed = false;

  constructor(
    private readonly writable: WritableLike,
    readonly savedName: string,
    private readonly onAbort: () => Promise<void>,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    try {
      await this.writable.write(chunk);
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async close(): Promise<void> {
    try {
      await this.writable.close();
      this.closed = true;
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writable.abort().catch(() => undefined);
    await this.onAbort().catch(() => undefined);
  }
}

export class DirectorySinkFactory implements SinkFactory {
  readonly mode = 'stream' as const;
  readonly confirmsSave = true;
  private readonly reserved = new Set<string>();

  constructor(private readonly dir: DirectoryHandleLike) {}

  get destinationLabel(): string {
    return this.dir.name || 'the chosen folder';
  }

  async open(file: SinkFileInfo): Promise<FileSink> {
    try {
      const name = await this.uniqueName(file.safeName);
      this.reserved.add(name);
      const handle = await this.dir.getFileHandle(name, { create: true });
      // Chromium writes to a temporary swap file and only replaces the
      // target when close() succeeds, so partial data never appears as the file.
      const writable = await handle.createWritable({ keepExistingData: false });
      return new WritableSink(writable, name, () => this.dir.removeEntry(name));
    } catch (err) {
      throw toStorageError(err);
    }
  }

  dispose(): void {}

  /** Never overwrite: "name.ext" → "name (1).ext" → "name (2).ext" … */
  private async uniqueName(name: string): Promise<string> {
    const [base, ext] = splitName(name);
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? name : `${base} (${i})${ext}`;
      if (this.reserved.has(candidate)) continue;
      try {
        await this.dir.getFileHandle(candidate);
      } catch (err) {
        const errName = err instanceof DOMException || err instanceof Error ? err.name : '';
        if (errName === 'NotFoundError') return candidate;
        if (errName === 'TypeMismatchError') continue; // a folder with that name exists
        if (errName === 'TypeError') return this.uniqueName(`file${ext}`); // name rejected by the browser
        throw err;
      }
    }
    throw new StorageError('write-failed', 'Too many files with the same name in the chosen folder.');
  }
}

export class SaveFileSinkFactory implements SinkFactory {
  readonly mode = 'stream' as const;
  readonly confirmsSave = true;
  private used = false;

  constructor(
    private readonly handle: FileHandleLike & { name?: string },
    private readonly remove?: () => Promise<void>,
  ) {}

  get destinationLabel(): string {
    return this.handle.name ?? 'the chosen file';
  }

  async open(file: SinkFileInfo): Promise<FileSink> {
    if (this.used) throw new StorageError('write-failed', 'Only one file can be saved with "Save as".');
    this.used = true;
    try {
      const writable = await this.handle.createWritable({ keepExistingData: false });
      return new WritableSink(writable, this.handle.name ?? file.safeName, this.remove ?? (async () => undefined));
    } catch (err) {
      throw toStorageError(err);
    }
  }

  dispose(): void {}
}

// ---------------------------------------------------------------------------
// In-memory fallback

export type Downloader = (blob: Blob, filename: string) => void;

const REVOKE_AFTER_MS = 60_000;

export class MemorySinkFactory implements SinkFactory {
  readonly mode = 'memory' as const;
  readonly confirmsSave = false;
  readonly destinationLabel = "your browser's downloads";
  private buffered = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly urls = new Set<string>();

  private readonly download: Downloader;

  constructor(
    private readonly limitBytes: number,
    download?: Downloader,
  ) {
    this.download = download ?? ((blob, name) => this.triggerDownload(blob, name));
  }

  async open(file: SinkFileInfo): Promise<FileSink> {
    if (file.size > this.limitBytes) {
      throw new StorageError('too-large', 'This file is too large to receive in this browser.');
    }
    let chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    const release = () => {
      this.buffered -= size;
      chunks = [];
      size = 0;
    };
    return {
      savedName: file.safeName,
      write: async (chunk) => {
        if (done) throw new StorageError('write-failed', 'File already closed.');
        if (this.buffered + chunk.byteLength > this.limitBytes || size + chunk.byteLength > file.size) {
          throw new StorageError('too-large', 'This transfer exceeds the in-browser download limit.');
        }
        chunks.push(chunk);
        size += chunk.byteLength;
        this.buffered += chunk.byteLength;
      },
      close: async () => {
        done = true;
        const blob = new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
        release();
        this.download(blob, file.safeName);
      },
      abort: async () => {
        done = true;
        release();
      },
    };
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking immediately can cancel the download in some browsers.
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
      this.timers.delete(timer);
    }, REVOKE_AFTER_MS);
    this.timers.add(timer);
  }
}
