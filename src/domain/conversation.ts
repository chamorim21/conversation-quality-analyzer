import { z } from 'zod';

/** Who authored a message. The domain is intentionally binary: any bot or human
 * support representative is `attendant`; the person being served is `customer`. */
export const MessageRoleSchema = z.enum(['customer', 'attendant']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** Channel the conversation happened on. Optional; `other` is the catch-all. */
export const ChannelSchema = z.enum(['whatsapp', 'other']);
export type Channel = z.infer<typeof ChannelSchema>;

export const MessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string(),
  timestamp: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * Canonical conversation contract (R1). Structural validation only — emptiness
 * and role-coverage rules live in the evaluability check (R2), which returns a
 * readable 422 rather than a schema error.
 */
export const ConversationSchema = z.object({
  sessionId: z.string().optional(),
  channel: ChannelSchema.optional(),
  messages: z.array(MessageSchema),
});
export type Conversation = z.infer<typeof ConversationSchema>;
