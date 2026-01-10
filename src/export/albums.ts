import { spawn } from "child_process";

export interface AlbumResult {
  albumName: string;
  photosAdded: number;
  errors: string[];
}

async function runOsxphotos(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn("osxphotos", args, {
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
    return result;
  }

  // osxphotos addalbum --album "Album Name" photo1.jpg photo2.jpg ...
  // Note: osxphotos will create the album if it doesn't exist
  const args = [
    "addalbum",
    "--album",
    albumName,
    ...photoPaths,
  ];

  const { stdout, stderr, code } = await runOsxphotos(args);

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
  } else {
    result.errors.push(stderr || "Failed to add photos to album");
  }

  return result;
}

export async function createAlbumsForPeople(
  personPhotos: Map<string, string[]>,
  albumPrefix: string,
  dryRun: boolean = false
): Promise<AlbumResult[]> {
  const results: AlbumResult[] = [];

  for (const [personName, photos] of personPhotos) {
    const albumName = `${albumPrefix}: ${personName}`;

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
