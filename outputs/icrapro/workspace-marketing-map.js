// Rota Bulma map: a base map (OpenStreetMap through Leaflet, or Google's when the office has
// a browser map key) with one drawing layer on top. The layer is the same for both maps: it
// only asks the base map to turn a place into a screen point and back. On it the person
// draws a region with the mouse or a finger, and the firms found appear as dots.
(function (root) {
  const SVG = 'http://www.w3.org/2000/svg';
  const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TURKEY = { lat: 39.0, lng: 35.2, zoom: 6 };
  const CITY_ZOOM = 11;
  // Province centres, only to point the map at the chosen province.
  const CITY_CENTERS = {
    Adana: [37.0, 35.32],
    Adıyaman: [37.76, 38.28],
    Afyonkarahisar: [38.76, 30.54],
    Ağrı: [39.72, 43.05],
    Amasya: [40.65, 35.83],
    Ankara: [39.93, 32.86],
    Antalya: [36.89, 30.71],
    Artvin: [41.18, 41.82],
    Aydın: [37.85, 27.84],
    Balıkesir: [39.65, 27.88],
    Bilecik: [40.14, 29.98],
    Bingöl: [38.88, 40.5],
    Bitlis: [38.4, 42.11],
    Bolu: [40.73, 31.61],
    Burdur: [37.72, 30.29],
    Bursa: [40.19, 29.06],
    Çanakkale: [40.15, 26.41],
    Çankırı: [40.6, 33.62],
    Çorum: [40.55, 34.95],
    Denizli: [37.78, 29.09],
    Diyarbakır: [37.91, 40.24],
    Edirne: [41.68, 26.56],
    Elazığ: [38.68, 39.22],
    Erzincan: [39.75, 39.49],
    Erzurum: [39.9, 41.27],
    Eskişehir: [39.78, 30.52],
    Gaziantep: [37.07, 37.38],
    Giresun: [40.91, 38.39],
    Gümüşhane: [40.46, 39.48],
    Hakkari: [37.58, 43.74],
    Hatay: [36.2, 36.16],
    Isparta: [37.76, 30.55],
    Mersin: [36.8, 34.63],
    İstanbul: [41.01, 28.98],
    İzmir: [38.42, 27.14],
    Kars: [40.6, 43.1],
    Kastamonu: [41.38, 33.78],
    Kayseri: [38.72, 35.49],
    Kırklareli: [41.73, 27.22],
    Kırşehir: [39.15, 34.16],
    Kocaeli: [40.77, 29.92],
    Konya: [37.87, 32.48],
    Kütahya: [39.42, 29.98],
    Malatya: [38.35, 38.31],
    Manisa: [38.61, 27.43],
    Kahramanmaraş: [37.58, 36.93],
    Mardin: [37.31, 40.74],
    Muğla: [37.22, 28.36],
    Muş: [38.73, 41.49],
    Nevşehir: [38.62, 34.71],
    Niğde: [37.97, 34.68],
    Ordu: [40.98, 37.88],
    Rize: [41.02, 40.52],
    Sakarya: [40.76, 30.4],
    Samsun: [41.29, 36.33],
    Siirt: [37.93, 41.94],
    Sinop: [42.03, 35.15],
    Sivas: [39.75, 37.02],
    Tekirdağ: [40.98, 27.51],
    Tokat: [40.31, 36.55],
    Trabzon: [41.0, 39.72],
    Tunceli: [39.11, 39.55],
    Şanlıurfa: [37.16, 38.79],
    Uşak: [38.68, 29.41],
    Van: [38.49, 43.38],
    Yozgat: [39.82, 34.81],
    Zonguldak: [41.45, 31.79],
    Aksaray: [38.37, 34.03],
    Bayburt: [40.26, 40.22],
    Karaman: [37.18, 33.22],
    Kırıkkale: [39.85, 33.51],
    Batman: [37.88, 41.13],
    Şırnak: [37.52, 42.46],
    Bartın: [41.64, 32.34],
    Ardahan: [41.11, 42.7],
    Iğdır: [39.92, 44.04],
    Yalova: [40.65, 29.27],
    Karabük: [41.2, 32.62],
    Kilis: [36.72, 37.12],
    Osmaniye: [37.07, 36.25],
    Düzce: [40.84, 31.16],
  };

  const routeTools = () => root.HanMarketingRoute;
  const asset = (file) => (typeof root.assetUrl === 'function' ? root.assetUrl(file) : file);

  function cityView(name) {
    const fold = routeTools().fold;
    const wanted = fold(name);
    const found = wanted && Object.keys(CITY_CENTERS).find((city) => fold(city) === wanted);
    return found ? { lat: CITY_CENTERS[found][0], lng: CITY_CENTERS[found][1], zoom: CITY_ZOOM } : null;
  }

  let leafletReady = null;
  function loadLeaflet() {
    if (root.L?.map) return Promise.resolve(root.L);
    leafletReady ||= new Promise((resolve, reject) => {
      const failed = () => {
        leafletReady = null;
        reject(Error('Harita dosyaları yüklenemedi. Bağlantınızı kontrol edip sayfayı yenileyin.'));
      };
      const style = document.createElement('link');
      style.rel = 'stylesheet';
      style.href = asset('leaflet.css');
      document.head.append(style);
      const script = document.createElement('script');
      script.src = asset('leaflet.js');
      script.onload = () => (root.L?.map ? resolve(root.L) : failed());
      script.onerror = failed;
      document.head.append(script);
    });
    return leafletReady;
  }

  // Leaflet moves its own layers with a CSS animation while zooming; the drawing layer is
  // not one of them, so zooming is immediate and the two never drift apart.
  async function leafletBase(element, view) {
    const L = await loadLeaflet();
    const map = L.map(element, { zoomAnimation: false, markerZoomAnimation: false });
    map.attributionControl.setPrefix(false);
    L.tileLayer(TILES, {
      maxZoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> katkıda bulunanlar',
      // The site sends no Referer to other sites; OpenStreetMap's tile servers ask for one.
      referrerPolicy: 'strict-origin-when-cross-origin',
    }).addTo(map);
    map.setView([view.lat, view.lng], view.zoom);
    return {
      provider: 'osm',
      toPixel({ lat, lng }) {
        const point = map.latLngToContainerPoint([lat, lng]);
        return { x: point.x, y: point.y };
      },
      toLatLng({ x, y }) {
        const place = map.containerPointToLatLng([x, y]);
        return { lat: place.lat, lng: place.lng };
      },
      onChange: (listener) => map.on('move zoom viewreset resize', listener),
      fit: ({ south, west, north, east }) =>
        map.fitBounds(
          [
            [south, west],
            [north, east],
          ],
          { padding: [28, 28], maxZoom: 16, animate: false },
        ),
      setView: ({ lat, lng, zoom }) => map.setView([lat, lng], zoom, { animate: false }),
      view() {
        const center = map.getCenter();
        return { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
      },
      bounds() {
        const bounds = map.getBounds();
        return {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        };
      },
      resize: () => map.invalidateSize({ animate: false }),
      destroy: () => map.remove(),
    };
  }

  let googleReady = null;
  let googleKey = '';
  function loadGoogle(key) {
    if (root.google?.maps?.Map) return Promise.resolve(root.google.maps);
    if (googleReady && googleKey === key) return googleReady;
    googleKey = key;
    googleReady = new Promise((resolve, reject) => {
      const failed = () => {
        googleReady = null;
        reject(Error('Google haritası yüklenemedi.'));
      };
      const timer = setTimeout(failed, 15000);
      root.__hanGoogleMapsReady = () => {
        clearTimeout(timer);
        if (root.google?.maps?.Map) resolve(root.google.maps);
        else failed();
      };
      const script = document.createElement('script');
      script.src =
        'https://maps.googleapis.com/maps/api/js?' +
        new URLSearchParams({
          key,
          v: 'weekly',
          language: 'tr',
          region: 'TR',
          loading: 'async',
          callback: '__hanGoogleMapsReady',
        });
      script.referrerPolicy = 'strict-origin-when-cross-origin';
      script.onerror = () => {
        clearTimeout(timer);
        failed();
      };
      document.head.append(script);
    });
    return googleReady;
  }

  // `onRefused` runs when Google rejects the key after the map was created.
  async function googleBase(element, view, key, onRefused) {
    const gm = await loadGoogle(key);
    root.gm_authFailure = onRefused;
    const map = new gm.Map(element, {
      center: { lat: view.lat, lng: view.lng },
      zoom: view.zoom,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
    });
    // An empty overlay is how the Maps API hands out its screen projection.
    const probe = new gm.OverlayView();
    probe.onAdd = probe.draw = probe.onRemove = () => {};
    probe.setMap(map);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      gm.event.addListenerOnce(map, 'idle', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const projection = () => probe.getProjection();
    return {
      provider: 'google',
      toPixel({ lat, lng }) {
        const point = projection()?.fromLatLngToContainerPixel(new gm.LatLng(lat, lng));
        return point ? { x: point.x, y: point.y } : null;
      },
      toLatLng({ x, y }) {
        const place = projection()?.fromContainerPixelToLatLng(new gm.Point(x, y));
        return place ? { lat: place.lat(), lng: place.lng() } : null;
      },
      onChange: (listener) => map.addListener('bounds_changed', listener),
      fit: ({ south, west, north, east }) => map.fitBounds({ south, west, north, east }, 28),
      setView({ lat, lng, zoom }) {
        map.setCenter({ lat, lng });
        map.setZoom(zoom);
      },
      view() {
        const center = map.getCenter();
        return { lat: center.lat(), lng: center.lng(), zoom: map.getZoom() };
      },
      bounds() {
        const bounds = map.getBounds();
        if (!bounds) return null;
        const ne = bounds.getNorthEast(),
          sw = bounds.getSouthWest();
        return { south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() };
      },
      resize: () => gm.event.trigger(map, 'resize'),
      destroy() {
        probe.setMap(null);
        if (root.gm_authFailure === onRefused) root.gm_authFailure = undefined;
      },
    };
  }

  const svgNode = (name, attributes = {}) => {
    const node = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };

  // options: { provider: { provider, key }, view, base (tests), onRegion(region | null),
  //            onToggle(placeId), onHover(placeId | null), onDrawProblem(kind), onFallback() }
  async function create(container, options = {}) {
    const route = routeTools();
    const startView = options.view || TURKEY;
    container.textContent = '';
    container.classList.add('marketing-map-ready');
    let canvas = document.createElement('div');
    canvas.className = 'marketing-map-canvas';
    const layer = svgNode('svg', { class: 'marketing-map-overlay', 'aria-hidden': 'true' });
    const capture = svgNode('rect', { class: 'marketing-map-capture', width: '100%', height: '100%' });
    const shape = svgNode('polygon', { class: 'marketing-map-region' });
    const stroke = svgNode('polyline', { class: 'marketing-map-stroke' });
    const pinLayer = svgNode('g', { class: 'marketing-map-pins' });
    layer.append(shape, pinLayer, capture, stroke);
    container.append(canvas, layer);

    let destroyed = false;
    let base = null;
    let region = null;
    let pins = [];
    let pinNodes = new Map();
    let drawing = false;
    let active = false;
    let points = [];
    let frame = 0;

    const pointsText = (list) => list.map((point) => point.x.toFixed(1) + ',' + point.y.toFixed(1)).join(' ');

    function render() {
      frame = 0;
      if (destroyed || !base) return;
      const corners = region ? region.map(([lat, lng]) => base.toPixel({ lat, lng })) : [];
      if (corners.length && corners.every(Boolean)) {
        shape.setAttribute('points', pointsText(corners));
        shape.removeAttribute('visibility');
      } else shape.setAttribute('visibility', 'hidden');
      for (const pin of pins) {
        const node = pinNodes.get(pin.placeId);
        const point = base.toPixel(pin);
        if (!node) continue;
        if (point) node.setAttribute('transform', `translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`);
        node.setAttribute('visibility', point ? 'visible' : 'hidden');
      }
    }
    // Panning fires many events; one redraw per screen frame is enough.
    const schedule = () => {
      if (frame || destroyed) return;
      frame =
        typeof requestAnimationFrame === 'function' ? requestAnimationFrame(render) : setTimeout(render, 16);
    };

    async function useOsm(view) {
      canvas.remove();
      canvas = document.createElement('div');
      canvas.className = 'marketing-map-canvas';
      container.prepend(canvas);
      base = await leafletBase(canvas, view);
    }

    if (options.base) base = options.base;
    else if (options.provider?.provider === 'google' && options.provider.key) {
      try {
        base = await googleBase(canvas, startView, options.provider.key, () => {
          // Google refused the key: carry on with the free map from where the person was.
          if (destroyed || base?.provider !== 'google') return;
          const view = base.view();
          base.destroy();
          base = null;
          useOsm(view).then(() => {
            if (destroyed) return base.destroy();
            base.onChange(schedule);
            options.onFallback?.();
            render();
          });
        });
      } catch {
        await useOsm(startView);
        options.onFallback?.();
      }
    } else await useOsm(startView);
    base.onChange(schedule);

    const eventPoint = (event) => {
      const box = layer.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    function stopDraw() {
      drawing = active = false;
      points = [];
      layer.classList.remove('drawing');
      stroke.setAttribute('points', '');
      document.removeEventListener('keydown', onKey);
    }
    function onKey(event) {
      if (event.key !== 'Escape') return;
      stopDraw();
      options.onDrawProblem?.('cancelled');
    }
    function finishStroke() {
      if (!active) return;
      active = false;
      stroke.setAttribute('points', '');
      const xs = points.map((point) => point.x),
        ys = points.map((point) => point.y);
      const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      // A tap or a short scratch is not a region: stay in drawing mode and say so.
      if (points.length < 6 || span < 24) return options.onDrawProblem?.('short');
      const drawn = route.strokeToRegion(points, (point) => base.toLatLng(point) || { lat: NaN, lng: NaN });
      if (!drawn) return options.onDrawProblem?.('small');
      stopDraw();
      region = drawn;
      render();
      options.onRegion?.(drawn);
    }
    capture.addEventListener('pointerdown', (event) => {
      if (!drawing || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault();
      try {
        capture.setPointerCapture(event.pointerId);
      } catch {
        // Older browsers: the stroke still follows the pointer while it stays on the map.
      }
      active = true;
      points = [eventPoint(event)];
    });
    capture.addEventListener('pointermove', (event) => {
      if (!active) return;
      const point = eventPoint(event),
        last = points[points.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) < 2) return;
      points.push(point);
      stroke.setAttribute('points', pointsText(points));
    });
    capture.addEventListener('pointerup', finishStroke);
    capture.addEventListener('pointercancel', finishStroke);

    const pinOf = (event) => event.target.closest?.('[data-place]')?.getAttribute('data-place');
    pinLayer.addEventListener('click', (event) => {
      const id = pinOf(event);
      if (id) options.onToggle?.(id);
    });
    pinLayer.addEventListener('mouseover', (event) => options.onHover?.(pinOf(event) || null));
    pinLayer.addEventListener('mouseout', () => options.onHover?.(null));

    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            base?.resize();
            schedule();
          })
        : null;
    observer?.observe(container);

    const boundsOf = (list) => {
      const bounds = route.regionBounds(list);
      return bounds.south <= bounds.north ? bounds : null;
    };

    render();
    return {
      get provider() {
        return base?.provider || 'osm';
      },
      get drawing() {
        return drawing;
      },
      setRegion(next) {
        region = next && route.validRegion(next) ? next : null;
        render();
      },
      // pins: [{ placeId, lat, lng, name, status: 'new' | 'planned' | 'visited' | 'refused', selected }]
      setPins(next) {
        pins = next;
        pinNodes = new Map();
        pinLayer.textContent = '';
        // Selected firms are drawn last, on top of the others.
        for (const pin of [...next].sort((a, b) => Number(a.selected) - Number(b.selected))) {
          const node = svgNode('g', {
            class: 'marketing-pin ' + pin.status + (pin.selected ? ' selected' : ''),
            'data-place': pin.placeId,
          });
          const title = svgNode('title');
          title.textContent = pin.name;
          node.append(svgNode('circle', { r: pin.selected ? '9' : '7' }), title);
          pinLayer.append(node);
          pinNodes.set(pin.placeId, node);
        }
        render();
      },
      highlight(placeId) {
        for (const [id, node] of pinNodes) node.classList.toggle('hover', id === placeId);
      },
      fitRegion(next) {
        if (base && next?.length) base.fit(route.regionBounds(next));
      },
      fitPoints(list) {
        const located = list.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
        if (!base || !located.length) return;
        if (located.length === 1) return base.setView({ lat: located[0].lat, lng: located[0].lng, zoom: 15 });
        const bounds = boundsOf(located.map((point) => [point.lat, point.lng]));
        if (bounds) base.fit(bounds);
      },
      focusCity(name) {
        const view = cityView(name);
        if (base && view) base.setView(view);
        return !!view;
      },
      // The part of the map on screen as a region, a little inside the edges.
      viewportRegion() {
        const bounds = base?.bounds();
        if (!bounds) return null;
        const dLat = (bounds.north - bounds.south) * 0.06,
          dLng = (bounds.east - bounds.west) * 0.06;
        const round = (value) => Number(value.toFixed(5));
        const next = [
          [round(bounds.north - dLat), round(bounds.west + dLng)],
          [round(bounds.north - dLat), round(bounds.east - dLng)],
          [round(bounds.south + dLat), round(bounds.east - dLng)],
          [round(bounds.south + dLat), round(bounds.west + dLng)],
        ];
        return route.validRegion(next) ? next : null;
      },
      startDraw() {
        if (!base) return;
        drawing = true;
        layer.classList.add('drawing');
        document.addEventListener('keydown', onKey);
      },
      stopDraw,
      view: () => base?.view() || null,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        stopDraw();
        observer?.disconnect();
        if (frame) (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout)(frame);
        base?.destroy();
        base = null;
        container.textContent = '';
        container.classList.remove('marketing-map-ready');
      },
    };
  }

  const api = { create, cityView, CITY_CENTERS, TURKEY };
  if (typeof module !== 'undefined') module.exports = api;
  else root.HanMarketingMap = api;
})(globalThis);
