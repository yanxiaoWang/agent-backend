import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import {
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
} from '@langchain/core/messages';
import { createAgent, summarizationMiddleware } from 'langchain';
import { UIMessage } from 'ai';
import { toBaseMessages, toUIMessageStream } from '@ai-sdk/langchain';
import { RedisMessageStore } from '../memory/redis-message.store';
import {
  Mem0MemoryStore,
  messagesForRedis,
} from '../memory/mem0-memory.store';

const SUMMARY_PROMPT = `你是对话摘要助手。用中文简洁总结：话题、会话内进度/报错/待办。
用户级长期偏好由外部记忆维护，摘要勿重复堆砌。不要编造。

待摘要的对话：
{messages}

摘要：`;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly agent: ReturnType<typeof createAgent>;

  constructor(
    @Inject('CHAT_MODEL') private readonly model: ChatOpenAI,
    @Inject('WEB_SEARCH_TOOL') private readonly webSearchTool: any,
    private readonly memoryStore: RedisMessageStore,
    private readonly mem0Store: Mem0MemoryStore,
  ) {
    this.agent = createAgent({
      model,
      tools: [this.webSearchTool],
      systemPrompt:
        '你是 AI 助手。结合系统消息中的长期/会话记忆回答；若有对话摘要，请据此继续。需要最新信息时使用 web_search。',
      middleware: [
        summarizationMiddleware({
          model,
          summaryPrompt: SUMMARY_PROMPT,
          trigger: { messages: 8 },
          keep: { messages: 4 },
        }),
      ],
    });
  }

  /**
   * Redis 短期 + Mem0 长期：
   * - invoke 前：Redis 历史 + Mem0 search → SystemMessage 注入
   * - 流结束后：过滤 SystemMessage 写回 Redis；分类后可选写入 Mem0
   */
  async stream(sessionId: string, messages: UIMessage[], userId?: string) {
    const memUserId = userId?.trim() || sessionId;
    const history = await this.memoryStore.loadMessages(sessionId);
    const incoming = await toBaseMessages(messages);
    const lastHuman = this.findLastHuman(incoming);
    const userText = this.messageText(lastHuman);

    let memoryMsg = null as ReturnType<Mem0MemoryStore['buildSystemMessage']>;
    if (this.mem0Store.enabled && userText) {
      try {
        const mem = await this.mem0Store.search(userText, memUserId, sessionId);
        if (mem.user.length) {
          this.logger.debug(`Mem0 user hits=${mem.user.length}`);
        }
        if (mem.session.length) {
          this.logger.debug(`Mem0 session hits=${mem.session.length}`);
        }
        memoryMsg = this.mem0Store.buildSystemMessage(mem);
      } catch (err) {
        this.logger.warn(`Mem0 search failed: ${(err as Error).message}`);
      }
    }

    const inputMessages = [
      ...(memoryMsg ? [memoryMsg] : []),
      ...history,
      ...(lastHuman ? [lastHuman] : incoming),
    ];

    this.logger.debug(
      `session=${sessionId} user=${memUserId} load ${history.length} history → input ${inputMessages.length}`,
    );

    const lgStream = await this.agent.stream(
      { messages: inputMessages },
      {
        streamMode: ['messages', 'values'],
        recursionLimit: 30,
      },
    );

    return toUIMessageStream<{ messages: BaseMessage[] }>(
      lgStream as AsyncIterable<AIMessageChunk>,
      {
        onFinish: async (finalState) => {
          const resultMessages = finalState?.messages;
          if (!resultMessages?.length) return;

          const redisMessages = messagesForRedis(resultMessages);
          await this.memoryStore.saveMessages(sessionId, redisMessages);
          const ttl = await this.memoryStore.ttl(sessionId);
          const dropped = resultMessages.length - redisMessages.length;
          this.logger.debug(
            `session=${sessionId} saved ${redisMessages.length} messages` +
              (dropped ? ` (filtered ${dropped} SystemMessage)` : '') +
              ` (TTL ${ttl}s)`,
          );

          if (!this.mem0Store.enabled || !userText) return;

          const assistantText = String(
            resultMessages.at(-1)?.content ?? '',
          );
          try {
            const { written, reason } = await this.mem0Store.classifyAndPersist(
              userText,
              assistantText,
              memUserId,
              sessionId,
            );
            this.logger.debug(
              `Mem0 classify: ${reason}; written=${written.join(',') || 'none'}`,
            );
          } catch (err) {
            this.logger.warn(
              `Mem0 persist failed: ${(err as Error).message}`,
            );
          }
        },
        onError: (error) => {
          this.logger.error(
            `session=${sessionId} stream error: ${(error as Error).message}`,
          );
        },
      },
    );
  }

  async clearMemory(sessionId: string) {
    await this.memoryStore.clear(sessionId);
  }

  async clearMem0(userId: string, sessionId: string) {
    await this.mem0Store.clear(userId, sessionId);
  }

  async getMemoryMeta(sessionId: string) {
    const messages = await this.memoryStore.loadMessages(sessionId);
    const ttl = await this.memoryStore.ttl(sessionId);
    return {
      sessionId,
      count: messages.length,
      ttl,
      mem0Enabled: this.mem0Store.enabled,
    };
  }

  private findLastHuman(messages: BaseMessage[]): HumanMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (HumanMessage.isInstance(msg)) {
        return msg;
      }
    }
    return undefined;
  }

  private messageText(msg?: BaseMessage): string {
    if (!msg) return '';
    const content = msg.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          typeof part === 'string'
            ? part
            : part && typeof part === 'object' && 'text' in part
              ? String((part as { text?: string }).text ?? '')
              : '',
        )
        .join('')
        .trim();
    }
    return String(content ?? '').trim();
  }
}
