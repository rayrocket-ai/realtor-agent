import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),

  ADMIN_USER: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(1),
  APPROVAL_TOKEN_SECRET: z.string().min(8),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  MOCK_ANTHROPIC: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REFRESH_TOKEN: z.string().default(""),
  GOOGLE_CALENDAR_NAME: z.string().default("Real Estate"),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GMAIL_ADDRESS: z.string().default(""),
  GMAIL_MODE: z.enum(["label", "all"]).default("label"),
  GMAIL_LABEL: z.string().default("AI-Handle"),

  BOOSEND_API_KEY: z.string().default(""),
  BOOSEND_WEBHOOK_SECRET: z.string().default(""),
  BOOSEND_API_BASE: z.string().default("https://api.boosend.com/v1"),

  // --- Telegram control bot (book showings by messaging the bot) ---
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  // Comma-separated chat IDs allowed to command the bot. /start tells an
  // unknown chat its own ID so you can add it here.
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(""),

  REALTOR_NAME: z.string().default("Ray"),
  REALTOR_BROKERAGE: z.string().default("eXp Realty"),
  REALTOR_EMAIL: z.string().default(""),
  REALTOR_PHONE: z.string().default(""),

  WORKING_HOURS: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
    .default("09:00-20:00"),
  TZ: z.string().default("America/Toronto"),

  // --- REALM (PropTx MLS) + BrokerBay showing bookings ---
  REALM_URL: z.string().default("https://hub.proptx.ca"),
  REALM_USERNAME: z.string().default(""),
  REALM_PASSWORD: z.string().default(""),
  // Who sends REALM's one-time codes (phone number or email). When set, the
  // agent reads the code automatically from HighLevel (if configured below)
  // or Gmail — no manual step.
  REALM_OTP_SENDER: z.string().default(""),
  // HighLevel (GoHighLevel) — used to auto-read REALM's SMS codes when the
  // OTP number is a HighLevel line. Private Integration token (pit-…).
  HIGHLEVEL_API_TOKEN: z.string().default(""),
  HIGHLEVEL_LOCATION_ID: z.string().default(""),
  BROKERBAY_EMAIL: z.string().default(""),
  BROKERBAY_PASSWORD: z.string().default(""),
  // How to reach BrokerBay:
  //   brokerbay = sign into edge.brokerbay.com directly (BrokerBay's own search
  //               finds the listing) — the default, verified end-to-end.
  //   realm     = search REALM/PropTx first, then follow its Book Showing handoff.
  BOOKING_PORTAL: z.enum(["brokerbay", "realm"]).default("brokerbay"),
  BROKERBAY_URL: z.string().default("https://edge.brokerbay.com"),
  BOOKING_HEADLESS: z.enum(["0", "1"]).default("1"),
  BOOKING_DRY_RUN: z.enum(["0", "1"]).default("0"),
  BOOKING_DATA_DIR: z.string().default("./data/booking"),
  BOOKING_DEFAULT_DURATION_MIN: z.coerce.number().default(30),
});

export type Config = z.infer<typeof envSchema> & {
  workingHours: { start: string; end: string };
  gmailEnabled: boolean;
  boosendEnabled: boolean;
  bookingEnabled: boolean;
  telegramEnabled: boolean;
  telegramAllowedChatIds: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration (.env):\n${issues}`);
  }
  const c = parsed.data;
  const [start, end] = c.WORKING_HOURS.split("-") as [string, string];
  return {
    ...c,
    workingHours: { start, end },
    gmailEnabled: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_REFRESH_TOKEN && c.GMAIL_ADDRESS),
    boosendEnabled: Boolean(c.BOOSEND_API_KEY),
    bookingEnabled: Boolean(c.REALM_USERNAME && c.REALM_PASSWORD),
    telegramEnabled: Boolean(c.TELEGRAM_BOT_TOKEN),
    telegramAllowedChatIds: c.TELEGRAM_ALLOWED_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean),
  };
}

let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
