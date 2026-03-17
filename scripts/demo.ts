#!/usr/bin/env npx tsx

import * as readline from "node:readline/promises";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";

import type { TicketEvent, TriageResult, AgentReview, SpecialistReview } from "../src/types";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Ticket scenarios
// ---------------------------------------------------------------------------

const TICKETS: Record<string, { event: TicketEvent; mock: TriageResult }> = {
  standard: {
    event: {
      ticketId: "TKT-001",
      customerId: "CUST-123",
      customerTier: "pro",
      subject: "Cannot export CSV reports",
      body: "When I click the export button, nothing happens. I've tried Chrome and Firefox. This is blocking our end-of-month reporting. Please help.",
      contactEmail: "customer@example.com",
    },
    mock: {
      category: "technical",
      priority: "high",
      sentiment: "frustrated",
      suggestedResponse:
        "Hi, thank you for reaching out about the CSV export issue. We've identified this as a known issue affecting the export module and a fix is currently being deployed. You should see it working within the next hour. In the meantime, you can use the API endpoint GET /api/reports/export as a workaround. We apologize for the inconvenience to your end-of-month reporting.",
      needsEscalation: false,
      escalationReason: null,
      summary: "Customer unable to export CSV reports across multiple browsers, blocking monthly reporting.",
    },
  },
  escalation: {
    event: {
      ticketId: "TKT-002",
      customerId: "CUST-456",
      customerTier: "enterprise",
      subject: "Unauthorized access to our account",
      body: "We noticed login activity from an IP address we don't recognize (203.0.113.42). Multiple admin-level actions were performed between 2am and 4am. We need immediate investigation. This may be a security breach.",
      contactEmail: "security@enterprise.com",
    },
    mock: {
      category: "technical",
      priority: "critical",
      sentiment: "frustrated",
      suggestedResponse:
        "Thank you for reporting this immediately. We take security concerns very seriously. We have flagged your account for priority investigation and our security team will be reaching out shortly. In the meantime, we recommend rotating all API keys and reviewing your team's access permissions. We will provide a full incident report within 24 hours.",
      needsEscalation: true,
      escalationReason: "Security concern: unauthorized access from unrecognized IP with admin-level actions on enterprise account.",
      summary: "Enterprise customer reporting potential unauthorized access from unrecognized IP address with admin-level activity.",
    },
  },
  billing: {
    event: {
      ticketId: "TKT-003",
      customerId: "CUST-789",
      customerTier: "free",
      subject: "Charged twice for upgrade",
      body: "I upgraded to Pro yesterday but I see two charges of $29 on my credit card. Can you refund the duplicate? My transaction IDs are TXN-44821 and TXN-44823.",
      contactEmail: "user@gmail.com",
    },
    mock: {
      category: "billing",
      priority: "medium",
      sentiment: "neutral",
      suggestedResponse:
        "Thank you for bringing this to our attention. I can see the two transactions you referenced (TXN-44821 and TXN-44823). I've flagged the duplicate charge for review by our billing team. You should see the refund processed within 3-5 business days. We apologize for the inconvenience.",
      needsEscalation: false,
      escalationReason: null,
      summary: "Customer charged twice for Pro upgrade, requesting refund of duplicate charge.",
    },
  },
};

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

const RULE = "─".repeat(60);
const HEAVY_RULE = "═".repeat(60);

function printHeader(): void {
  console.log();
  console.log(c.bold("  Durable Support Triage — Interactive Demo"));
  console.log(c.dim("  AWS Lambda Durable Functions + Amazon Bedrock"));
  console.log();
}

function printTicket(ticket: TicketEvent): void {
  console.log(`  ${c.cyan(RULE)}`);
  console.log(`  ${c.cyan("Ticket")} ${c.bold(ticket.ticketId)}`);
  console.log(`  ${c.dim("Customer:")}  ${ticket.customerId} (${ticket.customerTier})`);
  console.log(`  ${c.dim("Email:")}     ${ticket.contactEmail}`);
  console.log(`  ${c.dim("Subject:")}   ${ticket.subject}`);
  console.log(`  ${c.dim("Body:")}      ${ticket.body}`);
  console.log(`  ${c.cyan(RULE)}`);
  console.log();
}

function printStep(name: string, detail?: string): void {
  console.log(`  ${c.blue("▶")} ${c.bold(`step: ${name}`)}`);
  if (detail) console.log(`    ${c.dim(detail)}`);
}

function printSuspend(name: string): void {
  console.log(`  ${c.yellow("⏸")} ${c.bold(`waitForCallback: ${name}`)}`);
  console.log(`    ${c.yellow("Function suspended. Compute charges stopped.")}`);
  console.log();
}

function printResume(name: string): void {
  console.log(`    ${c.green("✓")} ${c.bold(`Callback received: ${name}. Function resumed.`)}`);
  console.log();
}

function printCheckpoint(name: string, durationMs: number): void {
  console.log(`    ${c.green("✓")} ${c.dim(`Checkpointed ${name} (${durationMs}ms)`)}`);
}

function printParallel(name: string, branches: string[]): void {
  console.log(`  ${c.blue("▶")} ${c.bold(`parallel: ${name}`)}`);
  for (let i = 0; i < branches.length; i++) {
    const prefix = i < branches.length - 1 ? "├─" : "└─";
    console.log(`    ${prefix} ${c.green("✓")} ${branches[i]}`);
  }
  console.log();
}

function printAnalysis(analysis: TriageResult): void {
  console.log(`  ${c.cyan(RULE)}`);
  console.log(`  ${c.cyan("AI Triage Result")}`);
  console.log(`  ${c.dim("Category:")}    ${analysis.category}`);
  console.log(`  ${c.dim("Priority:")}    ${priorityColor(analysis.priority)}`);
  console.log(`  ${c.dim("Sentiment:")}   ${sentimentColor(analysis.sentiment)}`);
  console.log(`  ${c.dim("Escalation:")}  ${analysis.needsEscalation ? c.red("Yes") : c.green("No")}`);
  if (analysis.needsEscalation && analysis.escalationReason) {
    console.log(`  ${c.dim("Reason:")}      ${analysis.escalationReason}`);
  }
  console.log(`  ${c.dim("Summary:")}     ${analysis.summary}`);
  console.log();
  console.log(`  ${c.dim("Suggested Response:")}`);
  wrapText(analysis.suggestedResponse, 56).forEach((line) => {
    console.log(`  ${line}`);
  });
  console.log(`  ${c.cyan(RULE)}`);
  console.log();
}

function printResult(result: {
  status: string;
  ticketId: string;
  category: string;
  priority: string;
  finalResponse: string;
}): void {
  console.log();
  console.log(`  ${c.bold(HEAVY_RULE)}`);
  console.log(`  ${c.bold("RESULT")}`);
  console.log();
  const statusColor = result.status === "resolved" ? c.green : result.status === "escalated" ? c.yellow : c.red;
  console.log(`  ${c.dim("Status:")}    ${statusColor(result.status)}`);
  console.log(`  ${c.dim("Ticket:")}    ${result.ticketId}`);
  console.log(`  ${c.dim("Category:")}  ${result.category}`);
  console.log(`  ${c.dim("Priority:")}  ${priorityColor(result.priority)}`);
  if (result.finalResponse) {
    console.log();
    console.log(`  ${c.dim("Final Response:")}`);
    wrapText(result.finalResponse, 56).forEach((line) => {
      console.log(`  ${line}`);
    });
  }
  console.log(`  ${c.bold(HEAVY_RULE)}`);
  console.log();
}

function printRoleHeader(role: string): void {
  console.log(`  ${c.magenta(HEAVY_RULE)}`);
  console.log(`  ${c.magenta(c.bold(role))}`);
  console.log(`  ${c.magenta(HEAVY_RULE)}`);
  console.log();
}

function priorityColor(p: string): string {
  if (p === "critical") return c.red(p);
  if (p === "high") return c.yellow(p);
  return p;
}

function sentimentColor(s: string): string {
  if (s === "frustrated") return c.red(s);
  if (s === "positive") return c.green(s);
  return s;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > width) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askYesNo(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await rl.question(`  ${c.yellow("?")} ${question} (${hint}) `);
  if (!answer.trim()) return defaultYes;
  return answer.trim().toLowerCase().startsWith("y");
}

async function askChoice(rl: readline.Interface, prompt: string, options: string[]): Promise<number> {
  console.log(`  ${prompt}`);
  options.forEach((opt, i) => console.log(`    ${c.bold(`${i + 1}.`)} ${opt}`));
  console.log();
  const answer = await rl.question(`  ${c.yellow(">")} `);
  const choice = parseInt(answer.trim(), 10);
  if (choice >= 1 && choice <= options.length) return choice - 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Local mode
// ---------------------------------------------------------------------------

async function runLocal(
  scenario: string,
  ticket: TicketEvent,
  mock: TriageResult,
  rl: readline.Interface
): Promise<void> {
  console.log(`  ${c.dim(`Mode: local (mocked) | Scenario: ${scenario}`)}`);
  console.log();

  // Ticket received
  console.log(`  ${c.blue("▶")} ${c.bold("Ticket received")}`);
  printTicket(ticket);

  // Step 1: AI analysis
  printStep("analyze-ticket", "Calling Amazon Bedrock with RISEN prompt...");
  await sleep(1500);
  printCheckpoint("analyze-ticket", 1247);
  console.log();
  printAnalysis(mock);

  // Step 2: Agent review callback
  printSuspend("agent-review");
  printRoleHeader("YOU ARE THE SUPPORT AGENT");

  const approved = await askYesNo(rl, "Approve this response?");
  let editedResponse = "";
  let agentNotes = "";

  if (approved) {
    const wantEdit = await askYesNo(rl, "Edit the response before sending?", false);
    if (wantEdit) {
      editedResponse = await rl.question(`  ${c.yellow(">")} New response: `);
    }
    agentNotes = await rl.question(`  ${c.yellow(">")} Agent notes (optional): `);
  } else {
    agentNotes = await rl.question(`  ${c.yellow(">")} Rejection reason: `);
  }

  console.log();
  printResume("agent-review");

  const finalResponse = editedResponse || mock.suggestedResponse;

  // Rejection path
  if (!approved) {
    console.log(`  ${c.red("▶")} ${c.bold("Agent rejected. Workflow ending.")}`);
    printResult({
      status: "rejected",
      ticketId: ticket.ticketId,
      category: mock.category,
      priority: mock.priority,
      finalResponse: "",
    });
    return;
  }

  // Step 3: Specialist escalation
  let resolvedResponse = finalResponse;
  if (mock.needsEscalation) {
    printSuspend("specialist-review");
    printRoleHeader("YOU ARE THE SPECIALIST");

    console.log(`  ${c.dim("Escalation Reason:")} ${mock.escalationReason}`);
    console.log(`  ${c.dim("Agent Notes:")}       ${agentNotes || "(none)"}`);
    console.log();

    const specialistInput = await rl.question(`  ${c.yellow(">")} Specialist response: `);
    const _specialistNotes = await rl.question(`  ${c.yellow(">")} Specialist notes (optional): `);
    void _specialistNotes; // Captured for interactive parity with cloud mode
    if (specialistInput.trim()) {
      resolvedResponse = specialistInput;
    }

    console.log();
    printResume("specialist-review");
  }

  // Step 4: Parallel close
  await sleep(300);
  printParallel(mock.needsEscalation ? "close-escalated-ticket" : "close-ticket", [
    "send-reply: Customer reply sent",
    "send-survey: Satisfaction survey sent",
  ]);

  // Result
  printResult({
    status: mock.needsEscalation ? "escalated" : "resolved",
    ticketId: ticket.ticketId,
    category: mock.category,
    priority: mock.priority,
    finalResponse: resolvedResponse,
  });
}

// ---------------------------------------------------------------------------
// Cloud mode
// ---------------------------------------------------------------------------

const awsFlags: string[] = [];
let cloudFunctionName: string | undefined;

function readFunctionNameFromTemplate(): string {
  const templatePath = resolve(process.cwd(), "template.yaml");
  const content = readFileSync(templatePath, "utf-8");
  const nameMatch = content.match(/FunctionName:\s*(.+)/);
  const aliasMatch = content.match(/AutoPublishAlias:\s*(.+)/);
  const name = nameMatch?.[1].trim();
  const alias = aliasMatch?.[1].trim();
  if (!name) throw new Error("Could not find FunctionName in template.yaml");
  return alias ? `${name}:${alias}` : name;
}

function cli(command: string): string {
  const fullCommand = command.startsWith("aws ")
    ? `${command} ${awsFlags.join(" ")}`
    : command;
  try {
    return execSync(fullCommand, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    throw new Error(error.stderr || error.message || "CLI command failed");
  }
}

// Escapes single quotes for POSIX shell. Sufficient for JSON payloads but
// does not handle backslashes, newlines, or null bytes in arbitrary input.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function cliJson<T>(command: string): T {
  return JSON.parse(cli(command)) as T;
}

async function runCloud(
  scenario: string,
  ticket: TicketEvent,
  rl: readline.Interface
): Promise<void> {
  console.log(`  ${c.dim(`Mode: cloud | Scenario: ${scenario}`)}`);
  console.log();

  const functionName = cloudFunctionName ?? readFunctionNameFromTemplate();
  const executionName = `demo-${ticket.ticketId}-${Date.now()}`;

  // Verify function exists
  console.log(`  ${c.blue("▶")} ${c.bold("Checking deployed function...")}`);
  try {
    cli(`aws lambda get-function --function-name ${functionName} --query 'Configuration.FunctionName' --output text`);
    console.log(`    ${c.green("✓")} ${c.dim("Function found: " + functionName)}`);
  } catch {
    console.log(`    ${c.red("✗")} Function ${functionName} not found.`);
    console.log(`    ${c.dim("Deploy first: sam build && sam deploy --guided")}`);
    return;
  }

  // Show ticket
  console.log();
  console.log(`  ${c.blue("▶")} ${c.bold("Invoking durable execution")}`);
  printTicket(ticket);

  // Invoke
  try {
    cli(
      `aws lambda invoke --function-name ${functionName} --invocation-type Event ` +
      `--durable-execution-name "${executionName}" ` +
      `--cli-binary-format raw-in-base64-out ` +
      `--payload ${shellQuote(JSON.stringify(ticket))} /dev/null`
    );
    console.log(`    ${c.green("✓")} ${c.dim(`Execution started: ${executionName}`)}`);
  } catch (err) {
    console.log(`    ${c.red("✗")} Invocation failed: ${(err as Error).message}`);
    return;
  }

  // Find execution ARN
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const isTTY = process.stdout.isTTY;
  if (isTTY) {
    process.stdout.write(`    ${c.dim("Finding execution ARN...")} `);
  } else {
    console.log(`    ${c.dim("Finding execution ARN...")}`);
  }
  await sleep(2000);

  const baseFunctionName = functionName.split(":")[0];
  let executionArn = "";
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const result = cliJson<{ DurableExecutions?: Array<{ DurableExecutionArn: string; DurableExecutionName: string }> }>(
        `aws lambda list-durable-executions-by-function --function-name ${baseFunctionName} --output json`
      );
      const execution = result.DurableExecutions?.find((e) => e.DurableExecutionName === executionName);
      if (execution) {
        executionArn = execution.DurableExecutionArn;
        break;
      }
    } catch {
      // API might not be ready yet
    }
    if (isTTY) {
      process.stdout.write(`\r    ${c.dim("Finding execution ARN...")} ${c.dim(SPINNER[attempt % SPINNER.length])} `);
    }
    await sleep(2000);
  }

  if (isTTY) {
    process.stdout.write("\r" + " ".repeat(50) + "\r");
  }
  if (!executionArn) {
    console.log(`    ${c.red("✗")} Could not find execution. Check the Lambda console.`);
    return;
  }
  console.log(`    ${c.green("✓")} ${c.dim(`ARN: ${executionArn}`)}`);

  const arnRegion = executionArn.split(":")[3];
  const logGroup = `/aws/lambda/${baseFunctionName}`;
  const encodedLogGroup = logGroup.replace(/\//g, "$252F");
  const logsUrl = `https://${arnRegion}.console.aws.amazon.com/cloudwatch/home?region=${arnRegion}#logsV2:log-groups/log-group/${encodedLogGroup}`;
  console.log(`    ${c.dim(`Logs: ${logsUrl}`)}`);

  // Poll and interact
  await pollAndInteract(executionArn, functionName, ticket, rl);
}

interface HistoryEvent {
  EventType: string;
  SubType?: string;
  Id: string;
  Name?: string;
  ParentId?: string;
  EventTimestamp?: string;
  CallbackStartedDetails?: { CallbackId: string };
  StepSucceededDetails?: { Result?: { Payload?: string } };
}

function findAnalysis(events: HistoryEvent[]): TriageResult | null {
  const event = events.find(
    (e) => e.EventType === "StepSucceeded" && e.Name === "analyze-ticket"
  );
  const payload = event?.StepSucceededDetails?.Result?.Payload;
  if (!payload) return null;
  try { return JSON.parse(payload) as TriageResult; } catch { return null; }
}

function findPendingCallbacks(
  events: HistoryEvent[],
  handledCallbacks: Set<string>
): Array<{ name: string; callbackId: string }> {
  const startedCallbacks = new Map<string, { callbackId: string; parentId: string }>();
  const completedCallbackIds = new Set<string>();
  const contextNames = new Map<string, string>();

  for (const event of events) {
    if (event.EventType === "ContextStarted" && event.Name) {
      contextNames.set(event.Id, event.Name);
    }
    if (event.EventType === "CallbackStarted" && event.CallbackStartedDetails?.CallbackId) {
      startedCallbacks.set(event.Id, {
        callbackId: event.CallbackStartedDetails.CallbackId,
        parentId: event.ParentId || "",
      });
    }
    if (event.EventType === "CallbackSucceeded" || event.EventType === "CallbackFailed") {
      completedCallbackIds.add(event.Id);
    }
  }

  const pending: Array<{ name: string; callbackId: string }> = [];
  for (const [id, { callbackId, parentId }] of startedCallbacks) {
    if (!completedCallbackIds.has(id) && !handledCallbacks.has(callbackId)) {
      pending.push({ name: contextNames.get(parentId) || "unknown", callbackId });
    }
  }
  return pending;
}

function findStepTiming(events: HistoryEvent[], stepName: string): number | null {
  let startTime: number | null = null;
  let endTime: number | null = null;
  for (const event of events) {
    if (event.Name !== stepName) continue;
    const ts = event.EventTimestamp ? new Date(event.EventTimestamp).getTime() : null;
    if (event.EventType === "StepStarted" && ts) startTime = ts;
    if (event.EventType === "StepSucceeded" && ts) endTime = ts;
  }
  return startTime && endTime ? endTime - startTime : null;
}

function findParallelBranches(events: HistoryEvent[]): string[] {
  const parallelContexts = new Set<string>();
  const branchNames: string[] = [];
  for (const event of events) {
    if (event.EventType === "ContextStarted" && event.SubType === "Parallel" && event.Name) {
      parallelContexts.add(event.Id);
    }
  }
  for (const event of events) {
    if (event.EventType === "ContextStarted" && event.ParentId && parallelContexts.has(event.ParentId) && event.Name) {
      branchNames.push(event.Name);
    }
  }
  return branchNames;
}

async function pollAndInteract(
  executionArn: string,
  functionName: string,
  ticket: TicketEvent,
  rl: readline.Interface
): Promise<void> {
  const handledCallbacks = new Set<string>();
  let shownStep = false;

  for (let poll = 0; poll < 120; poll++) {
    await sleep(3000);

    let execution: { Status: string; Result?: string };

    try {
      execution = cliJson(
        `aws lambda get-durable-execution --durable-execution-arn "${executionArn}" --output json`
      );
    } catch {
      continue;
    }

    // Fetch history when running or just completed
    let historyEvents: HistoryEvent[] = [];
    let pendingCallbacks: Array<{ name: string; callbackId: string }> = [];
    try {
      const history = cliJson<{ Events: HistoryEvent[] }>(
        `aws lambda get-durable-execution-history --durable-execution-arn "${executionArn}" --include-execution-data --output json`
      );
      historyEvents = history.Events;
      if (execution.Status === "RUNNING") {
        pendingCallbacks = findPendingCallbacks(historyEvents, handledCallbacks);
      }
    } catch {
      // History not available yet
    }

    // Show the analyze-ticket step once we see it in history
    if (!shownStep && historyEvents.some((e) => e.EventType === "StepSucceeded" && e.Name === "analyze-ticket")) {
      const durationMs = findStepTiming(historyEvents, "analyze-ticket");
      console.log();
      printStep("analyze-ticket", "Bedrock AI analysis with retry strategy");
      printCheckpoint("analyze-ticket", durationMs ?? 0);
      console.log();
      shownStep = true;
    }

    if (pendingCallbacks.length > 0) {
      for (const cb of pendingCallbacks) {
        if (cb.name === "agent-review") {
          const analysis = findAnalysis(historyEvents);
          if (analysis) {
            printAnalysis(analysis);
          }

          printSuspend("agent-review");
          printRoleHeader("YOU ARE THE SUPPORT AGENT");

          const approved = await askYesNo(rl, "Approve this response?");
          let editedResponse = "";
          let agentNotes = "";

          if (approved) {
            const wantEdit = await askYesNo(rl, "Edit the response before sending?", false);
            if (wantEdit) {
              editedResponse = await rl.question(`  ${c.yellow(">")} New response: `);
            }
            agentNotes = await rl.question(`  ${c.yellow(">")} Agent notes (optional): `);
          } else {
            agentNotes = await rl.question(`  ${c.yellow(">")} Rejection reason: `);
          }

          const review: AgentReview = { approved, editedResponse, agentNotes };

          try {
            cli(
              `aws lambda send-durable-execution-callback-success ` +
              `--callback-id "${cb.callbackId}" ` +
              `--cli-binary-format raw-in-base64-out ` +
              `--result ${shellQuote(JSON.stringify(review))}`
            );
            console.log();
            printResume("agent-review");
          } catch (err) {
            console.log(`    ${c.red("✗")} Failed to send callback: ${(err as Error).message}`);
          }

          handledCallbacks.add(cb.callbackId);
        } else if (cb.name === "specialist-review") {
          printSuspend("specialist-review");
          printRoleHeader("YOU ARE THE SPECIALIST");

          const analysis = findAnalysis(historyEvents);
          if (analysis?.escalationReason) {
            console.log(`  ${c.dim("Escalation Reason:")} ${analysis.escalationReason}`);
            console.log();
          }

          const specialistResponse = await rl.question(`  ${c.yellow(">")} Specialist response: `);
          const specialistNotes = await rl.question(`  ${c.yellow(">")} Specialist notes (optional): `);

          const review: SpecialistReview = { response: specialistResponse, notes: specialistNotes };

          try {
            cli(
              `aws lambda send-durable-execution-callback-success ` +
              `--callback-id "${cb.callbackId}" ` +
              `--cli-binary-format raw-in-base64-out ` +
              `--result ${shellQuote(JSON.stringify(review))}`
            );
            console.log();
            printResume("specialist-review");
          } catch (err) {
            console.log(`    ${c.red("✗")} Failed to send callback: ${(err as Error).message}`);
          }

          handledCallbacks.add(cb.callbackId);
        }
      }
    }

    // Check terminal states
    if (execution.Status === "SUCCEEDED") {
      // Show parallel step from history
      const branches = findParallelBranches(historyEvents);
      if (branches.length > 0) {
        printParallel("close-ticket", branches.map((name) => `${name}: Done`));
      }

      console.log(`  ${c.green("▶")} ${c.bold("Execution completed successfully")}`);
      if (execution.Result) {
        try {
          const result = JSON.parse(execution.Result);
          printResult(result);
        } catch {
          console.log(`  ${c.dim("Result:")} ${execution.Result}`);
        }
      }
      return;
    }

    if (execution.Status === "FAILED" || execution.Status === "TIMED_OUT" || execution.Status === "STOPPED") {
      console.log();
      console.log(`  ${c.red("▶")} ${c.bold(`Execution ${execution.Status}`)}`);
      return;
    }
  }

  console.log();
  console.log(`  ${c.yellow("⚠")} Polling timed out. Check the Lambda console for execution status.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isCloud = args.includes("--cloud");
  const ticketArg = args.find((a) => a.startsWith("--ticket="))?.split("=")[1];
  const profileArg = args.find((a) => a.startsWith("--profile="))?.split("=")[1];
  const regionArg = args.find((a) => a.startsWith("--region="))?.split("=")[1];
  const functionNameArg = args.find((a) => a.startsWith("--function-name="))?.split("=")[1];

  if (profileArg) awsFlags.push(`--profile ${profileArg}`);
  if (regionArg) awsFlags.push(`--region ${regionArg}`);
  if (functionNameArg) cloudFunctionName = functionNameArg;

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    printHeader();

    // Select mode if not specified
    let mode: "local" | "cloud";
    if (isCloud) {
      mode = "cloud";
    } else if (args.includes("--local")) {
      mode = "local";
    } else {
      const modeChoice = await askChoice(rl, "Select a mode:", [
        "Local (mocked, no AWS needed)",
        "Cloud (real Lambda + Bedrock, requires deployment)",
      ]);
      mode = modeChoice === 0 ? "local" : "cloud";
      console.log();
    }

    // Prompt for AWS config when cloud mode is selected interactively
    if (mode === "cloud" && !profileArg && !regionArg) {
      const profile = await rl.question(`  ${c.yellow(">")} AWS profile ${c.dim("(leave empty for default)")}: `);
      const region = await rl.question(`  ${c.yellow(">")} AWS region ${c.dim("(leave empty for default)")}: `);
      if (profile.trim()) awsFlags.push(`--profile ${profile.trim()}`);
      if (region.trim()) awsFlags.push(`--region ${region.trim()}`);
      console.log();
    }

    // Select ticket
    let scenario: string;
    if (ticketArg && TICKETS[ticketArg]) {
      scenario = ticketArg;
    } else {
      const ticketChoice = await askChoice(rl, "Select a ticket scenario:", [
        `Standard bug report ${c.dim("(pro customer, no escalation)")}`,
        `Security concern ${c.dim("(enterprise, triggers escalation)")}`,
        `Billing question ${c.dim("(free tier, no escalation)")}`,
      ]);
      scenario = ["standard", "escalation", "billing"][ticketChoice];
      console.log();
    }

    const { event, mock } = TICKETS[scenario];

    if (mode === "local") {
      await runLocal(scenario, event, mock, rl);
    } else {
      await runCloud(scenario, event, rl);
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
