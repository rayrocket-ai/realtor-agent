import { config } from "../config.js";

const SELECT_FIELDS = [
  "ListingKey",
  "ListingId",
  "StandardStatus",
  "MlsStatus",
  "TransactionType",
  "ListPrice",
  "ClosePrice",
  "CloseDate",
  "LeaseAmount",
  "UnparsedAddress",
  "StreetNumber",
  "StreetName",
  "StreetSuffix",
  "UnitNumber",
  "City",
  "CityRegion",
  "StateOrProvince",
  "PostalCode",
  "PropertyType",
  "PropertySubType",
  "BoardPropertyType",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "ApproximateAge",
  "YearBuilt",
  "YearBuiltSource",
  "PublicRemarks",
  "ListOfficeName",
  "ListAgentFullName",
  "ShowingRequirements",
  "OfferRemarks",
  "Latitude",
  "Longitude",
  "ModificationTimestamp",
].join(",");

export interface ListingSearchCriteria {
  city?: string;
  minPrice?: number;
  maxPrice?: number;
  minBedrooms?: number;
  minBathrooms?: number;
  propertyType?: string;
  propertySubType?: string;
  propertyClass?: "residential" | "commercial";
  transactionType?: "sale" | "lease" | "sublease";
  mlsStatus?: string;
  status?: string;
  limit?: number;
}

export interface MlsListing {
  listingKey: string | null;
  mlsNumber: string | null;
  status: string | null;
  mlsStatus: string | null;
  transactionType: string | null;
  listPrice: number | null;
  closePrice: number | null;
  closeDate: string | null;
  leaseAmount: number | null;
  address: string | null;
  streetNumber: string | null;
  streetName: string | null;
  streetSuffix: string | null;
  unitNumber: string | null;
  city: string | null;
  cityRegion: string | null;
  province: string | null;
  postalCode: string | null;
  propertyType: string | null;
  propertySubType: string | null;
  boardPropertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  approximateAge: string | null;
  yearBuilt: number | null;
  yearBuiltSource: string | null;
  publicRemarks: string | null;
  listingOffice: string | null;
  listingAgent: string | null;
  showingRequirements: string | null;
  offerRemarks: string | null;
  latitude: number | null;
  longitude: number | null;
  modifiedAt: string | null;
  source: "PropTx RESO API";
}

type ResoRow = Record<string, unknown>;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(row: ResoRow): MlsListing {
  return {
    listingKey: stringValue(row.ListingKey),
    mlsNumber: stringValue(row.ListingId),
    status: stringValue(row.StandardStatus),
    mlsStatus: stringValue(row.MlsStatus),
    transactionType: stringValue(row.TransactionType),
    listPrice: numberValue(row.ListPrice),
    closePrice: numberValue(row.ClosePrice),
    closeDate: stringValue(row.CloseDate),
    leaseAmount: numberValue(row.LeaseAmount),
    address: stringValue(row.UnparsedAddress),
    streetNumber: stringValue(row.StreetNumber),
    streetName: stringValue(row.StreetName),
    streetSuffix: stringValue(row.StreetSuffix),
    unitNumber: stringValue(row.UnitNumber),
    city: stringValue(row.City),
    cityRegion: stringValue(row.CityRegion),
    province: stringValue(row.StateOrProvince),
    postalCode: stringValue(row.PostalCode),
    propertyType: stringValue(row.PropertyType),
    propertySubType: stringValue(row.PropertySubType),
    boardPropertyType: stringValue(row.BoardPropertyType),
    bedrooms: numberValue(row.BedroomsTotal),
    bathrooms: numberValue(row.BathroomsTotalInteger),
    approximateAge: stringValue(row.ApproximateAge),
    yearBuilt: numberValue(row.YearBuilt),
    yearBuiltSource: stringValue(row.YearBuiltSource),
    publicRemarks: stringValue(row.PublicRemarks),
    listingOffice: stringValue(row.ListOfficeName),
    listingAgent: stringValue(row.ListAgentFullName),
    showingRequirements: stringValue(row.ShowingRequirements),
    offerRemarks: stringValue(row.OfferRemarks),
    latitude: numberValue(row.Latitude),
    longitude: numberValue(row.Longitude),
    modifiedAt: stringValue(row.ModificationTimestamp),
    source: "PropTx RESO API",
  };
}

function quoteOData(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function orEquals(field: string, values: string[]): string {
  return `(${values.map((v) => `${field} eq ${quoteOData(v)}`).join(" or ")})`;
}

function normalizeStatusFilter(status?: string): string {
  const s = (status ?? "active").trim().toLowerCase();
  if (["sold", "sale sold", "closed sale"].includes(s)) {
    return `(StandardStatus eq 'Closed' and MlsStatus eq 'Sold')`;
  }
  if (["leased", "lease sold", "closed lease", "rented"].includes(s)) {
    return `(StandardStatus eq 'Closed' and MlsStatus eq 'Leased')`;
  }
  if (["closed", "done"].includes(s)) {
    return `StandardStatus eq 'Closed'`;
  }
  if (["expired", "terminated", "cancelled", "canceled"].includes(s)) {
    const mlsStatus = s === "canceled" ? "Cancelled" : s[0]!.toUpperCase() + s.slice(1);
    return `MlsStatus eq ${quoteOData(mlsStatus)}`;
  }
  if (["conditional", "sold conditional"].includes(s)) {
    return orEquals("MlsStatus", ["Sold Conditional", "Leased Conditional"]);
  }
  // PropTx historical records can have StandardStatus=Active while MlsStatus is
  // Sold/Expired/Terminated. Use active-like MLS statuses for current searches.
  return `(StandardStatus eq 'Active' and ${orEquals("MlsStatus", ["New", "Extension", "Price Change"])})`;
}

function transactionFilter(type?: ListingSearchCriteria["transactionType"]): string | null {
  if (!type) return null;
  if (type === "lease") return `TransactionType eq 'For Lease'`;
  if (type === "sublease") return `TransactionType eq 'For Sub-Lease'`;
  return `TransactionType eq 'For Sale'`;
}

function propertyClassFilter(propertyClass?: ListingSearchCriteria["propertyClass"]): string | null {
  if (!propertyClass) return null;
  if (propertyClass === "commercial") return `PropertyType eq 'Commercial'`;
  return orEquals("PropertyType", ["Residential Freehold", "Residential Condo & Other"]);
}

function normalizePropertySubType(value?: string): string | null {
  if (!value?.trim()) return null;
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    detached: "Detached",
    "detached house": "Detached",
    semi: "Semi-Detached",
    "semi detached": "Semi-Detached",
    townhouse: "Att/Row/Townhouse",
    townhome: "Att/Row/Townhouse",
    "freehold townhouse": "Att/Row/Townhouse",
    condo: "Condo Apartment",
    apartment: "Condo Apartment",
    "condo apartment": "Condo Apartment",
    office: "Office",
    industrial: "Industrial",
    retail: "Retail",
    "sale of business": "Sale Of Business",
  };
  return aliases[normalized] ?? value.trim();
}

function endpoint(): URL {
  const c = config();
  if (!c.mlsEnabled) {
    throw new Error(
      "Licensed MLS data is not configured. Set PROPTX_RESO_API_URL and PROPTX_RESO_ACCESS_TOKEN after PropTx approval.",
    );
  }
  return new URL(`${c.PROPTX_RESO_API_URL.replace(/\/$/, "")}/${c.PROPTX_RESO_RESOURCE}`);
}

function addODataParams(url: URL, params: Record<string, string>): URL {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  url.search = query;
  return url;
}

async function query(filters: string[], limit: number): Promise<MlsListing[]> {
  const c = config();
  const url = endpoint();
  const params: Record<string, string> = {
    $select: SELECT_FIELDS,
    $top: String(Math.min(Math.max(limit, 1), 25)),
  };
  if (filters.length) params.$filter = filters.join(" and ");
  // PropTx currently rejects descending ModificationTimestamp ordering on the
  // Web API token issued for this VOW feed. Let the provider use its default
  // order until the approved query options explicitly allow a sort direction.
  addODataParams(url, params);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${c.PROPTX_RESO_ACCESS_TOKEN}`,
      Accept: "application/json;odata.metadata=none",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`PropTx RESO API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as { value?: ResoRow[] };
  return (payload.value ?? []).map(normalize);
}

export async function searchListings(criteria: ListingSearchCriteria): Promise<MlsListing[]> {
  const filters = [normalizeStatusFilter(criteria.status)];
  // PropTx subdivides Toronto into board areas such as "Toronto C01" and
  // "Toronto W05". Exact equality makes a normal search for "Toronto" return
  // no current listings even though the feed contains them.
  if (criteria.city) filters.push(`startswith(City, ${quoteOData(criteria.city.trim())})`);
  if (criteria.minPrice != null) filters.push(`ListPrice ge ${Math.max(0, criteria.minPrice)}`);
  if (criteria.maxPrice != null) filters.push(`ListPrice le ${Math.max(0, criteria.maxPrice)}`);
  if (criteria.minBedrooms != null) {
    filters.push(`BedroomsTotal ge ${Math.max(0, Math.floor(criteria.minBedrooms))}`);
  }
  if (criteria.minBathrooms != null) {
    filters.push(`BathroomsTotalInteger ge ${Math.max(0, Math.floor(criteria.minBathrooms))}`);
  }
  let effectiveClass = criteria.propertyClass;
  const friendlyType = criteria.propertyType?.trim().toLowerCase();
  if (["house", "home", "residential house"].includes(friendlyType ?? "")) {
    effectiveClass = "residential";
    filters.push(
      orEquals("PropertySubType", [
        "Detached",
        "Semi-Detached",
        "Att/Row/Townhouse",
        "Link",
        "Multiplex",
      ]),
    );
  } else if (friendlyType === "residential") {
    effectiveClass = "residential";
  } else if (["commercial", "business"].includes(friendlyType ?? "")) {
    effectiveClass = "commercial";
  } else if (["condo", "condominium", "apartment"].includes(friendlyType ?? "")) {
    filters.push(`PropertyType eq 'Residential Condo & Other'`);
  } else if (criteria.propertyType) {
    filters.push(`PropertyType eq ${quoteOData(criteria.propertyType)}`);
  }
  const propertySubType = normalizePropertySubType(criteria.propertySubType);
  if (propertySubType) filters.push(`PropertySubType eq ${quoteOData(propertySubType)}`);
  const pClass = propertyClassFilter(effectiveClass);
  if (pClass) filters.push(pClass);
  // A general property search is a purchase search unless the caller
  // explicitly says lease/sublease. This prevents monthly rents from being
  // compared against buyer budgets such as "$1.2M".
  const tType = transactionFilter(criteria.transactionType ?? "sale");
  if (tType) filters.push(tType);
  if (criteria.mlsStatus) filters.push(`MlsStatus eq ${quoteOData(criteria.mlsStatus)}`);
  return query(filters, criteria.limit ?? 8);
}

export async function getListingByMls(mlsNumber: string): Promise<MlsListing | null> {
  const cleaned = mlsNumber.trim();
  if (!cleaned) return null;
  const value = quoteOData(cleaned);
  const rows = await query([`(ListingId eq ${value} or ListingKey eq ${value})`], 1);
  return rows[0] ?? null;
}

export interface ParsedAddressQuery {
  streetNumber: string | null;
  streetName: string;
  city: string | null;
}

const CITY_NAMES = [
  "Ajax",
  "Aurora",
  "Barrie",
  "Brampton",
  "Burlington",
  "Caledon",
  "East Gwillimbury",
  "Georgina",
  "Guelph",
  "Hamilton",
  "King",
  "Markham",
  "Milton",
  "Mississauga",
  "Newmarket",
  "North York",
  "Oakville",
  "Oshawa",
  "Pickering",
  "Richmond Hill",
  "Scarborough",
  "Toronto",
  "Vaughan",
  "Whitby",
] as const;

const STREET_SUFFIX =
  /\s+(?:ave(?:nue)?|blvd|boulevard|cir(?:cle)?|ct|court|cres(?:cent)?|dr(?:ive)?|gdns|gardens|ln|lane|pkwy|parkway|pl|place|rd|road|st|street|ter(?:race)?|trl|trail|way)\b.*$/i;

function simple(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const previous = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[b.length]!;
}

function detectTrailingCity(value: string): { address: string; city: string | null } {
  const trimmed = value.trim();
  const comma = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  if (comma.length > 1) {
    const supplied = comma[1]!;
    const exact = CITY_NAMES.find((city) => simple(city) === simple(supplied));
    return { address: comma[0]!, city: exact ?? supplied };
  }

  const words = trimmed.split(/\s+/);
  for (const city of [...CITY_NAMES].sort((a, b) => b.split(" ").length - a.split(" ").length)) {
    const count = city.split(" ").length;
    if (words.length <= count + 1) continue;
    const tail = words.slice(-count).join(" ");
    const closeSingleWord = count === 1 && editDistance(simple(tail), simple(city)) <= 2;
    if (simple(tail) === simple(city) || closeSingleWord) {
      return { address: words.slice(0, -count).join(" "), city };
    }
  }
  return { address: trimmed, city: null };
}

export function parseAddressQuery(input: string, suppliedCity?: string): ParsedAddressQuery {
  const detected = detectTrailingCity(input);
  const match = detected.address.match(/^\s*([0-9]+[A-Za-z]?)\s+(.+?)\s*$/);
  const streetNumber = match?.[1] ?? null;
  const rawStreet = (match?.[2] ?? detected.address).replace(STREET_SUFFIX, "").trim();
  const city = suppliedCity?.trim() || detected.city;
  return { streetNumber, streetName: rawStreet, city: city || null };
}

function addressScore(listing: MlsListing, parsed: ParsedAddressQuery): number {
  let score = 0;
  if (parsed.streetNumber && simple(listing.streetNumber ?? "") === simple(parsed.streetNumber)) score += 100;
  if (simple(listing.streetName ?? "") === simple(parsed.streetName)) score += 80;
  else if (simple(listing.streetName ?? "").includes(simple(parsed.streetName))) score += 50;
  if (parsed.city && simple(listing.city ?? "").includes(simple(parsed.city))) score += 40;
  if (listing.status === "Active") score += 20;
  const wanted = Number.parseInt(parsed.streetNumber ?? "", 10);
  const actual = Number.parseInt(listing.streetNumber ?? "", 10);
  if (Number.isFinite(wanted) && Number.isFinite(actual)) score -= Math.min(Math.abs(wanted - actual), 20);
  return score;
}

function rankAddressMatches(rows: MlsListing[], parsed: ParsedAddressQuery): MlsListing[] {
  return rows.sort((a, b) => {
    const score = addressScore(b, parsed) - addressScore(a, parsed);
    if (score) return score;
    return Date.parse(b.modifiedAt ?? "") - Date.parse(a.modifiedAt ?? "");
  });
}

/** Search current and historical MLS records by a human street address. */
export async function searchListingsByAddress(
  address: string,
  city?: string,
  limit = 8,
): Promise<{ parsed: ParsedAddressQuery; exact: boolean; listings: MlsListing[] }> {
  const parsed = parseAddressQuery(address, city);
  if (!parsed.streetName) return { parsed, exact: false, listings: [] };

  const base = [`contains(StreetName, ${quoteOData(parsed.streetName)})`];
  if (parsed.city) base.push(`contains(City, ${quoteOData(parsed.city)})`);

  if (parsed.streetNumber) {
    const exactRows = await query(
      [...base, `StreetNumber eq ${quoteOData(parsed.streetNumber)}`],
      25,
    );
    if (exactRows.length) {
      return {
        parsed,
        exact: true,
        listings: rankAddressMatches(exactRows, parsed).slice(0, Math.min(Math.max(limit, 1), 25)),
      };
    }
  }

  const number = Number.parseInt(parsed.streetNumber ?? "", 10);
  const nearbyFilter = Number.isFinite(number)
    ? orEquals(
        "StreetNumber",
        Array.from({ length: 11 }, (_, index) => String(Math.max(0, number - 5 + index))),
      )
    : null;
  const nearby = await query(nearbyFilter ? [...base, nearbyFilter] : base, 25);

  const bestByAddress = new Map<string, MlsListing>();
  for (const listing of rankAddressMatches(nearby, parsed)) {
    const key = simple(listing.address ?? `${listing.streetNumber}${listing.streetName}${listing.city}`);
    if (!bestByAddress.has(key)) bestByAddress.set(key, listing);
  }
  return {
    parsed,
    exact: false,
    listings: [...bestByAddress.values()].slice(0, Math.min(Math.max(limit, 1), 8)),
  };
}
