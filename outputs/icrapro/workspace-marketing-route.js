// Route finder helpers shared by the browser, the server and node:test.
// Pure functions only: no DOM, storage or network access.
(function (root) {
  const VISIT_RESULTS = ['Görüşüldü', 'Yetkili yoktu', 'İlgilenmiyor', 'Tekrar gidilecek'];
  // Google Maps URLs: at most 9 waypoints (3 in mobile browsers) and 2,048 characters.
  const LINK_LIMIT = 2048;
  const EARTH_RADIUS = 6371000;

  const hasPoint = (point) => !!point && Number.isFinite(point.lat) && Number.isFinite(point.lng);

  function fold(value) {
    return String(value ?? '')
      .toLocaleLowerCase('tr')
      .replace(/ı/g, 'i')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function distanceMeters(a, b) {
    if (!hasPoint(a) || !hasPoint(b)) return null;
    const rad = (degrees) => (degrees * Math.PI) / 180;
    const h =
      Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
    return total;
  }

  function nearestNeighbour(start, stops) {
    const left = [...stops],
      route = [];
    let current = start;
    while (left.length) {
      let best = 0;
      for (let i = 1; i < left.length; i++)
        if (distanceMeters(current, left[i]) < distanceMeters(current, left[best])) best = i;
      current = left.splice(best, 1)[0];
      route.push(current);
    }
    return route;
  }

  // 2-opt on an open path. A given origin stays first; the last stop is free.
  function twoOpt(route, origin) {
    const points = origin ? [origin, ...route] : [...route];
    const first = origin ? 1 : 0;
    const d = distanceMeters;
    for (let round = 0, improved = true; improved && round < 50; round++) {
      improved = false;
      for (let i = first; i < points.length - 1; i++)
        for (let j = i + 1; j < points.length; j++) {
          const last = j === points.length - 1;
          const before = (i > 0 ? d(points[i - 1], points[i]) : 0) + (last ? 0 : d(points[j], points[j + 1]));
          const after = (i > 0 ? d(points[i - 1], points[j]) : 0) + (last ? 0 : d(points[i], points[j + 1]));
          if (after + 0.01 < before) {
            points.splice(i, j - i + 1, ...points.slice(i, j + 1).reverse());
            improved = true;
          }
        }
    }
    return origin ? points.slice(1) : points;
  }

  // Shortest practical visiting order. Stops without coordinates keep their order at the end.
  function orderStops(stops, origin = null) {
    const located = stops.filter(hasPoint),
      unlocated = stops.filter((stop) => !hasPoint(stop));
    if (located.length < 2) return [...located, ...unlocated];
    let best;
    if (hasPoint(origin)) best = nearestNeighbour(origin, located);
    else
      for (const [index, start] of located.entries()) {
        const candidate = [
          start,
          ...nearestNeighbour(
            start,
            located.filter((_, i) => i !== index),
          ),
        ];
        if (!best || pathLength(candidate) < pathLength(best)) best = candidate;
      }
    return [...twoOpt(best, hasPoint(origin) ? origin : null), ...unlocated];
  }

  function pointText(point) {
    if (typeof point?.text === 'string') return point.text.trim();
    if (hasPoint(point)) return point.lat.toFixed(6) + ',' + point.lng.toFixed(6);
    return String(point?.name || point?.address || '')
      .replace(/\|/g, ' ')
      .trim();
  }

  function directionsUrl(origin, stops, travelMode = 'driving') {
    const params = new URLSearchParams({ api: '1' });
    const from = origin ? pointText(origin) : '';
    if (from) {
      params.set('origin', from);
      if (origin.placeId) params.set('origin_place_id', origin.placeId);
    }
    const destination = stops[stops.length - 1];
    params.set('destination', pointText(destination));
    if (destination.placeId) params.set('destination_place_id', destination.placeId);
    const waypoints = stops.slice(0, -1);
    if (waypoints.length) {
      params.set('waypoints', waypoints.map(pointText).join('|'));
      if (waypoints.every((stop) => stop.placeId))
        params.set('waypoint_place_ids', waypoints.map((stop) => stop.placeId).join('|'));
    }
    params.set('travelmode', travelMode === 'walking' ? 'walking' : 'driving');
    return 'https://www.google.com/maps/dir/?' + params.toString();
  }

  // Each link continues from the previous link's last stop. Without an origin
  // Google Maps starts from the device's current location.
  function directionsLinks({ origin = null, stops = [], perLink = 10, travelMode = 'driving' } = {}) {
    const size = Math.max(2, Math.min(10, Math.floor(Number(perLink)) || 10));
    const links = [];
    let from = origin;
    for (let index = 0; index < stops.length;) {
      let count = Math.min(size, stops.length - index);
      let url = directionsUrl(from, stops.slice(index, index + count), travelMode);
      while (url.length > LINK_LIMIT && count > 1)
        url = directionsUrl(from, stops.slice(index, index + --count), travelMode);
      links.push({ url, from: index + 1, to: index + count });
      from = stops[index + count - 1];
      index += count;
    }
    return links;
  }

  function phoneDigits(value) {
    let digits = String(value ?? '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 12 && digits.startsWith('90')) digits = '0' + digits.slice(2);
    if (digits.length === 10 && !digits.startsWith('0')) digits = '0' + digits;
    return digits;
  }
  const isMobilePhone = (value) => /^05\d{9}$/.test(phoneDigits(value));

  function filterPlaces(places, filters = {}, origin = null) {
    const query = fold(filters.query);
    const rows = places
      .map((place, rank) => ({ ...place, rank, distance: distanceMeters(origin, place) }))
      .filter((place) => {
        const status = place.visit?.status || 'new';
        const result = place.visit?.result || '';
        if (filters.phone === 'any' && !place.phone) return false;
        if (filters.phone === 'mobile' && !isMobilePhone(place.phone)) return false;
        if (filters.visit === 'notVisited' && status === 'visited') return false;
        if (filters.visit === 'fresh' && status !== 'new') return false;
        if (filters.visit === 'planned' && status !== 'planned') return false;
        if (filters.visit === 'visited' && status !== 'visited') return false;
        if (filters.visit === 'revisit' && result !== 'Tekrar gidilecek') return false;
        if (filters.hideRefused && result === 'İlgilenmiyor') return false;
        if (filters.maxKm && !(place.distance !== null && place.distance <= filters.maxKm * 1000))
          return false;
        if (filters.openNow && place.openNow !== true) return false;
        if (filters.districtOnly && place.inDistrict === false) return false;
        if (filters.hideClosed && place.businessStatus && place.businessStatus !== 'OPERATIONAL')
          return false;
        if (filters.minRating && !(place.rating >= filters.minRating)) return false;
        if (filters.minReviews && !((place.ratingCount || 0) >= filters.minReviews)) return false;
        if (filters.website === 'yes' && !place.website) return false;
        if (filters.website === 'no' && place.website) return false;
        return !query || fold(place.name + ' ' + place.address).includes(query);
      });
    const compare = {
      distance: (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || (b.ratingCount || 0) - (a.ratingCount || 0),
      reviews: (a, b) => (b.ratingCount || 0) - (a.ratingCount || 0),
      name: (a, b) => String(a.name).localeCompare(String(b.name), 'tr'),
    }[filters.sort];
    return compare ? rows.sort((a, b) => compare(a, b) || a.rank - b.rank) : rows;
  }

  function whatsappText({ title, stops, links }) {
    const build = (withAddress) =>
      [
        title,
        '',
        ...stops.map(
          (stop, i) =>
            `${i + 1}. ${stop.name}${stop.phone ? ' · ' + stop.phone : ''}` +
            (withAddress && stop.address ? '\n   ' + stop.address : ''),
        ),
        '',
        'Google Haritalar rotası:',
        ...links.map(
          (link, i) =>
            (links.length > 1 ? `Bölüm ${i + 1}/${links.length} (durak ${link.from}–${link.to}): ` : '') +
            link.url,
        ),
      ].join('\n');
    const full = build(true);
    return full.length <= 6000 ? full : build(false);
  }

  function whatsappLink(phone, text) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    return (
      'https://wa.me/' + (/^[1-9]\d{7,14}$/.test(digits) ? digits : '') + '?text=' + encodeURIComponent(text)
    );
  }

  const api = {
    VISIT_RESULTS,
    LINK_LIMIT,
    fold,
    distanceMeters,
    orderStops,
    directionsUrl,
    directionsLinks,
    phoneDigits,
    isMobilePhone,
    filterPlaces,
    whatsappText,
    whatsappLink,
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.HanMarketingRoute = api;
})(globalThis);
