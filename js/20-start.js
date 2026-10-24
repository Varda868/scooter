// Offline-Start: Service Worker hält App und angesehene Kacheln vor (nur über HTTPS bzw. localhost)
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
