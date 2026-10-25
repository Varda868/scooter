// Route ziehen (Maus) erzeugt einen Formpunkt; kurzes Antippen öffnet ein Menü (auch für Touch).
// Ausgewertet wird mousedown/mouseup statt click, weil Leaflet den click nach abgeschaltetem Kartenziehen verschluckt.
function enableRouteEditing(line) {
  line.on('mousedown', e => {
    if (e.originalEvent.button) return;
    L.DomEvent.stop(e.originalEvent);
    map.dragging.disable();
    const downLL = e.latlng, downPt = e.containerPoint;
    let moved = false;
    const ghost = L.circleMarker(downLL, { radius: 7, color: '#555', fillColor: '#fff', fillOpacity: 1 }).addTo(map);
    const onMove = ev => {
      const pt = map.mouseEventToContainerPoint(ev);
      if (pt.distanceTo(downPt) > 5) moved = true;
      ghost.setLatLng(map.containerPointToLatLng(pt));
    };
    const onUp = ev => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      map.dragging.enable();
      map.removeLayer(ghost);
      if (moved) changeWaypoints(() => insertVia(map.mouseEventToLatLng(ev), true));
      else openRouteMenu(downLL);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function openRouteMenu(ll) {
  L.popup({ className: 'map-menu', minWidth: 170 }).setLatLng(ll).setContent(menuBox([
    ['via', 'Zwischenziel hier'], ['shape', 'Formpunkt hier (ohne Halt)'], ['avoid', 'Diese Straße meiden'], ['mypoi', '⭐ Eigenen POI hier']
  ], act => act === 'mypoi' ? openPoiForm(ll) :
    changeWaypoints(() => act === 'avoid' ? excluded.push(ll) : insertVia(ll, act === 'shape')), 'via')).openOn(map);
}

// --- Eigene POIs: Name, Symbol, Notiz; gespeichert im Browser, Austausch per GPX ---
const MY_POI_ICONS = ['⭐', '☕', '🍦', '🍽️', '📷', '🏞️', '🔧', '🅿️', '⛽', '🚰', '⚠️', '❤️'];

function openPoiForm(ll, poi) {
  const box = document.createElement('div');
  box.className = 'poi-form';
  box.innerHTML = `<b>${poi ? 'POI bearbeiten' : 'Eigener POI'}</b>
    <input name="name" placeholder="Name" value="${escapeHtml(poi?.name || '')}">
    <select name="icon">${MY_POI_ICONS.map(ic => `<option${ic === poi?.icon ? ' selected' : ''}>${ic}</option>`).join('')}</select>
    <textarea name="note" rows="3" placeholder="Notiz">${escapeHtml(poi?.note || '')}</textarea>`;
  const buttons = [['save', 'Speichern'], ...(poi ? [['via', 'Als Zwischenziel'], ['delete', 'Löschen']] : [])];
  box.append(menuBox(buttons, act => {
    const val = name => box.querySelector(`[name=${name}]`).value.trim();
    if (act === 'save') {
      const data = { name: val('name') || 'Mein POI', icon: val('icon'), note: val('note') };
      if (poi) Object.assign(poi, data);
      else myPois.push({ id: Date.now().toString(36), lat: ll.lat, lon: ll.lng, ...data });
    } else if (act === 'delete') {
      myPois = myPois.filter(p => p !== poi);
    } else if (act === 'via') {
      changeWaypoints(() => insertVia(L.latLng(poi.lat, poi.lon)));
      waypoints.find(w => w.latlng?.lat === poi.lat && w.latlng?.lng === poi.lon).text = poi.name;
      renderWaypoints();
    }
    store.set('myPois', myPois);
    renderMyPois();
  }, 'save'));
  L.popup({ className: 'map-menu', minWidth: 220 }).setLatLng(ll).setContent(box).openOn(map);
  setTimeout(() => box.querySelector('[name=name]').focus(), 50);
}

function renderMyPois() {
  myPoiLayer.clearLayers();
  myPois.forEach(poi => {
    poi.marker = L.marker([poi.lat, poi.lon], {
      icon: L.divIcon({ className: 'poi-icon', html: poi.icon, iconSize: [24, 24] }), title: poi.name
    }).addTo(myPoiLayer).on('click', () => openPoiForm(L.latLng(poi.lat, poi.lon), poi));
  });
  const withKm = myPois.map(poi => ({ poi, km: routeCoords ? locateOnRoute(poi.lat, poi.lon) : null }));
  $('myPoiCount').textContent = myPois.length ? `(${myPois.length})` : '';
  $('myPois').innerHTML = withKm.map(({ poi, km }, i) => `<li data-i="${i}">${poi.icon} ${escapeHtml(poi.name)}` +
    (km && km.dist <= +$('radius').value ? ` · km ${km.km.toFixed(1)} an der Route` : '') +
    (poi.note ? ` <span class="hint">– ${escapeHtml(poi.note.slice(0, 60))}</span>` : '') + '</li>').join('') ||
    '<li class="hint">Tippe auf die Karte → „Eigenen POI hier“.</li>';
  $('myPois').onclick = e => {
    const poi = withKm[e.target.closest('li')?.dataset.i]?.poi;
    if (poi) { map.setView([poi.lat, poi.lon], 15); openPoiForm(L.latLng(poi.lat, poi.lon), poi); }
  };
}

const xmlEscape = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
$('exportPois').onclick = () => {
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Scooterways" xmlns="http://www.topografix.com/GPX/1/1">
${myPois.map(p => `  <wpt lat="${p.lat}" lon="${p.lon}"><name>${xmlEscape(p.name)}</name><desc>${xmlEscape(p.note)}</desc><sym>${xmlEscape(p.icon)}</sym><type>scooterways</type></wpt>`).join('\n')}
</gpx>`;
  downloadGpx('scooterways-pois.gpx', gpx);
};

// Tour als GPX: ein Track (je Tagesetappe ein Segment, mit Höhe falls bekannt), Halte und Etappenenden als Wegpunkte.
// Gedacht für OsmAnd/Locus mit BRouter: dort offline navigieren und bei Abweichung neu rechnen lassen.
function downloadGpx(name, gpx) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('gpxTour').onclick = () => {
  if (!routeCoords) return;
  const ends = [...routeStages, routeKm.at(-1)];
  const segs = ends.map(() => []);
  routeCoords.forEach(([lat, lon], i) => {
    const d = ends.findIndex(e => routeKm[i] <= e + 1e-6);
    const pt = `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${eleData ? `<ele>${Math.round(heightAt(routeKm[i]))}</ele>` : ''}</trkpt>`;
    const k = d < 0 ? segs.length - 1 : d;
    // Etappengrenze gehört in beide Segmente, damit keine Lücke entsteht
    if (k > 0 && !segs[k].length && segs[k - 1].length) segs[k].push(segs[k - 1].at(-1));
    segs[k].push(pt);
  });
  const located = waypoints.filter(w => w.latlng);
  const wpts = located.map((w, i) => (!w.shaping || !i || i === located.length - 1) &&
    `  <wpt lat="${w.latlng.lat.toFixed(6)}" lon="${w.latlng.lng.toFixed(6)}"><name>${xmlEscape(w.text || coordText(w.latlng))}</name>` +
    `${w.note ? `<desc>${xmlEscape(w.note)}</desc>` : ''}<sym>${i === located.length - 1 ? 'Flag, Red' : 'Flag, Blue'}</sym></wpt>`).filter(Boolean);
  routeStages.forEach((km, d) => {
    const [lat, lon] = pointAtKm(km);
    wpts.push(`  <wpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><name>Etappenende Tag ${1 + nightsBefore(d)}${routeStageNights[d] > 1 ? ' + Ruhetag' : ''}</name><desc>km ${km.toFixed(0)}</desc><sym>Campground</sym></wpt>`);
  });
  const title = `${located[0]?.text || 'Start'} – ${located.at(-1)?.text || 'Ziel'}`;
  // Dateiname, der sagt, was drin ist: scw_2026-10-25_Augsburg-Athen_2050km_6Tage_Faehre.gpx (scw = Scooterways)
  const ortTeil = w => (w?.text || '').split(',')[0].replace(/^[^\p{L}\d]+/u, '').trim()
    .replace(/[äöüÄÖÜß]/g, c => ({ ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' })[c]).replace(/[^\p{L}\d]+/gu, '-').replace(/^-|-$/g, '').slice(0, 30) || 'Punkt';
  const tage = tourDays(), heute = new Date().toLocaleDateString('sv-SE'); // Ortszeit, nicht UTC
  const datei = ['scw', heute, `${ortTeil(located[0])}-${ortTeil(located.at(-1))}`,
    `${Math.round(routeKm.at(-1))}km`, tage > 1 && `${tage}Tage`, routeFaehren.length && 'Faehre'].filter(Boolean).join('_');
  downloadGpx(`${datei}.gpx`, `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Scooterways" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xmlEscape(title)}</name><desc>${xmlEscape([`${Math.round(routeKm.at(-1))} km`, tage > 1 && `${tage} Tage`, routeFaehren.length && `Fähren: ${routeFaehren.map(f => f.name || 'Fähre').join(', ')}`].filter(Boolean).join(' · '))}</desc></metadata>
${wpts.join('\n')}
  <trk><name>${xmlEscape(title)}</name><type>moped</type>
${segs.filter(sg => sg.length > 1).map(sg => `    <trkseg>\n      ${sg.join('\n      ')}\n    </trkseg>`).join('\n')}
  </trk>
</gpx>`);
};
