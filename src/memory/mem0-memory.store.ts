import {
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  SystemMessageChunk,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import MemoryClient, { type Memory } from 'mem0ai';

export const MEM0_CLIENT = 'MEM0_CLIENT';

export interface Mem0SearchResult {
  user: Memory[];
  session: Memory[];
}

export interface Mem0PersistResult {
  written: Array<'user' | 'session'>;
  reason: string;
}

const memorySchema = z.object({
  write_user: z
    .boolean()
    .describe(
      '写入用户层：换一个新会话仍应保留的长期事实（身份、居住地、长期爱好、饮食禁忌、持久偏好）。不含仅本轮任务。',
    ),
  write_session: z
    .boolean()
    .describe(
      '写入会话层：仅当前会话/thread 有效的任务、大纲、进度、待办、临时决策（如「这次先写…」「数据部分明天补」）。',
    ),
  reason: z.string().describe('分类理由，一句话'),
});

const CLASSIFIER_PROMPT = `你是记忆分层分类器。判断本轮对话是否有「新事实」需写入 Mem0，并分到正确层级。

## user 层（跨会话长期）
- 用户身份与画像：姓名、职业、居住地、长期爱好
- 长期偏好与约束：饮食过敏、回答风格、常用技术栈
- 持续数周以上的个人背景（非单次任务）

## session 层（仅当前会话）
- 当前正在做的任务、目标、文档大纲、方案草稿
- 本会话内的进度、决策、待办、临时约定
- 用户明确用「这次」「本轮」「当前会话」描述的工作上下文

## 均不写入
- 寒暄、致谢、纯确认
- 助手生成的通用内容（攻略、示例代码、建议清单），用户未明确采纳为新事实
- 无信息增量的复述

## 决策原则
1. 「这次我们先写 Q1 总结」「当前在排查 XX」→ 优先 session，不要标成 user
2. user 与 session 可同时为 true（如同时说职业+当前任务），但勿把纯会话任务只标 user
3. 一次性请求（如「帮我做旅行攻略」）且未产生需跨轮记住的约定 → 均为 false`;

/** Mem0 注入的 SystemMessage 不写回 Redis */
export function messagesForRedis(messages: BaseMessage[]): BaseMessage[] {
  return messages.filter(
    (m) => !SystemMessage.isInstance(m) && !SystemMessageChunk.isInstance(m),
  );
}

@Injectable()
export class Mem0MemoryStore {
  private readonly logger = new Logger(Mem0MemoryStore.name);
  private readonly topK: number;
  private readonly classifier: ReturnType<
    ChatOpenAI['withStructuredOutput']
  > | null;

  constructor(
    @Optional() @Inject(MEM0_CLIENT) private readonly client: MemoryClient | null,
    config: ConfigService,
  ) {
    this.topK = Number(config.get('MEM0_TOP_K') ?? 5);

    if (this.client) {
      const model = new ChatOpenAI({
        model: config.get('MODEL_NAME'),
        apiKey: config.get('OPENAI_API_KEY'),
        configuration: {
          baseURL: config.get('OPENAI_BASE_URL'),
        },
        temperature: 0,
      });
      this.classifier = model.withStructuredOutput(memorySchema);
    } else {
      this.classifier = null;
      this.logger.warn('MEM0_API_KEY 未配置，长期记忆已禁用');
    }
  }

  get enabled(): boolean {
    return !!this.client && !!this.classifier;
  }

  async search(
    query: string,
    userId: string,
    sessionId: string,
  ): Promise<Mem0SearchResult> {
    if (!this.client) return { user: [], session: [] };

    const [userRes, sessionRes] = await Promise.all([
      this.client.search(query, {
        filters: { user_id: userId },
        topK: this.topK,
      }),
      this.client.search(query, {
        filters: {
          AND: [{ user_id: userId }, { run_id: sessionId }],
        },
        topK: this.topK,
      }),
    ]);

    return {
      user: (userRes.results ?? []).filter((m) => !!m.memory),
      session: (sessionRes.results ?? []).filter((m) => !!m.memory),
    };
  }

  buildSystemMessage({ user, session }: Mem0SearchResult): SystemMessage | null {
    const blocks: string[] = [];
    if (user.length) {
      blocks.push(
        `【用户长期记忆】\n${user.map((m) => `- ${m.memory}`).join('\n')}`,
      );
    }
    if (session.length) {
      blocks.push(
        `【当前会话记忆】\n${session.map((m) => `- ${m.memory}`).join('\n')}`,
      );
    }
    if (!blocks.length) return null;
    return new SystemMessage(
      `${blocks.join('\n\n')}\n\n请结合以上记忆回答，勿编造。`,
    );
  }

  async classifyAndPersist(
    userText: string,
    assistantText: string,
    userId: string,
    sessionId: string,
  ): Promise<Mem0PersistResult> {
    if (!this.client || !this.classifier) {
      return { written: [], reason: 'Mem0 未启用' };
    }

    const turn = [
      { role: 'user' as const, content: userText },
      { role: 'assistant' as const, content: assistantText },
    ];

    const { write_user, write_session, reason } = (await this.classifier.invoke([
      new SystemMessage(CLASSIFIER_PROMPT),
      new HumanMessage(`用户：${userText}\n助手：${assistantText}`),
    ])) as z.infer<typeof memorySchema>;

    const written: Array<'user' | 'session'> = [];
    if (write_user) {
      await this.client.add(turn, { userId });
      written.push('user');
    }
    if (write_session) {
      await this.client.add(turn, { userId, runId: sessionId });
      written.push('session');
    }

    this.logger.debug(
      `user=${userId} session=${sessionId} classify=${reason} written=${written.join(',') || 'none'}`,
    );

    return { written, reason };
  }

  async clear(userId: string, sessionId: string) {
    if (!this.client) return;
    await this.client.deleteAll({ userId });
    await this.client.deleteAll({ userId, runId: sessionId });
  }
}
