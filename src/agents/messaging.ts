/**
 * Messages between agents: `agent_send` submits a message to another agent
 * of the session. Like the parent's messages, it steers a working recipient,
 * which sees it at its next step, unless the sender queues it as a
 * follow-up for after the current work. The sender doesn't wait, and the
 * recipient's answer stays with the recipient.
 *
 * The submission's request ID is the sending tool call's task, so a rerun
 * of the call after a restart finds the first submission instead of
 * admitting the message again. A log of messages, for the UI, follows the
 * submission under the same ID.
 *
 * Helpers stay private: they can't send, and nobody can message them.
 */

import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  type ConversationId,
  type AgentState as DurableAgentState,
  defineExtension,
  defineTool,
  type Extension,
  LiveDoc,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { type AgentReceipt, receipt } from "./receipts.js";
import {
  type AgentRecord,
  AgentsDoc,
  GraphsDoc,
  type GraphsState,
  MESSAGE_MEMORY,
  MessagesDoc,
} from "./records.js";
import { type ResultLimit, truncateResult } from "./report.js";
import { messageInput } from "./types.js";

export const MESSAGING_EXTENSION = "pi-agents-messaging";
export const SEND_TOOL = "agent_send";
export const STATUS_TOOL = "agent_status";

/** How much of each agent's task `agent_status` shows. */
const TASK_LIMIT: ResultLimit = {
  chars: 4_000,
  lines: 200,
  hint: "The rest of the task is left out.",
};

export interface MessagingOptions {
  /** Whether messaging is on; agents that have the tool get an error
   * while it's off. */
  enabled?: () => boolean;
  /** Tests only: runs after the message is admitted, before it's logged. */
  afterSubmit?: (context: Context) => Promise<void>;
}

/** Details of a send's result, for rendering. */
export interface SendDetails {
  to: string;
}

function textResult(
  text: string,
  isError = false,
  details?: SendDetails,
): ToolExecutionResult {
  return {
    content: [{ type: "text", text }],
    isError,
    ...(details ? { details: { ...details } } : {}),
  };
}

function isHelper(
  record: AgentRecord,
  graphs: Readonly<GraphsState> | undefined,
): boolean {
  return !!record.graph && !!graphs?.graphs[record.graph]?.owner;
}

/** The agent a name addresses: an open one, else the newest. A stopped
 * agent takes messages only from the user and the parent. */
function resolve(
  agents: Readonly<Record<string, AgentRecord>>,
  graphs: Readonly<GraphsState> | undefined,
  name: string,
): [string, AgentRecord] | undefined {
  const named = Object.entries(agents)
    .filter(([, record]) => record.name === name && !isHelper(record, graphs))
    .sort(([, left], [, right]) => left.createdAt - right.createdAt);
  return named.find(([, record]) => !record.closed) ?? named.at(-1);
}

export function createMessagingExtension(
  options: MessagingOptions = {},
): Extension {
  return defineExtension({
    name: MESSAGING_EXTENSION,
    tools: [
      defineTool({
        name: STATUS_TOOL,
        description:
          "List the other agents of this session you can message, with their state and the task each was started with.",
        parameters: Type.Object({}),
        replay: "safe",
        async execute(_args, api, context) {
          const [state, graphs] = await Promise.all([
            api.snapshot(AgentsDoc, context),
            api.snapshot(GraphsDoc, context),
          ]);
          const self = String(api.conversationId);
          const open = Object.entries(state?.agents ?? {}).filter(
            ([id, record]) =>
              id !== self && !record.closed && !isHelper(record, graphs),
          );
          const agents = await Promise.all(
            open.map(async ([id, record]): Promise<AgentReceipt> => {
              const cid = Number(id) as ConversationId;
              const [live, durable] = await Promise.all([
                api.snapshot(LiveDoc, cid, context),
                api.snapshot(AgentDoc, cid, context) as Promise<
                  DurableAgentState | undefined
                >,
              ]);
              const model = durable?.model?.modelId;
              return {
                name: record.name,
                ...(model ? { model } : {}),
                outcome: live?.run !== undefined ? "working" : "answered",
                task: truncateResult(record.task.trim(), TASK_LIMIT),
              };
            }),
          );
          const text =
            agents.length === 0
              ? "No other agents."
              : agents
                  .map(
                    (agent) =>
                      `## ${agent.name} (${agent.outcome === "working" ? "working" : "idle"})\nTask:\n${agent.task}`,
                  )
                  .join("\n\n");
          return {
            content: [{ type: "text", text }],
            details: { receipt: receipt({ agents }) },
          };
        },
      }),
      defineTool({
        name: SEND_TOOL,
        description:
          "Send a message to another agent of this session; agent_status lists them. You don't wait: a working recipient sees it at its next step, or after its current work with followUp, and its answer stays with it. To get an answer, ask the recipient to message you. Messages from other agents reach you as input that starts with [from <name>]; they don't come from the user.",
        parameters: Type.Object({
          to: Type.String({ description: "Agent name" }),
          message: Type.String(),
          followUp: Type.Optional(
            Type.Boolean({
              description:
                "Queue after the recipient's current work instead of steering it, for work that shouldn't change what it does now",
            }),
          ),
        }),
        replay: "safe",
        async execute(args, api, context) {
          if (options.enabled && !options.enabled())
            return textResult("Messaging between agents is off.", true);
          const text = args.message.trim();
          if (!text) return textResult("The message must not be empty.", true);
          const [state, graphs] = await Promise.all([
            api.snapshot(AgentsDoc, context),
            api.snapshot(GraphsDoc, context),
          ]);
          const agents = state?.agents ?? {};
          const from = String(api.conversationId);
          const sender = agents[from];
          if (!sender || isHelper(sender, graphs))
            return textResult(`${SEND_TOOL} is not available to you.`, true);
          const target = resolve(agents, graphs, args.to);
          if (!target) return textResult(`No agent named ${args.to}.`, true);
          const [to, recipient] = target;
          if (to === from)
            return textResult("You can't message yourself.", true);
          if (recipient.stopped)
            return textResult(
              `${recipient.name} was stopped and doesn't take messages from agents.`,
              true,
            );
          const conversation = await api.conversation(
            Number(to) as ConversationId,
            context,
          );
          if (!conversation)
            return textResult(`No agent named ${args.to}.`, true);
          const id = `message:${from}:${api.taskId}`;
          await conversation.submit(
            {
              type: "input",
              content: messageInput(sender.name, text),
              whenBusy: args.followUp ? "followUp" : "steer",
              requestId: id,
            },
            context,
          );
          await options.afterSubmit?.(context);
          await api.commit(async (tx) => {
            const log = await tx.doc(MessagesDoc);
            if (log.messages.some((message) => message.id === id)) return;
            log.messages.push({ id, from, to, text, sentAt: Date.now() });
            const over = log.messages.length - MESSAGE_MEMORY;
            if (over > 0) {
              log.messages.splice(0, over);
              log.dropped = (log.dropped ?? 0) + over;
            }
          }, context);
          return textResult(`Sent to ${recipient.name}.`, false, {
            to: recipient.name,
          });
        },
      }),
    ],
  });
}
