/**
 * Sanitizers for peer-provided strings. Everything a peer sends is untrusted:
 * filenames may contain path separators or device names, and display names may
 * contain control characters or be absurdly long. React escapes text when it
 * renders, so these functions focus on filesystem safety and readability.
 */

// Control characters, including DEL and the C1 range.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidirectional overrides and zero-width characters can disguise extensions
// (for example "photo‮gpj.exe" renders as "photoexe.jpg").
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// Characters that are invalid on at least one common filesystem.
const RESERVED_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export const MAX_FILENAME_LENGTH = 200;
export const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * Turns an arbitrary peer-provided name into a single, safe path segment.
 * The result is never empty, never a relative path, and never longer than
 * MAX_FILENAME_LENGTH characters (the extension is preserved when possible).
 */
export function sanitizeFilename(input: unknown, fallback = 'file'): string {
  let name = typeof input === 'string' ? input : '';
  name = name.normalize('NFC');
  name = name.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '');
  name = name.replace(RESERVED_FILENAME_CHARS, '_');
  name = name.replace(/\s+/g, ' ').trim();
  // Leading dots would create hidden files; trailing dots and spaces are
  // stripped silently by Windows.
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`;
  if (name.length === 0) name = fallback;

  if (name.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, MAX_FILENAME_LENGTH - ext.length).trimEnd() + ext;
  }
  return name;
}

/** Returns a cleaned display name, or undefined when nothing usable remains. */
export function sanitizeDisplayName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const name = input
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length === 0) return undefined;
  return Array.from(name).slice(0, MAX_DISPLAY_NAME_LENGTH).join('');
}

/** Normalizes a MIME type string or returns a safe default. */
export function sanitizeMimeType(input: unknown): string {
  if (typeof input !== 'string') return 'application/octet-stream';
  const type = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/.test(type)
    ? type
    : 'application/octet-stream';
}
