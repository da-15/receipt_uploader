// アプリ本体（HTML・アイコン）をキャッシュし、電波が弱い場所でも画面をすぐ表示する。
// アップロード / OCR（script.google.com への通信）はキャッシュせずそのまま通す。
// アセットを追加・変更したら CACHE_NAME の版数を上げること。
const CACHE_NAME = "receipt-uploader-v1";
// HTML の応答をこの時間待っても来なければキャッシュを表示する
const NAV_TIMEOUT_MS = 3000;
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/icon.png",
  "./assets/apple-touch-icon.png",
  "./assets/android-touch-icon.png",
  "./assets/icon-512.png",
  "./assets/blank.png",
  "./assets/done.png",
  "./assets/pdf.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 同一オリジンの GET 以外（GAS への通信など）は触らない
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    // HTML はネットワーク優先（更新がすぐ反映される）。
    // ただし応答が遅いとき（電波が弱いとき）やオフライン時はキャッシュを表示する。
    // 遅れて届いた最新版はキャッシュに保存され、次回起動時に反映される。
    const network = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(
          caches.open(CACHE_NAME).then((c) => c.put("./index.html", copy)),
        );
      }
      return res;
    });
    event.waitUntil(network.catch(() => {}));
    const cached = () => caches.match("./index.html");
    const timeout = new Promise((resolve) =>
      setTimeout(() => cached().then((hit) => hit && resolve(hit)), NAV_TIMEOUT_MS),
    );
    event.respondWith(
      Promise.race([network, timeout]).catch(() =>
        cached().then((hit) => hit || network),
      ),
    );
    return;
  }

  // 画像などはキャッシュ優先
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
