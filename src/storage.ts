// Remembers the output folder between sessions (the handle lives in IndexedDB).

const DB = 'bi_webcam';
const STORE = 'kv';
const KEY = 'outputDir';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export const canPickFolder = typeof window.showDirectoryPicker === 'function';

export async function loadDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await idb<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function pickDir(): Promise<FileSystemDirectoryHandle> {
  const dir = await window.showDirectoryPicker({ id: 'takes', mode: 'readwrite', startIn: 'videos' });
  await idb('readwrite', (s) => s.put(dir, KEY)).catch(() => {});
  return dir;
}

/** Must be called from a user gesture (e.g. the Record click) if permission was not kept. */
export async function ensureWritable(dir: FileSystemDirectoryHandle): Promise<boolean> {
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
}
