import {
  withDurableExecution,
  DurableContext,
  createRetryStrategy,
  JitterStrategy,
  defaultSerdes,
} from "@aws/durable-execution-sdk-js";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { TicketEvent, TriageResult, AgentReview, SpecialistReview, TicketResolution } from "./types";

const bedrock = new BedrockRuntimeClient();

const VALID_TIERS = new Set(["free", "pro", "enterprise"]);

function validateEvent(event: TicketEvent): void {
  if (!event.ticketId || typeof event.ticketId !== "string") {
    throw new Error("Missing or invalid ticketId");
  }
  if (!event.customerId || typeof event.customerId !== "string") {
    throw new Error("Missing or invalid customerId");
  }
  if (!event.customerTier || !VALID_TIERS.has(event.customerTier)) {
    throw new Error(`Invalid customerTier: ${event.customerTier}`);
  }
  if (!event.subject || typeof event.subject !== "string") {
    throw new Error("Missing or invalid subject");
  }
  if (!event.body || typeof event.body !== "string") {
    throw new Error("Missing or invalid body");
  }
  if (!event.contactEmail || typeof event.contactEmail !== "string") {
    throw new Error("Missing or invalid contactEmail");
  }
}

const TRIAGE_SYSTEM_PROMPT = `
# Role
You are a senior technical support analyst with 10 years of experience
triaging customer support tickets for a SaaS platform. You specialize in
categorizing issues by severity, identifying root causes, and drafting
professional responses.

# Instructions
Analyze the incoming support ticket and produce a structured triage
assessment with category, priority, sentiment, a suggested response,
and an escalation recommendation.

# Steps
1. Read the ticket subject and body to identify the core issue.
2. Categorize the issue (billing, technical, account, feature-request, other).
3. Assess priority based on business impact and urgency (critical, high, medium, low).
4. Evaluate customer sentiment (frustrated, neutral, positive).
5. Draft a suggested response that acknowledges the issue and outlines next steps.
6. Determine whether the ticket needs specialist escalation.

# Expectation
Return a JSON object with this exact structure:
{
  "category": "billing" | "technical" | "account" | "feature-request" | "other",
  "priority": "critical" | "high" | "medium" | "low",
  "sentiment": "frustrated" | "neutral" | "positive",
  "suggestedResponse": "string",
  "needsEscalation": boolean,
  "escalationReason": "string or null",
  "summary": "One-sentence summary of the issue"
}

# Narrowing
- Return only raw JSON. Do not wrap it in markdown code fences, backticks,
  or any other formatting. No explanation, no preamble, no commentary.
- Do not fabricate account details or order numbers not present in the ticket.
- Do not promise refunds, credits, or policy exceptions in the suggested response.
- needsEscalation MUST be false unless one of these exact conditions is met:
  1. The ticket describes confirmed or suspected data loss.
  2. The ticket describes a security breach, unauthorized access, or credential compromise.
  3. The ticket involves a legal or compliance issue.
  4. The customer tier is "enterprise".
  For all other tickets (billing issues, bugs, feature requests, general questions),
  needsEscalation MUST be false regardless of priority or sentiment.
- Keep the suggested response under 200 words.
`;

function parseBedrockResponse(responseBody: Uint8Array): TriageResult {
  const decoded = JSON.parse(new TextDecoder().decode(responseBody));
  if (!decoded.content?.[0]?.text) {
    throw new Error("Unexpected Bedrock response structure: missing content[0].text");
  }
  const text = decoded.content[0].text.replace(/```json\n?|\n?```/g, "").trim();
  try {
    return JSON.parse(text) as TriageResult;
  } catch {
    throw new Error(`Failed to parse triage result as JSON: ${text.slice(0, 200)}`);
  }
}

async function closeTicket(
  context: DurableContext,
  name: string,
  email: string,
  ticketId: string,
  response: string
): Promise<void> {
  await context.parallel(name, [
    {
      name: "send-reply",
      func: async (ctx) =>
        ctx.step("reply", async () => {
          await sendCustomerReply(email, ticketId, response);
        }),
    },
    {
      name: "send-survey",
      func: async (ctx) =>
        ctx.step("survey", async () => {
          await sendSatisfactionSurvey(email, ticketId);
        }),
    },
  ]);
}

export const handler = withDurableExecution(
  async (event: TicketEvent, context: DurableContext): Promise<TicketResolution> => {
    validateEvent(event);

    context.logger.info("Ticket received", {
      ticketId: event.ticketId,
      customerTier: event.customerTier,
    });

    // Step 1: AI analyzes the ticket using Bedrock
    const analysis = await context.step(
      "analyze-ticket",
      async () => {
        const response = await bedrock.send(
          new InvokeModelCommand({
            modelId: process.env.BEDROCK_MODEL_ID,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
              anthropic_version: "bedrock-2023-05-31",
              max_tokens: 1024,
              system: TRIAGE_SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: `Ticket ID: ${event.ticketId}\nCustomer Tier: ${event.customerTier}\nSubject: ${event.subject}\n\n${event.body}`,
                },
              ],
            }),
          })
        );

        return parseBedrockResponse(response.body as Uint8Array);
      },
      {
        retryStrategy: createRetryStrategy({
          maxAttempts: 3,
          initialDelay: { seconds: 2 },
          maxDelay: { seconds: 30 },
          backoffRate: 2.0,
          jitter: JitterStrategy.FULL,
        }),
      }
    );

    context.logger.info("Ticket analyzed", {
      ticketId: event.ticketId,
      category: analysis.category,
      priority: analysis.priority,
      sentiment: analysis.sentiment,
      needsEscalation: analysis.needsEscalation,
    });

    // Step 2: Support agent reviews AI suggestion and edits the response
    const agentReview = await context.waitForCallback<AgentReview>(
      "agent-review",
      async (callbackId) => {
        await notifyAgent({
          callbackId,
          ticketId: event.ticketId,
          analysis,
          customerTier: event.customerTier,
        });
        context.logger.info("Agent notified for review", {
          ticketId: event.ticketId,
          callbackId,
        });
      },
      { timeout: { hours: 8 }, serdes: defaultSerdes }
    );

    const finalResponse = agentReview.editedResponse || analysis.suggestedResponse;

    context.logger.info("Agent review complete", {
      ticketId: event.ticketId,
      approved: agentReview.approved,
      wasEdited: !!agentReview.editedResponse,
    });

    // If the agent rejected the AI suggestion, return for manual handling
    if (!agentReview.approved) {
      context.logger.info("Agent rejected AI suggestion", { ticketId: event.ticketId });
      return {
        status: "rejected",
        ticketId: event.ticketId,
        category: analysis.category,
        priority: analysis.priority,
        finalResponse: "",
      };
    }

    // Step 3: If escalation needed, wait for specialist
    if (analysis.needsEscalation) {
      context.logger.info("Escalating to specialist", {
        ticketId: event.ticketId,
        reason: analysis.escalationReason,
      });

      const specialistResponse = await context.waitForCallback<SpecialistReview>(
        "specialist-review",
        async (callbackId) => {
          await notifySpecialist({
            callbackId,
            ticketId: event.ticketId,
            analysis,
            agentNotes: agentReview.agentNotes,
          });
        },
        { timeout: { days: 3 }, serdes: defaultSerdes }
      );

      context.logger.info("Specialist review complete", {
        ticketId: event.ticketId,
      });

      const resolvedResponse = specialistResponse.response || finalResponse;

      await closeTicket(context, "close-escalated-ticket", event.contactEmail, event.ticketId, resolvedResponse);

      return {
        status: "escalated",
        ticketId: event.ticketId,
        category: analysis.category,
        priority: analysis.priority,
        finalResponse: resolvedResponse,
      };
    }

    // Step 4: No escalation needed. Send reply and survey in parallel.
    await closeTicket(context, "close-ticket", event.contactEmail, event.ticketId, finalResponse);

    return {
      status: "resolved",
      ticketId: event.ticketId,
      category: analysis.category,
      priority: analysis.priority,
      finalResponse,
    };
  }
);

// In production, these would integrate with your ticketing system, email
// provider, and notification service. Stubbed here for the demo.
// NOTE: notifyAgent and notifySpecialist run inside waitForCallback submitters;
// sendCustomerReply and sendSatisfactionSurvey run inside step() callbacks.
// Neither context has direct access to context.logger, so these use console.log.
// In production, pass the logger or use a structured logging library.

async function notifyAgent(params: {
  callbackId: string;
  ticketId: string;
  analysis: TriageResult;
  customerTier: string;
}): Promise<void> {
  // In production: send to Slack, email, or your ticketing system UI.
  // Include the callbackId so the agent's action can call
  // SendDurableExecutionCallbackSuccess with their review.
  console.log("notifyAgent", { ticketId: params.ticketId, category: params.analysis.category, customerTier: params.customerTier });
}

async function notifySpecialist(params: {
  callbackId: string;
  ticketId: string;
  analysis: TriageResult;
  agentNotes: string;
}): Promise<void> {
  // In production: route to the appropriate specialist queue based on category.
  // Include callbackId for the specialist to respond.
  console.log("notifySpecialist", { ticketId: params.ticketId, reason: params.analysis.escalationReason });
}

async function sendCustomerReply(
  email: string,
  ticketId: string,
  response: string
): Promise<void> {
  // In production: send via SES, SNS, or your support platform.
  console.log("sendCustomerReply", { ticketId, email, responseLength: response.length });
}

async function sendSatisfactionSurvey(
  email: string,
  ticketId: string
): Promise<void> {
  // In production: send a CSAT survey link via email.
  console.log("sendSatisfactionSurvey", { ticketId, email });
}
