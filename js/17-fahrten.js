// --- Gefahrene Fahrten: das Navi schreibt mit (alle 25 m ein Punkt), beim Beenden wird die Fahrt gespeichert.
// Nur in diesem Browser (IndexedDB). Zählt für den km-Stand im Roller und den Tank seit dem Volltanken.
const exp = { rides: [], rec: [], db: null };

function rideDb() {
  exp.db ??= new Promise((ok, fail) => {
    const r = indexedDB.open('scooterways-fahrten', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('rides', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return exp.db;
}
async function rideTx(mode, fn) {
  const db = await rideDb();
  return new Promise((ok, fail) => {
    const tx = db.transaction('rides', mode), r = fn(tx.objectStore('rides'));
    tx.oncomplete = () => ok(r?.result);
    tx.onerror = () => fail(tx.error);
  });
}
const lineKm = coords => coords.reduce((sum, c, i) => i ? sum + map.distance(coords[i - 1], c) / 1000 : 0, 0);

async function addRides(list) {
  const fresh = list.filter(r => r.coords.length > 1 && !exp.rides.some(o => o.name === r.name && o.coords.length === r.coords.length));
  for (const r of fresh) {
    r.coords = thin(r.coords, 25).map(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)]);
    r.km = lineKm(r.coords);
    r.id = await rideTx('readwrite', st => st.add(r));
  }
  exp.rides.push(...fresh);
  queueMicrotask(rollerRender); // km-Stand zählt gefahrene Touren mit
  return fresh.length;
}

// Navi-Fahrt mitschreiben (alle 25 m ein Punkt) und beim Beenden als Fahrt übernehmen
function expRecord(lat, lon) {
  const last = exp.rec.at(-1);
  if (!last || map.distance(last, [lat, lon]) >= 25) exp.rec.push([lat, lon]);
}
function expSaveRecording() {
  const coords = exp.rec; exp.rec = [];
  if (coords.length < 2 || lineKm(coords) < 0.3) return;
  const d = new Date();
  addRides([{ name: `Navi ${d.toLocaleDateString('de-DE')} ${d.toTimeString().slice(0, 5)}`, date: d.toISOString(), coords }]).catch(() => {});
}

rideTx('readonly', st => st.getAll()).then(rides => { exp.rides = rides || []; queueMicrotask(rollerRender); }).catch(() => {});
