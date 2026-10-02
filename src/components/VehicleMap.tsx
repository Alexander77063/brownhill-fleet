/**
 * A real, interactive slippy map for one vehicle's latest position — an embedded
 * OpenStreetMap (pan/zoom) with a marker, dependency-free (no map library). A
 * fleet-wide canvas with journey-replay polylines would want a proper map library
 * (MapLibre/Leaflet); this delivers a genuine map per vehicle with zero deps.
 */
export function VehicleMap({
  lat,
  lng,
  label,
  height = 300,
}: {
  lat: number;
  lng: number;
  label?: string;
  height?: number;
}) {
  // A small bounding box around the point (~±0.01° ≈ 1km) for a street-level view.
  const d = 0.01;
  const bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
  const link = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

  return (
    <div>
      <div className="overflow-hidden rounded-[var(--radius)] border border-hair">
        <iframe
          title={label ? `Map — ${label}` : 'Vehicle location'}
          src={src}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          style={{ width: '100%', height, border: 0, display: 'block' }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
        <span className="font-mono">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-gold-bright hover:underline">
          Open larger map →
        </a>
      </div>
    </div>
  );
}
