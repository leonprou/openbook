import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const configSchema = z.object({
  aws: z.object({
    region: z.string().default("us-east-1"),
  }),
  rekognition: z
    .object({
      collectionId: z.string().default("claude-book-faces"),
      minConfidence: z.number().min(0).max(100).default(80),
      searchMethod: z.enum(["faces", "users"]).default("faces"),
      rateLimit: z
        .object({
          minTime: z.number().min(0).default(200),
          maxConcurrent: z.number().min(1).max(20).default(5),
        })
        .default({}),
      indexing: z
        .object({
          maxFaces: z.number().min(1).max(10).default(1),
          qualityFilter: z
            .enum(["NONE", "AUTO", "LOW", "MEDIUM", "HIGH"])
            .default("AUTO"),
          detectionAttributes: z.enum(["DEFAULT", "ALL"]).default("DEFAULT"),
        })
        .default({}),
      searching: z
        .object({
          maxFaces: z.number().min(1).max(100).default(10),
          maxUsers: z.number().min(1).max(100).default(10),
        })
        .default({}),
    })
    .default({}),
  imageProcessing: z
    .object({
      maxDimension: z.number().min(100).max(10000).default(4096),
      jpegQuality: z.number().min(1).max(100).default(90),
    })
    .default({}),
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
  session: z
    .object({
      timeoutMinutes: z.number().min(1).max(1440).default(15),
    })
    .default({}),
  display: z
    .object({
      photoLimit: z.number().min(1).max(1000).default(250),
      pageSize: z.number().min(10).max(500).default(50),
      progressBarWidth: z.number().min(10).max(100).default(20),
      columns: z
        .object({
          personName: z.number().min(5).max(50).default(12),
          folder: z.number().min(5).max(50).default(16),
          filename: z.number().min(10).max(100).default(45),
        })
        .default({}),
    })
    .default({}),
  scanning: z
    .object({
      concurrency: z.number().min(1).max(10).default(10),
      maxSortBuffer: z.number().min(1000).max(10000000).default(100000),
    })
    .default({}),
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
      imageProcessing: {},
      sources: { local: {} },
      training: {},
      albums: {},
      session: {},
      display: {},
      scanning: {},
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
  searchMethod: faces       # "faces" (individual vectors) or "users" (aggregated vectors)
  rateLimit:
    minTime: 200            # Minimum ms between requests
    maxConcurrent: 5        # Max concurrent API calls
  indexing:
    maxFaces: 1             # Faces to index per reference photo
    qualityFilter: AUTO     # NONE, AUTO, LOW, MEDIUM, HIGH
    detectionAttributes: DEFAULT  # DEFAULT or ALL
  searching:
    maxFaces: 10            # Max faces to search per photo
    maxUsers: 10            # Max users to search per photo (when searchMethod: users)

imageProcessing:
  maxDimension: 4096        # Max pixel dimension before resizing
  jpegQuality: 90           # Quality for JPEG conversion (1-100)

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

session:
  timeoutMinutes: 15        # Session cache validity

display:
  photoLimit: 250           # Max photos shown in list output
  pageSize: 50              # Results per page (with --page)
  progressBarWidth: 20      # Width of progress bar in characters
  columns:
    personName: 12          # Person name column width
    folder: 16              # Folder column width
    filename: 45            # Filename column width

scanning:
  concurrency: 10           # Parallel AWS requests (1-10)
  maxSortBuffer: 100000     # Max files to sort in memory
`;
}
