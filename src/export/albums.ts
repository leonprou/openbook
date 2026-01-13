import { spawn } from "child_process";
import { createLogger } from "../logger";

const log = createLogger("albums");

async function runCommand(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    proc.on("error", (error) => {
      resolve({ stdout, stderr: error.message, code: 1 });
    });
  });
}

export interface AlbumResult {
  albumName: string;
  photosAdded: number;
  errors: string[];
}

async function runOsxphotos(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return runCommand("osxphotos", args);
}

export async function checkOsxphotosInstalled(): Promise<boolean> {
  const result = await runOsxphotos(["--version"]);
  return result.code === 0;
}

export async function addPhotosToAlbum(
  albumName: string,
  photoPaths: string[]
): Promise<AlbumResult> {
  const result: AlbumResult = {
    albumName,
    photosAdded: 0,
    errors: [],
  };

  if (photoPaths.length === 0) {
    log.debug({ albumName }, "No photos to add to album");
    return result;
  }

  log.debug({ albumName, photoCount: photoPaths.length }, "Adding photos to album");

  // osxphotos import --album "Album Name" photo1.jpg photo2.jpg ...
  // Note: osxphotos will create the album if it doesn't exist
  const args = [
    "import",
    "--album",
    albumName,
    ...photoPaths,
  ];

  log.debug({ command: "osxphotos", args: args.slice(0, 3), photoCount: photoPaths.length }, "Running osxphotos");

  const { stdout, stderr, code } = await runOsxphotos(args);

  log.debug({ albumName, code, stdout: stdout.slice(0, 200), stderr: stderr.slice(0, 200) }, "osxphotos completed");

  if (code === 0) {
    // Parse output to count added photos
    // osxphotos outputs something like "Added 5 photos to album 'Album Name'"
    const match = stdout.match(/Added (\d+) photos?/i);
    if (match) {
      result.photosAdded = parseInt(match[1], 10);
    } else {
      // Assume all photos were added if no count in output
      result.photosAdded = photoPaths.length;
    }
    log.info({ albumName, photosAdded: result.photosAdded }, "Photos added to album");
  } else {
    log.error({ albumName, code, stderr }, "Failed to add photos to album");
    result.errors.push(stderr || "Failed to add photos to album");
  }

  return result;
}

export async function createAlbumsForPeople(
  personPhotos: Map<string, string[]>,
  albumPrefix: string,
  dryRun: boolean = false,
  suffix: string = ""
): Promise<AlbumResult[]> {
  const results: AlbumResult[] = [];

  for (const [personName, photos] of personPhotos) {
    const albumName = suffix
      ? `${albumPrefix}: ${personName} ${suffix}`
      : `${albumPrefix}: ${personName}`;

    if (dryRun) {
      results.push({
        albumName,
        photosAdded: photos.length,
        errors: [],
      });
      continue;
    }

    const result = await addPhotosToAlbum(albumName, photos);
    results.push(result);
  }

  return results;
}

export interface AlbumPhoto {
  uuid: string;
  filename: string;
  path: string;
}

export async function getAlbumPhotos(albumName: string): Promise<AlbumPhoto[]> {
  log.debug({ albumName }, "Getting photos from album");

  const args = [
    "query",
    "--album",
    albumName,
    "--json",
  ];

  const { stdout, stderr, code } = await runOsxphotos(args);

  if (code !== 0) {
    log.error({ albumName, stderr }, "Failed to query album");
    return [];
  }

  try {
    const photos = JSON.parse(stdout);
    log.debug({ albumName, count: photos.length }, "Found photos in album");
    return photos.map((p: any) => ({
      uuid: p.uuid,
      filename: p.filename,
      path: p.path,
    }));
  } catch (error) {
    log.error({ albumName, error }, "Failed to parse album photos");
    return [];
  }
}

export async function deleteAlbum(albumName: string): Promise<boolean> {
  log.debug({ albumName }, "Deleting album");

  // Use AppleScript to delete the album
  const script = `tell application "Photos" to delete album "${albumName}"`;
  const { code, stderr } = await runCommand("osascript", ["-e", script]);

  if (code !== 0) {
    log.error({ albumName, stderr }, "Failed to delete album");
    return false;
  }

  log.info({ albumName }, "Album deleted");
  return true;
}
