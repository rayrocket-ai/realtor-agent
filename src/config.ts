import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  VOW_BASE_URL: z.string().url().default("https://homes.rayrealestate.ca"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),

  ADMIN_USER: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(1),
  APPROVAL_TOKEN_SECRET: z.string().min(8),
  // Optional dedicated secret for dashboard cookies. Existing deployments can
  // safely fall back to APPROVAL_TOKEN_SECRET until the next secret rotation.
  DASHBOARD_SESSION_SECRET: z.string().default(""),

  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  MOCK_ANTHROPIC: z.string().optional(),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(2).max(20).default(10),
  AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8192).default(4096),

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

  HIGHLEVEL_API_TOKEN: z.string().default(""),
  HIGHLEVEL_LOCATION_ID: z.string().default(""),

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  ELEVENLABS_API_KEY: z.string().default(""),
  ELEVENLABS_AGENT_ID: z.string().default(""),
  ELEVENLABS_NURTURE_AGENT_ID: z.string().default(""),
  ELEVENLABS_FEEDBACK_AGENT_ID: z.string().default(""),
  ELEVENLABS_BOOKING_AGENT_ID: z.string().default(""),
  ELEVENLABS_PHONE_NUMBER_ID: z.string().default(""),
  ELEVENLABS_WEBHOOK_SECRET: z.string().default(""),
  VAPI_WEBHOOK_SECRET: z.string().default(""),
  LOFTY_API_KEY: z.string().default(""),
  VOICE_CALLS_ENABLED: z.enum(["false", "true"]).default("false"),
  VOICE_RECORDING_ENABLED: z.enum(["false", "true"]).default("false"),

  PROPTX_RESO_API_URL: z.string().default(""),
  PROPTX_RESO_ACCESS_TOKEN: z.string().default(""),
  PROPTX_RESO_RESOURCE: z.string().default("Property"),

  // Review-before-send training wheels: 'all' = every reply needs approval
  // (unless the lead is marked auto-approve), 'off' = full auto.
  APPROVAL_MODE: z.enum(["all", "off"]).default("all"),
  MAPS_API_KEY: z.string().default(""),
  OFFICE_ADDRESS: z.string().default("8600 Keele St Unit 3, Concord, ON L4K 2N2"),

  REALTOR_NAME: z.string().default("Ray"),
  REALTOR_BROKERAGE: z.string().default("eXp Realty"),
  REALTOR_EMAIL: z.string().default(""),
  REALTOR_PHONE: z.string().default(""),

  WORKING_HOURS: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
    .default("09:00-20:00"),
  TZ: z.string().default("America/Toronto"),
});

export type Config = z.infer<typeof envSchema> & {
  workingHours: { start: string; end: string };
  gmailEnabled: boolean;
  boosendEnabled: boolean;
  telegramEnabled: boolean;
  mapsEnabled: boolean;
  mlsEnabled: boolean;
  voiceEnabled: boolean;
  highLevelEnabled: boolean;
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
    telegramEnabled: Boolean(c.TELEGRAM_BOT_TOKEN),
    mapsEnabled: Boolean(c.MAPS_API_KEY),
    mlsEnabled: Boolean(c.PROPTX_RESO_API_URL && c.PROPTX_RESO_ACCESS_TOKEN),
    voiceEnabled: Boolean(
      c.VOICE_CALLS_ENABLED === "true" &&
      c.ELEVENLABS_API_KEY &&
      c.ELEVENLABS_AGENT_ID &&
      c.ELEVENLABS_PHONE_NUMBER_ID,
    ),
    highLevelEnabled: Boolean(c.HIGHLEVEL_API_TOKEN && c.HIGHLEVEL_LOCATION_ID),
  };
}

let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
