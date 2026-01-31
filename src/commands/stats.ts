import { loadConfig } from "../config";
import {
  initDatabase,
  getAccuracyStats,
  type AccuracyStats,
  type PersonAccuracyStats,
  type ConfidenceBucketStats,
  type SearchMethodStats,
} from "../db";

export async function statsCommand(): Promise<void> {
  initDatabase();
  const config = loadConfig();
  const stats = getAccuracyStats();

  // Check if we have any data
  const totalRecognitions = stats.byPerson.reduce(
    (sum, p) => sum + p.approvedCount + p.rejectedCount + p.pendingCount,
    0
  );

  if (totalRecognitions === 0) {
    console.log("No recognitions found. Run 'openbook scan' first.");
    return;
  }

  if (stats.overall.totalDecisions === 0) {
    console.log("No corrections recorded yet. Use 'openbook photos approve/reject' to review photos.");
    console.log(`\nTotal pending recognitions: ${totalRecognitions}`);
    return;
  }

  console.log("Classification Accuracy Statistics\n");

  // Per-person table
  printPersonTable(stats.byPerson, config.display.columns.personName);

  // Confidence correlation table
  console.log("");
  printConfidenceTable(stats.byConfidence);

  // Search method comparison (only show if there's data for both or users method)
  if (stats.bySearchMethod.length > 0) {
    console.log("");
    printSearchMethodTable(stats.bySearchMethod);
  }

  // Summary
  console.log("\nSummary:");
  const totalPending = stats.byPerson.reduce((sum, p) => sum + p.pendingCount, 0);
  const reviewedPct = totalRecognitions > 0
    ? ((stats.overall.totalDecisions / totalRecognitions) * 100).toFixed(1)
    : "0";
  console.log(`  Total recognitions reviewed: ${stats.overall.totalDecisions} / ${totalRecognitions} (${reviewedPct}%)`);
  console.log(`  Overall approval rate: ${formatRate(stats.overall.approvedCount, stats.overall.rejectedCount)}`);

  if (totalPending > 0) {
    console.log(`  Pending review: ${totalPending}`);
  }
}

function printPersonTable(persons: PersonAccuracyStats[], nameWidth: number): void {
  console.log("Per-Person Accuracy:");

  const headers = ["Person", "Approved", "Rejected", "Pending", "Approval %"];
  const widths = [Math.max(nameWidth, 8), 10, 10, 9, 12];
  const divider = widths.map(w => "─".repeat(w)).join("─");

  console.log(divider);
  console.log(
    headers.map((h, i) => h.padEnd(widths[i])).join(" ")
  );
  console.log(divider);

  // Person rows
  for (const p of persons) {
    const row = [
      truncate(p.personName, widths[0]),
      p.approvedCount.toString(),
      p.rejectedCount.toString(),
      p.pendingCount.toString(),
      formatRate(p.approvedCount, p.rejectedCount),
    ];
    console.log(row.map((v, i) => v.padEnd(widths[i])).join(" "));
  }

  // Total row
  const totalApproved = persons.reduce((s, p) => s + p.approvedCount, 0);
  const totalRejected = persons.reduce((s, p) => s + p.rejectedCount, 0);
  const totalPending = persons.reduce((s, p) => s + p.pendingCount, 0);

  console.log(divider);
  const totalRow = [
    "Total",
    totalApproved.toString(),
    totalRejected.toString(),
    totalPending.toString(),
    formatRate(totalApproved, totalRejected),
  ];
  console.log(totalRow.map((v, i) => v.padEnd(widths[i])).join(" "));
}

function printConfidenceTable(buckets: ConfidenceBucketStats[]): void {
  console.log("Confidence Correlation:");

  const headers = ["Confidence", "Approved", "Rejected", "Pending", "Approval %"];
  const widths = [12, 10, 10, 9, 12];
  const divider = widths.map(w => "─".repeat(w)).join("─");

  console.log(divider);
  console.log(
    headers.map((h, i) => h.padEnd(widths[i])).join(" ")
  );
  console.log(divider);

  for (const b of buckets) {
    const total = b.approvedCount + b.rejectedCount + b.pendingCount;
    if (total === 0) continue; // Skip empty buckets

    const row = [
      b.label,
      b.approvedCount.toString(),
      b.rejectedCount.toString(),
      b.pendingCount.toString(),
      formatRate(b.approvedCount, b.rejectedCount),
    ];
    console.log(row.map((v, i) => v.padEnd(widths[i])).join(" "));
  }
}

function printSearchMethodTable(methods: SearchMethodStats[]): void {
  console.log("Search Method Comparison:");

  const headers = ["Method", "Approved", "Rejected", "Pending", "Approval %"];
  const widths = [10, 10, 10, 9, 12];
  const divider = widths.map(w => "─".repeat(w)).join("─");

  console.log(divider);
  console.log(
    headers.map((h, i) => h.padEnd(widths[i])).join(" ")
  );
  console.log(divider);

  for (const m of methods) {
    const row = [
      m.method,
      m.approvedCount.toString(),
      m.rejectedCount.toString(),
      m.pendingCount.toString(),
      formatRate(m.approvedCount, m.rejectedCount),
    ];
    console.log(row.map((v, i) => v.padEnd(widths[i])).join(" "));
  }
}

function formatRate(approved: number, rejected: number): string {
  const total = approved + rejected;
  if (total === 0) return "-";
  return ((approved / total) * 100).toFixed(1) + "%";
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}
