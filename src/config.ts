import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const configSchema = z.object({
  aws: z.object({
    region: z.string().default("us-east-1"),
  }),
  rekognition: z.object({
    collectionId: z.string().default("claude-book-faces"),
    minConfidence: z.number().min(0).max(100).default(80),
  }),
  sources: z.object({
    local: z.object({
      paths: z.array(z.string()).default([]),
      extensions: z
        .array(z.string())
        .default([".jpg", ".jpeg", ".png", ".heic", ".HEIC"]),
    }),
  }),
  training: z.object({
    referencesPath: z.string().default("./references"),
  }),
  albums: z.object({
    prefix: z.string().default("Claude Book"),
  }),
});

export type Config = z.infer<typeof configSchema>;

const CONFIG_FILENAME = "config.yaml";

function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return resolve(p);
}

export function getConfigPath(): string {
  return join(process.cwd(), CONFIG_FILENAME);
}

export function loadConfig(): Config {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    // Return defaults if no config exists
    return configSchema.parse({
      aws: {},
      rekognition: {},
      sources: { local: {} },
      training: {},
      albums: {},
    });
  }

  const content = readFileSync(configPath, "utf-8");
  const raw = parseYaml(content);
  const config = configSchema.parse(raw);

  // Expand paths
  config.sources.local.paths = config.sources.local.paths.map(expandPath);
  config.training.referencesPath = expandPath(config.training.referencesPath);

  return config;
}

export function getDefaultConfig(): string {
  return `# Claude Book Configuration

aws:
  region: us-east-1

rekognition:
  collectionId: claude-book-faces
  minConfidence: 80

sources:
  local:
    paths:
      - ~/Pictures/Family
    extensions:
      - ".jpg"
      - ".jpeg"
      - ".png"
      - ".heic"
      - ".HEIC"

training:
  referencesPath: ./references

albums:
  prefix: "Claude Book"  # Albums: "Claude Book: Mom", "Claude Book: Dad"
`;
}
