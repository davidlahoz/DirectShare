/**
 * Feature detection for receiver save destinations. Never assume support:
 * the File System Access API is only available in some desktop browsers and
 * only in secure contexts (HTTPS or localhost).
 */
import { type DirectoryHandleLike, DirectorySinkFactory, type FileHandleLike, SaveFileSinkFactory } from './sinks';

interface PickerWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string; startIn?: string }) => Promise<DirectoryHandleLike>;
  showSaveFilePicker?: (options?: { suggestedName?: string; id?: string }) => Promise<FileHandleLike & { name: string }>;
}

export interface StorageCapabilities {
  /** Stream several files into a chosen folder. */
  directory: boolean;
  /** Stream a single file with a "Save as" dialog. */
  saveFile: boolean;
  secureContext: boolean;
}

export function detectStorageCapabilities(): StorageCapabilities {
  const w = (typeof window !== 'undefined' ? window : {}) as PickerWindow & { isSecureContext?: boolean };
  const secureContext = Boolean(w.isSecureContext);
  return {
    directory: secureContext && typeof w.showDirectoryPicker === 'function',
    saveFile: secureContext && typeof w.showSaveFilePicker === 'function',
    secureContext,
  };
}

/** True when the user dismissed a picker (not an error worth showing). */
export function isPickerCancel(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Must be called directly from a click handler (user activation required). */
export async function pickDirectory(): Promise<DirectorySinkFactory> {
  const w = window as unknown as PickerWindow;
  if (!w.showDirectoryPicker) throw new Error('Folder saving is not supported in this browser.');
  const dir = await w.showDirectoryPicker({ mode: 'readwrite', id: 'directsend' });
  return new DirectorySinkFactory(dir);
}

/** Must be called directly from a click handler (user activation required). */
export async function pickSaveFile(suggestedName: string): Promise<SaveFileSinkFactory> {
  const w = window as unknown as PickerWindow;
  if (!w.showSaveFilePicker) throw new Error('"Save as" is not supported in this browser.');
  const handle = await w.showSaveFilePicker({ suggestedName, id: 'directsend' });
  const removable = handle as FileHandleLike & { name: string; remove?: () => Promise<void> };
  return new SaveFileSinkFactory(handle, removable.remove ? () => removable.remove!() : undefined);
}
