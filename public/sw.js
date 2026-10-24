// Service worker da versão web: guarda os arquivos do app para funcionar
// offline depois da primeira visita. Os documentos nunca saem do aparelho.
// Trocar o nome quando mudar algum arquivo de public/ (ícones, manifesto), que
// não tem versão no nome: o cache antigo é apagado e os arquivos vêm de novo.
const CACHE = "pdf-acrobat-v3";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Página: rede primeiro (para receber atualizações), cache se offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Uma página de erro (servidor fora do ar, por exemplo) não substitui a boa.
          if (!response.ok) return caches.match(request).then((cached) => cached || response);
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match("./"))),
    );
    return;
  }
  // Demais arquivos (com nomes versionados): cache primeiro.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
