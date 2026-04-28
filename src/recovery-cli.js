const { runRecoveryWithOptions } = require("./services/recovery-service");

const args = process.argv.slice(2);

function parseArgs() {
  const options = {
    dryRun: true,
    logFilePath: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === "--real" || arg === "-r") {
      options.dryRun = false;
    } else if (arg === "--dry-run" || arg === "-d") {
      options.dryRun = true;
    } else if (arg === "--log" || arg === "-l") {
      if (i + 1 < args.length) {
        options.logFilePath = args[i + 1];
        i++;
      }
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
CatRank Event Log Recovery Tool
================================

Usage: node src/recovery-cli.js [options]

Options:
  --dry-run, -d    Run in simulation mode (default)
  --real, -r       Perform actual recovery
  --log, -l        Specify custom log file path
  --help, -h       Show this help message

Examples:
  node src/recovery-cli.js --dry-run
  node src/recovery-cli.js --real
  node src/recovery-cli.js --real --log /path/to/custom/events.log

Description:
  This tool recovers session data and leaderboard entries from the event log.
  It can detect and report:
  - Corrupted log lines
  - Duplicate events
  - State conflicts
  - Session file loss

  In dry-run mode, no changes are made to the actual data files.
  Use --real mode to actually perform the recovery.
`);
}

function formatReport(report) {
  const lines = [];
  
  lines.push("=");
  lines.push("  EVENT LOG RECOVERY REPORT");
  lines.push("=");
  lines.push("");
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Mode: ${report.dryRun ? "DRY-RUN (Simulation)" : "REAL (Actual Recovery)"}`);
  lines.push("");
  
  if (report.error) {
    lines.push("ERROR:");
    lines.push(`  Message: ${report.error.message}`);
    if (report.error.error) {
      lines.push(`  Details: ${report.error.error}`);
    }
    lines.push("");
    return lines.join("\n");
  }

  lines.push("SUMMARY:");
  lines.push(`  Total Sessions in Log:  ${report.summary.totalSessions}`);
  lines.push(`  Recovered:              ${report.summary.recovered}`);
  lines.push(`  Skipped (up-to-date):   ${report.summary.skipped}`);
  lines.push(`  Failed:                 ${report.summary.failed}`);
  lines.push("");
  lines.push(`  Corrupted Lines:        ${report.summary.corruptedLines}`);
  lines.push(`  Duplicate Events:       ${report.summary.duplicateEvents}`);
  lines.push(`  State Conflicts:        ${report.summary.stateConflicts}`);
  lines.push("");

  if (report.details.sessions.length > 0) {
    lines.push("SESSION DETAILS:");
    lines.push("");
    
    for (const sr of report.details.sessions) {
      const statusSymbol = sr.recoveryAction === "failed" ? "[FAILED]" : 
                          sr.recoveryAction.startsWith("would") ? "[SIMULATED]" : 
                          sr.recoveryAction === "skipped_up_to_date" ? "[SKIPPED]" : "[OK]";
      
      lines.push(`  ${statusSymbol} Session: ${sr.sessionId}`);
      lines.push(`    Player: ${sr.playerName}`);
      lines.push(`    State: ${sr.state || "N/A"}`);
      lines.push(`    Events: ${sr.eventCount}`);
      lines.push(`    Action: ${sr.recoveryAction}`);
      
      if (sr.issues.length > 0) {
        lines.push(`    Issues:`);
        for (const issue of sr.issues) {
          lines.push(`      - [${issue.type}] ${issue.message}`);
        }
      }
      
      if (sr.warnings.length > 0) {
        lines.push(`    Warnings:`);
        for (const warning of sr.warnings) {
          lines.push(`      - [${warning.type}] ${warning.message}`);
        }
      }
      lines.push("");
    }
  }

  if (report.details.corruptedLines.length > 0) {
    lines.push("CORRUPTED LINES:");
    for (const cl of report.details.corruptedLines) {
      const rawPreview = cl.raw ? cl.raw.substring(0, 80) + (cl.raw.length > 80 ? "..." : "") : "(unable to parse)";
      lines.push(`  Line ${cl.lineNumber}: [${cl.errorType}] ${cl.error}`);
      lines.push(`    Preview: ${rawPreview}`);
    }
    lines.push("");
  }

  if (report.details.duplicateEvents.length > 0) {
    lines.push("DUPLICATE EVENTS:");
    for (const de of report.details.duplicateEvents) {
      if (de.existingLine) {
        lines.push(`  Session ${de.sessionId}: Event ${de.eventId} at line ${de.lineNumber} duplicates line ${de.existingLine}`);
      } else {
        lines.push(`  Session ${de.sessionId}: Event ${de.eventId} at line ${de.lineNumber} is duplicate`);
      }
    }
    lines.push("");
  }

  if (report.dryRun) {
    lines.push("NOTE: This was a DRY-RUN. No changes were made.");
    lines.push("      Use --real flag to perform actual recovery.");
  } else {
    lines.push("NOTE: Recovery completed. Changes have been persisted.");
  }

  lines.push("");
  lines.push("=");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const options = parseArgs();
  
  console.log("");
  console.log("Starting event log recovery...");
  console.log(`Mode: ${options.dryRun ? "DRY-RUN" : "REAL"}`);
  if (options.logFilePath) {
    console.log(`Log file: ${options.logFilePath}`);
  }
  console.log("");

  try {
    const report = await runRecoveryWithOptions(options);
    console.log(formatReport(report));
    
    if (report.error || report.summary.failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error("Fatal error during recovery:");
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
