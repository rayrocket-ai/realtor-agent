import { config } from "../config.js";

/**
 * Drive-time matrix via the Google Maps Distance Matrix API (accepts raw
 * addresses — no separate geocoding step needed at our volume).
 */
export interface MapsClient {
  /** minutes[i][j] = drive minutes from stops[i] to stops[j]; null when unroutable */
  driveMatrix(stops: string[]): Promise<Array<Array<number | null>>>;
}

let override: MapsClient | undefined;

/** Test hook. */
export function setMapsClient(client: MapsClient | undefined): void {
  override = client;
}

const FALLBACK_MINUTES = 25; // used when MAPS_API_KEY is not configured

export function mapsClient(): MapsClient {
  if (override) return override;
  const c = config();
  if (!c.mapsEnabled) {
    return {
      async driveMatrix(stops) {
        // No key: flat conservative estimate so tours still schedule sanely.
        return stops.map((_, i) => stops.map((_, j) => (i === j ? 0 : FALLBACK_MINUTES)));
      },
    };
  }
  return {
    async driveMatrix(stops) {
      const enc = stops.map((s) => encodeURIComponent(s)).join("|");
      const url =
        `https://maps.googleapis.com/maps/api/distancematrix/json` +
        `?origins=${enc}&destinations=${enc}&departure_time=now&key=${c.MAPS_API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Distance Matrix HTTP ${res.status}`);
      const data = (await res.json()) as {
        status: string;
        rows?: Array<{ elements: Array<{ status: string; duration?: { value: number } }> }>;
      };
      if (data.status !== "OK" || !data.rows) {
        throw new Error(`Distance Matrix error: ${data.status}`);
      }
      return data.rows.map((row) =>
        row.elements.map((el) =>
          el.status === "OK" && el.duration ? Math.ceil(el.duration.value / 60) : null,
        ),
      );
    },
  };
}
