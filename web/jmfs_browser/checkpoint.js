const DATABASE = "jmfs-browser-search";
const DATABASE_VERSION = 1;
const STORE = "checkpoints";
export const CHECKPOINT_VERSION = 1;
export const BROWSER_SEARCH_RELEASE = 11;

let databasePromise = null;

export async function checkpointKey(indexIdentity, requestIdentity) {
  const descriptor = JSON.stringify({
    checkpointVersion: CHECKPOINT_VERSION,
    browserSearchRelease: BROWSER_SEARCH_RELEASE,
    index: indexIdentity,
    request: requestIdentity,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(descriptor));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadCheckpoint(key) {
  const database = await openDatabase();
  return requestResult(database.transaction(STORE).objectStore(STORE).get(key));
}

export async function saveCheckpoint(key, state) {
  const database = await openDatabase();
  const transaction = durableTransaction(database);
  transaction.objectStore(STORE).put({
    ...state,
    key,
    checkpointVersion: CHECKPOINT_VERSION,
    browserSearchRelease: BROWSER_SEARCH_RELEASE,
    updatedAt: Date.now(),
  });
  await transactionDone(transaction);
}

export async function deleteCheckpoint(key) {
  if (!key) return;
  const database = await openDatabase();
  const transaction = durableTransaction(database);
  transaction.objectStore(STORE).delete(key);
  await transactionDone(transaction);
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open checkpoint storage"));
      request.onblocked = () => reject(new Error("Checkpoint storage upgrade is blocked"));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function durableTransaction(database) {
  try {
    return database.transaction(STORE, "readwrite", { durability: "strict" });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return database.transaction(STORE, "readwrite");
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Checkpoint request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Checkpoint transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("Checkpoint transaction was aborted"));
  });
}
