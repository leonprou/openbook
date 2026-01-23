import { loadConfig } from "../config";
import {
  initDatabase,
  getAllPersons,
  getPerson,
  getAccuracyStats,
  getPersonConfidenceStats,
  getRecentMatchesForPerson,
} from "../db";

interface PersonsListOptions {
  json?: boolean;
}

export async function personsListCommand(options: PersonsListOptions): Promise<void> {
  initDatabase();
  const config = loadConfig();
  const persons = getAllPersons();

  if (persons.length === 0) {
    console.log("No persons found. Run 'claude-book train' first.");
    return;
  }

  const stats = getAccuracyStats();
  const statsMap = new Map(stats.byPerson.map(s => [s.personName, s]));

  if (options.json) {
    const data = persons.map(p => ({
      name: p.name,
      displayName: p.displayName,
      faceCount: p.faceCount,
      photoCount: p.photoCount,
      approvalRate: statsMap.get(p.name)?.approvalRate ?? null,
      trainedAt: p.trainedAt,
    }));
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const nameWidth = Math.max(config.display.columns.personName, 6);
  const headers = ["Name", "Faces", "Photos", "Approval %", "Trained"];
  const widths = [nameWidth, 7, 8, 12, 12];
  const divider = widths.map(w => "\u2500".repeat(w)).join("\u2500");

  console.log("\nPeople:");
  console.log(divider);
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(" "));
  console.log(divider);

  for (const person of persons) {
    const personStats = statsMap.get(person.name);
    const approvalStr = personStats?.approvalRate != null
      ? personStats.approvalRate.toFixed(1) + "%"
      : "-";
    const trainedDate = person.trainedAt
      ? new Date(person.trainedAt).toISOString().split("T")[0]
      : "-";
    const displayName = person.displayName
      ? truncate(person.displayName, nameWidth)
      : truncate(person.name, nameWidth);

    const row = [
      displayName,
      person.faceCount.toString(),
      person.photoCount.toString(),
      approvalStr,
      trainedDate,
    ];
    console.log(row.map((v, i) => v.padEnd(widths[i])).join(" "));
  }

  console.log(divider);
  console.log(`\n${persons.length} person(s) total.`);
}

interface PersonsShowOptions {
  json?: boolean;
}

export async function personsShowCommand(name: string, options: PersonsShowOptions): Promise<void> {
  initDatabase();

  // Case-insensitive lookup
  let person = getPerson(name);
  if (!person) {
    const all = getAllPersons();
    person = all.find(p => p.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  if (!person) {
    console.log(`Person "${name}" not found.`);
    const all = getAllPersons();
    if (all.length > 0) {
      console.log(`Known persons: ${all.map(p => p.name).join(", ")}`);
    }
    return;
  }

  const stats = getAccuracyStats();
  const personStats = stats.byPerson.find(s => s.personName === person!.name);
  const confidenceStats = getPersonConfidenceStats(person.name);
  const recentMatches = getRecentMatchesForPerson(person.name, 5);

  if (options.json) {
    console.log(JSON.stringify({
      ...person,
      recognition: personStats ? {
        approved: personStats.approvedCount,
        rejected: personStats.rejectedCount,
        pending: personStats.pendingCount,
        approvalRate: personStats.approvalRate,
      } : null,
      confidence: confidenceStats,
      recentMatches,
    }, null, 2));
    return;
  }

  console.log(`\nPerson: ${person.name}`);
  console.log();

  if (person.displayName) {
    console.log(`  Display name:  ${person.displayName}`);
  }
  if (person.userId) {
    console.log(`  User ID:       ${person.userId}`);
  }
  if (person.notes) {
    console.log(`  Notes:         ${person.notes}`);
  }

  console.log(`  Trained:       ${person.trainedAt ? new Date(person.trainedAt).toLocaleString() : "-"}`);
  console.log(`  Face count:    ${person.faceCount}`);
  console.log(`  Photo count:   ${person.photoCount}`);

  if (personStats) {
    console.log();
    console.log("Recognition Status:");
    console.log(`  Approved:      ${personStats.approvedCount}`);
    console.log(`  Rejected:      ${personStats.rejectedCount}`);
    console.log(`  Pending:       ${personStats.pendingCount}`);
    const approvalStr = personStats.approvalRate != null
      ? personStats.approvalRate.toFixed(1) + "%"
      : "-";
    console.log(`  Approval rate: ${approvalStr}`);
  }

  if (confidenceStats) {
    console.log();
    console.log("Confidence:");
    console.log(`  Min: ${confidenceStats.min.toFixed(1)}%   Avg: ${confidenceStats.avg.toFixed(1)}%   Max: ${confidenceStats.max.toFixed(1)}%`);
  }

  if (recentMatches.length > 0) {
    console.log();
    console.log("Recent Matches:");
    for (const match of recentMatches) {
      const confStr = `${match.confidence.toFixed(1)}%`.padEnd(7);
      const statusStr = match.status.padEnd(10);
      const dateStr = new Date(match.scannedAt).toISOString().split("T")[0];
      console.log(`  ${confStr} ${statusStr} ${dateStr}  ${match.path}`);
    }
  }

  console.log();
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}
