export interface TicketEvent {
  ticketId: string;
  customerId: string;
  customerTier: "free" | "pro" | "enterprise";
  subject: string;
  body: string;
  contactEmail: string;
}

export interface TriageResult {
  category: "billing" | "technical" | "account" | "feature-request" | "other";
  priority: "critical" | "high" | "medium" | "low";
  sentiment: "frustrated" | "neutral" | "positive";
  suggestedResponse: string;
  needsEscalation: boolean;
  escalationReason: string | null;
  summary: string;
}

export interface AgentReview {
  approved: boolean;
  editedResponse: string;
  agentNotes: string;
}

export interface SpecialistReview {
  response: string;
  notes: string;
}

export interface TicketResolution {
  status: "resolved" | "escalated" | "rejected";
  ticketId: string;
  category: string;
  priority: string;
  finalResponse: string;
}
