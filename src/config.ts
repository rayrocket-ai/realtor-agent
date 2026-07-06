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

  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),

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
  };
}

let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
