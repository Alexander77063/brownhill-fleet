'use client';

import { useEffect, useRef } from 'react';
import type { Map as MlMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface FleetMapPosition {
  vehicle_id: string;
  registration: string | null;
  lat: number;
  lng: number;
  speed_mph: number | null;
}

// Free OSM raster tiles — no API key. Attribution shown per OSM's tile policy.
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

/**
 * Live fleet map — every tracked vehicle as a marker on a real slippy map. The
 * map library is dynamically imported inside the effect so nothing runs during
 * SSR (the component renders only a container div on the server).
 */
export function FleetMap({ positions }: { positions: FleetMapPosition[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: MlMap | undefined;
    let cancelled = false;

    (async () => {
      const maplibregl = await import('maplibre-gl');
      if (cancelled || !ref.current) return;

      const first = positions[0];
      const m = new maplibregl.Map({
        container: ref.current,
        style: OSM_STYLE,
        center: first ? [first.lng, first.lat] : [-0.12, 51.5],
        zoom: 9,
      });
      map = m;
      m.addControl(new maplibregl.NavigationControl(), 'top-right');

      const bounds = new maplibregl.LngLatBounds();
      for (const p of positions) {
        new maplibregl.Marker({ color: '#e6c558' })
          .setLngLat([p.lng, p.lat])
          .setPopup(
            new maplibregl.Popup({ offset: 22 }).setText(
              `${p.registration ?? 'Vehicle'}${p.speed_mph != null ? ` · ${Math.round(p.speed_mph)} mph` : ''}`,
            ),
          )
          .addTo(m);
        bounds.extend([p.lng, p.lat]);
      }
      if (positions.length > 1) m.fitBounds(bounds, { padding: 48, maxZoom: 13, duration: 0 });
      else if (positions.length === 1) m.setZoom(13);
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [positions]);

  return <div ref={ref} className="w-full overflow-hidden rounded-xl border border-hair" style={{ height: 460 }} />;
}
