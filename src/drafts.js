// Rascunhos: enquanto um documento tem alterações não salvas, uma cópia dele
// fica guardada no aparelho (IndexedDB). Se o programa ou o navegador fechar
// sem querer (queda de luz, travamento, aba fechada), na próxima vez ele
// oferece recuperar. Salvar ou fechar o documento apaga o rascunho.

const DB_NAME = "pdfacrobat";
const STORE = "rascunhos";
// Um documento maior que isto não é guardado (ocuparia espaço demais no aparelho).
const MAX_BYTES = 150 * 1024 * 1024;
const SAVE_DELAY = 2500;
const RECHECK = 30000;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, task) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = task(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const putDraft = (draft) => withStore("readwrite", (store) => store.put(draft));
const deleteDraft = (id) => withStore("readwrite", (store) => store.delete(id));
const clearDrafts = () => withStore("readwrite", (store) => store.clear());
const allDrafts = () => withStore("readonly", (store) => store.getAll());

/** Os bytes do documento como está agora (com comentários e campos preenchidos), sem tirar o foco de onde a pessoa está. */
async function bytesOf(tab) {
  return tab.doc.annotationStorage.size > 0 ? tab.doc.saveDocument() : tab.doc.getData();
}

/**
 * Liga os rascunhos às abas de `manager`. Devolve { pending() (os rascunhos
 * que ficaram de uma vez anterior: [{ id, name, path, bytes }]), discard(ids)
 * e clear() (apaga todos: ao fechar o programa por vontade) }.
 */
export function setupDrafts(manager) {
  if (typeof indexedDB === "undefined") return { pending: async () => [], discard: async () => {}, clear: async () => {} };
  const session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const timers = new Map();
  const idOf = (tab) => `${session}-${tab.id}`;

  const forget = (tab) => {
    clearTimeout(timers.get(tab));
    timers.delete(tab);
    deleteDraft(idOf(tab)).catch(() => {});
  };

  const save = async (tab) => {
    timers.delete(tab);
    if (!tab.dirty || !tab.doc || !manager.tabs.includes(tab)) return;
    try {
      // Depois da alteração em andamento, para guardar o que ela deixou.
      await tab.queue;
      const bytes = await bytesOf(tab);
      if (!tab.dirty || !manager.tabs.includes(tab)) return;
      if (bytes.length > MAX_BYTES) return forget(tab);
      await putDraft({ id: idOf(tab), name: tab.name, path: tab.path || null, bytes, time: Date.now() });
      // Fechado ou salvo enquanto gravava: o rascunho não fica.
      if (!tab.dirty || !manager.tabs.includes(tab)) deleteDraft(idOf(tab)).catch(() => {});
    } catch (err) {
      console.warn("Não foi possível guardar o rascunho:", err);
    }
  };

  const schedule = (tab) => {
    if (!tab.dirty) return forget(tab);
    clearTimeout(timers.get(tab));
    timers.set(tab, setTimeout(() => save(tab), SAVE_DELAY));
  };

  manager.on("dirty", schedule);
  manager.on("loaded", (tab) => tab.dirty && schedule(tab));
  manager.on("removed", forget);
  // Comentários e campos de formulário mudam sem recarregar o documento: de tempos em tempos, guarda de novo.
  setInterval(() => {
    for (const tab of manager.tabs) if (tab.dirty && tab.doc?.annotationStorage.size > 0 && !timers.has(tab)) schedule(tab);
  }, RECHECK);

  return {
    pending: async () => {
      try {
        return (await allDrafts()).filter((draft) => !draft.id.startsWith(`${session}-`)).sort((a, b) => a.time - b.time);
      } catch {
        return [];
      }
    },
    discard: async (ids) => {
      for (const id of ids) await deleteDraft(id).catch(() => {});
    },
    clear: () => clearDrafts().catch(() => {}),
  };
}
