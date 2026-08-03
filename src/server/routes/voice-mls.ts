import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { config } from "../../config.js";
import { listingForModel } from "../../listings/field-policy.js";
import { searchListingsByAddress } from "../../listings/reso.js";

export async function voiceMlsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/elevenlabs/mls-address", async (req, reply) => {
    const c = config();
    if (!c.ELEVENLABS_WEBHOOK_SECRET || !c.mlsEnabled) {
      return reply.status(404).send({ ok: false, error: "MLS lookup is not configured" });
    }
    if (!safeEq(String(req.headers["x-voice-webhook-secret"] ?? ""), c.ELEVENLABS_WEBHOOK_SECRET)) {
      return reply.status(401).send({ ok: false, error: "invalid secret" });
    }

    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const address = typeof body.address === "string" ? body.address.trim() : "";
    const city = typeof body.city === "string" ? body.city.trim() : "";
    if (address.length < 3 || address.length > 300 || city.length > 120) {
      return reply.status(400).send({ ok: false, error: "A valid street address is required" });
    }

    try {
      const result = await searchListingsByAddress(address, city || undefined, 8);
      const exactRows = result.listings.filter((listing) =>
        simple(listing.streetNumber ?? "") === simple(result.parsed.streetNumber ?? "") &&
        simple(listing.streetName ?? "") === simple(result.parsed.streetName) &&
        (!result.parsed.city || simple(listing.city ?? "") === simple(result.parsed.city))
      );
      const selectedRows = exactRows.length ? exactRows : result.listings;
      const matches = selectedRows.slice(0, 5).map((raw) => {
        const listing = listingForModel(raw);
        const isCurrent = listing.status === "Active";
        return {
          exact_address_match: exactRows.includes(raw),
          address: listing.address,
          city: listing.city,
          province: listing.province,
          postal_code: listing.postalCode,
          mls_number: listing.mlsNumber,
          standard_status: listing.status,
          mls_status: listing.mlsStatus,
          transaction_type: listing.transactionType,
          list_price: isCurrent ? listing.listPrice : null,
          lease_amount: isCurrent ? listing.leaseAmount : null,
          bedrooms: listing.bedrooms,
          bathrooms: listing.bathrooms,
          property_type: listing.propertyType,
          property_sub_type: listing.propertySubType,
          public_remarks: isCurrent ? listing.publicRemarks : null,
          listing_office: isCurrent ? listing.listingOffice : null,
          last_modified: listing.modifiedAt,
          historical_price_withheld: !isCurrent,
        };
      });
      req.log.info({ source: "elevenlabs_front_desk", address, city: city || null, exact: result.exact, resultCount: matches.length }, "voice MLS lookup");
      return reply.send({
        ok: true,
        source: "PropTx RESO API",
        live_lookup: true,
        exact_address_match: exactRows.length > 0,
        requires_city_confirmation: !result.parsed.city,
        parsed_address: result.parsed,
        matches,
        disclosure_note: "Current public listing facts may be discussed. Historical sold/leased prices require Ray or an approved authenticated display workflow.",
      });
    } catch (error) {
      req.log.error({ err: error, address }, "voice MLS lookup failed");
      return reply.status(502).send({ ok: false, error: "The live MLS provider could not complete the lookup" });
    }
  });
}

function simple(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeEq(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
