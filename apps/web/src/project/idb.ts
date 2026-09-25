/**
 * The last opened folder, remembered across reloads. A File System Access handle cannot be
 * stringified, so it goes in IndexedDB rather than localStorage; nothing else about the project is
 * stored anywhere (site/docs/editor.md).
 */
const DB_NAME = "zenith";
const STORE = "handles";
const KEY = "lastProject";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB refused to open."));
    };
  });
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = body(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("IndexedDB refused the request."));
        };
      }),
  );
}

export async function rememberDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    await run("readwrite", (store) => store.put(handle, KEY));
  } catch {
    // A private window with storage disabled still runs; it just forgets the folder.
  }
}

export async function recallDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await run<unknown>("readonly", (store) => store.get(KEY) as IDBRequest<unknown>);
    return handle instanceof FileSystemDirectoryHandle ? handle : null;
  } catch {
    return null;
  }
}

export async function forgetDirectory(): Promise<void> {
  try {
    await run("readwrite", (store) => store.delete(KEY));
  } catch {
    // Nothing to do: forgetting a handle that was never stored is not an error.
  }
}
